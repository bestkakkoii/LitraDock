package main

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
)

const multirunSchema = `
ALTER TABLE native_plans ALTER COLUMN run_id DROP NOT NULL;
CREATE TABLE native_plan_sources(
 library_id uuid NOT NULL,plan_id text NOT NULL,search_id text NOT NULL,run_id text NOT NULL,
 PRIMARY KEY(library_id,plan_id,search_id,run_id),
 FOREIGN KEY(library_id,plan_id,search_id) REFERENCES native_plan_items ON DELETE CASCADE,
 FOREIGN KEY(library_id,run_id,search_id) REFERENCES ld_results);
INSERT INTO native_schema(version) VALUES(4);
`

func migrateMultirun(ctx context.Context, tx pgx.Tx, rollback bool) error {
	var version int
	if err := tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); err != nil {
		return err
	}
	if !rollback {
		if version == 4 {
			return nil
		}
		if version != 3 {
			return errors.New("Saved-set migration requires native schema 3")
		}
		_, err := tx.Exec(ctx, multirunSchema)
		return err
	}
	if version != 4 {
		return errors.New("Saved-set rollback requires native schema 4")
	}
	var occupied bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM native_plans WHERE run_id IS NULL) OR EXISTS(SELECT 1 FROM native_plan_sources)").Scan(&occupied); err != nil {
		return err
	}
	if occupied {
		return errors.New("Saved-set work exists; retain schema 4 and a compatible binary with new saved-set admission disabled")
	}
	_, err := tx.Exec(ctx, `DROP TABLE native_plan_sources; ALTER TABLE native_plans ALTER COLUMN run_id SET NOT NULL; DELETE FROM native_schema WHERE version=4;`)
	return err
}

type savedSetMember struct {
	SearchID string   `json:"searchID"`
	RunIDs   []string `json:"runIDs"`
}

// Record order is part of the intent; association order is immaterial.
func canonicalSavedSet(members []savedSetMember) ([]savedSetMember, string, error) {
	bad := func() ([]savedSetMember, string, error) {
		return nil, "", &planError{400, "Choose 1–100 unique saved records and at most 1000 unique record/run associations."}
	}
	if len(members) < 1 || len(members) > 100 {
		return bad()
	}
	result := make([]savedSetMember, len(members))
	seen := map[string]bool{}
	pairs := 0
	for i, m := range members {
		if !savedIDPattern.MatchString(m.SearchID) || seen[m.SearchID] || len(m.RunIDs) < 1 || len(m.RunIDs) > 1000 {
			return bad()
		}
		seen[m.SearchID] = true
		pairs += len(m.RunIDs)
		if pairs > 1000 {
			return bad()
		}
		runs := slices.Clone(m.RunIDs)
		slices.Sort(runs)
		for n, r := range runs {
			if !runIDPattern.MatchString(r) || n > 0 && r == runs[n-1] {
				return bad()
			}
		}
		result[i] = savedSetMember{m.SearchID, runs}
	}
	raw, err := json.Marshal(result)
	return result, "saved_set:" + string(raw), err
}

func (s *server) queueSavedSet(ctx context.Context, library, requestID, format string, members []savedSetMember) (planReceipt, error) {
	var receipt planReceipt
	if !uuidPattern.MatchString(requestID) || (format != "xml" && format != "pdf") {
		return receipt, &planError{400, "A saved set requires a request UUID and explicit XML or PDF format."}
	}
	selected, selection, err := canonicalSavedSet(members)
	if err != nil {
		return receipt, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return receipt, err
	}
	defer tx.Rollback(context.Background())
	if err = capacityLock(ctx, tx); err != nil {
		return receipt, err
	}
	var previous, previousFormat string
	var raw []byte
	err = tx.QueryRow(ctx, "SELECT selection,receipt,requested_format FROM native_plans WHERE library_id=$1 AND request_id=$2", library, requestID).Scan(&previous, &raw, &previousFormat)
	if err == nil {
		if previous != selection || previousFormat != format {
			return receipt, planConflict("Request ID already has another selection.")
		}
		err = json.Unmarshal(raw, &receipt)
		return receipt, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return receipt, err
	}
	if !s.cfg.SavedSetEnabled || !s.cfg.PlanEnabled {
		return receipt, planConflict("New saved-set plans are disabled; existing saved work remains available.")
	}
	if format == "pdf" && (!s.cfg.PDFEnabled || !s.cfg.AcquisitionEnabled) {
		return receipt, planConflict("PDF acquisition is disabled by the operator.")
	}
	var version int
	if err = tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); err != nil {
		return receipt, err
	}
	if version != 4 && version != 5 && version != 6 && version != 8 && version != 9 && version != 10 {
		return receipt, planConflict("Saved-set plans require the supported operator migration; existing single-run plans remain available.")
	}
	ids, runs := []string{}, []string{}
	for _, m := range selected {
		for _, r := range m.RunIDs {
			ids = append(ids, m.SearchID)
			runs = append(runs, r)
		}
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM unnest($2::text[],$3::text[]) AS x(search_id,run_id)
 JOIN ld_results r ON r.library_id=$1 AND r.search_id=x.search_id AND r.run_id=x.run_id`, library, ids, runs).Scan(&count); err != nil {
		return receipt, err
	}
	if count != len(ids) {
		return receipt, &planError{404, "A selected saved record/run association is unavailable in this library."}
	}
	if err = acquisitionCapacity(ctx, tx, len(selected)); err != nil {
		return receipt, err
	}
	receipt = planReceipt{PlanID: newID("PLN-"), Revision: 1, State: "active", SelectedCount: len(selected)}
	raw, err = json.Marshal(receipt)
	if err != nil {
		return receipt, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO native_plans(library_id,plan_id,run_id,request_id,selection,receipt,requested_format) VALUES($1,$2,NULL,$3,$4,$5,$6)`, library, receipt.PlanID, requestID, selection, raw, format); err != nil {
		return receipt, err
	}
	for rank, m := range selected {
		if _, err = tx.Exec(ctx, "INSERT INTO native_plan_items(library_id,plan_id,search_id,rank) VALUES($1,$2,$3,$4)", library, receipt.PlanID, m.SearchID, rank+1); err != nil {
			return receipt, err
		}
		for _, run := range m.RunIDs {
			if _, err = tx.Exec(ctx, "INSERT INTO native_plan_sources VALUES($1,$2,$3,$4)", library, receipt.PlanID, m.SearchID, run); err != nil {
				return receipt, err
			}
		}
	}
	return receipt, tx.Commit(ctx)
}

func loadSavedSetSources(ctx context.Context, tx pgx.Tx, library string, p *planSummary, items []planItem) error {
	p.ScopeKind = "saved_set"
	p.SourceRunIDs = []string{}
	byID := map[string]int{}
	seen := map[string]bool{}
	for n := range items {
		byID[items[n].SearchID] = n
		items[n].RunIDs = []string{}
	}
	rows, err := tx.Query(ctx, "SELECT search_id,run_id FROM native_plan_sources WHERE library_id=$1 AND plan_id=$2 ORDER BY run_id,search_id LIMIT 1001", library, p.PlanID)
	if err != nil {
		return err
	}
	defer rows.Close()
	pairs := 0
	for rows.Next() {
		var id, run string
		if err = rows.Scan(&id, &run); err != nil {
			return err
		}
		n, ok := byID[id]
		if !ok || !runIDPattern.MatchString(run) {
			return exportInvalid("Invalid saved-set association")
		}
		pairs++
		if pairs > 1000 {
			return exportInvalid("Saved-set association bound exceeded")
		}
		items[n].RunIDs = append(items[n].RunIDs, run)
		if !seen[run] {
			seen[run] = true
			p.SourceRunIDs = append(p.SourceRunIDs, run)
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for _, item := range items {
		if len(item.RunIDs) == 0 {
			return exportInvalid("Missing saved-set provenance")
		}
	}
	return nil
}
