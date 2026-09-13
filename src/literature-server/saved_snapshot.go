package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Schema 7 belongs to the separate, unreleased importer. Do not accept it here.
const savedSnapshotSchema = `
ALTER TABLE native_plans DROP CONSTRAINT native_plans_state_check;
ALTER TABLE native_plans ADD CONSTRAINT native_plans_state_check CHECK(state IN ('active','paused','cancelled','saved_snapshot'));
CREATE TABLE native_research_snapshots(
 library_id uuid NOT NULL,plan_id text NOT NULL,document text NOT NULL,
 PRIMARY KEY(library_id,plan_id), FOREIGN KEY(library_id,plan_id) REFERENCES native_plans,
 CHECK(octet_length(document) BETWEEN 1 AND 8388608));
INSERT INTO native_schema(version) VALUES(8);`

func migrateSavedSnapshots(ctx context.Context, tx pgx.Tx, rollback bool) error {
	var v int
	if e := tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&v); e != nil {
		return e
	}
	if !rollback {
		if v == 8 {
			return nil
		}
		if v != 6 {
			return errors.New("Saved snapshot migration requires schema 6; importer schema 7 is unsupported")
		}
		_, e := tx.Exec(ctx, savedSnapshotSchema)
		return e
	}
	if v != 8 {
		return errors.New("Saved snapshot rollback requires schema 8")
	}
	var used bool
	if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM native_plans WHERE state='saved_snapshot') OR EXISTS(SELECT 1 FROM native_research_snapshots)").Scan(&used); e != nil {
		return e
	}
	if used {
		return errors.New("Saved snapshots exist; retain schema 8 and a compatible binary, without deleting research")
	}
	_, e := tx.Exec(ctx, `DROP TABLE native_research_snapshots; ALTER TABLE native_plans DROP CONSTRAINT native_plans_state_check;
 ALTER TABLE native_plans ADD CONSTRAINT native_plans_state_check CHECK(state IN ('active','paused','cancelled')); DELETE FROM native_schema WHERE version=8;`)
	return e
}

type savedSnapshotObservation struct {
	Item     planItem `json:"item"`
	Metadata string   `json:"metadata"`
}
type savedSnapshotDocument struct {
	Research     structuredDocument         `json:"research"`
	Observations []savedSnapshotObservation `json:"observations"`
}

type snapshotSessionKey struct{}

// HTTP supplies this identity after authentication. Lock the account/session in
// the committing transaction so logout cannot pass a pending snapshot commit.
// Internal operator/tests without an HTTP identity have their own trusted scope.
func snapshotAdmission(ctx context.Context, tx pgx.Tx, library string) error {
	sess, ok := ctx.Value(snapshotSessionKey{}).(*session)
	if !ok {
		return nil
	}
	var account string
	e := tx.QueryRow(ctx, `SELECT a.account_id::text FROM ld_accounts a JOIN ld_sessions s USING(account_id)
 JOIN ld_libraries l ON l.owner_id=a.account_id WHERE s.token_hash=$1 AND s.csrf=$2 AND s.expires_at>now()
 AND a.enabled AND l.library_id=$3 AND l.ready FOR SHARE OF a,s,l`, sess.Hash, sess.CSRF, library).Scan(&account)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && account != sess.Account {
		return &planError{401, "Session or library admission changed; sign in again before saving research."}
	}
	return e
}

func (s *server) saveResearchSnapshot(ctx context.Context, library, request, format string, members []savedSetMember) (planReceipt, error) {
	var result planReceipt
	if !uuidPattern.MatchString(request) || format != "pdf" {
		return result, &planError{400, "Choose an explicit request UUID and PDF saved snapshot."}
	}
	selected, selection, e := canonicalSavedSet(members)
	if e != nil {
		return result, e
	}
	selection = "snapshot:" + selection
	return s.saveResearchSnapshotOnce(ctx, library, request, format, selection, selected)
}

func (s *server) saveResearchSnapshotOnce(ctx context.Context, library, request, format, selection string, selected []savedSetMember) (planReceipt, error) {
	var receipt planReceipt
	// Serialize before establishing the repeatable-read view. A transaction-level
	// lock acquired after BEGIN can leave a waiter with a stale idempotency/quota view.
	conn, e := s.db.Acquire(ctx)
	if e != nil {
		return receipt, e
	}
	defer conn.Release()
	if _, e = conn.Exec(ctx, "SELECT pg_advisory_lock(724913015)"); e != nil {
		return receipt, e
	}
	defer func() {
		clean, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, e := conn.Exec(clean, "SELECT pg_advisory_unlock(724913015)"); e != nil {
			_ = conn.Conn().Close(clean)
		}
	}()
	tx, e := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return receipt, e
	}
	defer tx.Rollback(context.Background())
	if e = snapshotAdmission(ctx, tx, library); e != nil {
		return receipt, e
	}
	var previous, oldFormat string
	var raw []byte
	e = tx.QueryRow(ctx, "SELECT selection,requested_format,receipt FROM native_plans WHERE library_id=$1 AND request_id=$2", library, request).Scan(&previous, &oldFormat, &raw)
	if e == nil {
		if previous != selection || oldFormat != format {
			return receipt, planConflict("Request ID already has another saved selection or purpose.")
		}
		e = json.Unmarshal(raw, &receipt)
		return receipt, e
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return receipt, e
	}
	if !s.savedSnapshots || !s.cfg.SavedSetEnabled {
		return receipt, planConflict("New research snapshots are disabled; existing saved work remains available.")
	}
	var count int
	var stored int64
	if e = tx.QueryRow(ctx, "SELECT count(*),COALESCE(sum(octet_length(document)),0) FROM native_research_snapshots").Scan(&count, &stored); e != nil {
		return receipt, e
	}
	if count >= 1000 || stored >= 64<<20 {
		return receipt, planConflict("Saved snapshot capacity reached; no partial research was saved.")
	}
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM native_research_snapshots WHERE library_id=$1", library).Scan(&count); e != nil {
		return receipt, e
	}
	if count >= 100 {
		return receipt, planConflict("This library already has 100 saved snapshots.")
	}
	ids, runs := []string{}, []string{}
	for _, m := range selected {
		for _, r := range m.RunIDs {
			ids = append(ids, m.SearchID)
			runs = append(runs, r)
		}
	}
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM unnest($2::text[],$3::text[]) x(search_id,run_id)
 JOIN ld_results r ON r.library_id=$1 AND r.search_id=x.search_id AND r.run_id=x.run_id`, library, ids, runs).Scan(&count); e != nil {
		return receipt, e
	}
	if count != len(ids) {
		return receipt, &planError{404, "A selected saved record/run association is unavailable in this library."}
	}
	receipt = planReceipt{PlanID: newID("PLN-"), Revision: 1, State: "saved_snapshot", SelectedCount: len(selected)}
	raw, e = json.Marshal(receipt)
	if e != nil {
		return receipt, e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO native_plans(library_id,plan_id,run_id,request_id,selection,receipt,requested_format,state)
 VALUES($1,$2,NULL,$3,$4,$5,$6,'saved_snapshot')`, library, receipt.PlanID, request, selection, raw, format); e != nil {
		return receipt, e
	}
	for rank, m := range selected {
		if _, e = tx.Exec(ctx, "INSERT INTO native_plan_items(library_id,plan_id,search_id,rank) VALUES($1,$2,$3,$4)", library, receipt.PlanID, m.SearchID, rank+1); e != nil {
			return receipt, e
		}
		for _, r := range m.RunIDs {
			if _, e = tx.Exec(ctx, "INSERT INTO native_plan_sources VALUES($1,$2,$3,$4)", library, receipt.PlanID, m.SearchID, r); e != nil {
				return receipt, e
			}
		}
	}
	// Read through the existing typed constructor before the frozen document is inserted.
	d, e := s.liveStructuredResearchSnapshot(ctx, tx, library, "", "", receipt.PlanID, true)
	if e != nil {
		return receipt, e
	}
	d.Scope.Kind = "saved_snapshot"
	frozen := savedSnapshotDocument{Research: d, Observations: []savedSnapshotObservation{}}
	for rank, m := range selected {
		i := planItem{SearchID: m.SearchID, Rank: rank + 1, RunIDs: m.RunIDs, Phase: "held", Reason: "No original was acquired for this saved snapshot. Open source links; acquisition is a separate action."}
		if e = tx.QueryRow(ctx, "SELECT metadata FROM ld_records WHERE library_id=$1 AND search_id=$2", library, m.SearchID).Scan(&i.raw); e != nil {
			return receipt, e
		}
		eligible := []structuredOriginal{}
		for _, o := range d.Records[rank].Originals {
			if strings.EqualFold(o.Format, format) {
				eligible = append(eligible, o)
			}
		}
		if len(eligible) == 1 {
			i.OriginalHash = eligible[0].SHA256
			i.AcquisitionState = optionalText("acquired")
			i.Phase = "completed"
			i.Reason = "Original already stored when this snapshot was saved; current rights and integrity are checked before download."
		} else if len(eligible) > 1 {
			i.Reason = "Multiple original versions are stored; this snapshot does not choose a version automatically. Open source links or the existing original records."
		} else {
			var state, reason string
			e = tx.QueryRow(ctx, `SELECT i.state,i.reason FROM native_items i JOIN native_batches b USING(library_id,batch_id)
    WHERE i.library_id=$1 AND i.search_id=$2 AND b.requested_format=$3 ORDER BY b.created_at DESC,b.batch_id DESC LIMIT 1`, library, m.SearchID, format).Scan(&state, &reason)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return receipt, e
			}
			if e == nil {
				i.AcquisitionState = optionalText(state)
				i.Reason = "Saved observation: " + reason + " No acquisition or retry was requested."
				if state == "failed" {
					i.Phase = "retry"
				}
			}
		}
		frozen.Research.Records[rank].Acquisition = structuredAcquisition{i.AcquisitionState, optionalText(i.Reason), optionalText(format)}
		frozen.Observations = append(frozen.Observations, savedSnapshotObservation{i, i.raw})
	}
	raw, e = json.Marshal(frozen)
	if e != nil {
		return receipt, e
	}
	if len(raw) > structuredBytes || int64(len(raw))+stored > 64<<20 {
		return receipt, planConflict("Saved snapshot metadata capacity exceeded; nothing was saved.")
	}
	if _, e = tx.Exec(ctx, "INSERT INTO native_research_snapshots VALUES($1,$2,$3)", library, receipt.PlanID, string(raw)); e != nil {
		return receipt, e
	}
	return receipt, tx.Commit(ctx)
}

func loadResearchSnapshot(ctx context.Context, tx pgx.Tx, library, plan string) (savedSnapshotDocument, error) {
	var d savedSnapshotDocument
	var raw string
	e := tx.QueryRow(ctx, "SELECT document FROM native_research_snapshots WHERE library_id=$1 AND plan_id=$2", library, plan).Scan(&raw)
	if e != nil {
		return d, e
	}
	if len(raw) > structuredBytes {
		return d, exportInvalid("Saved snapshot byte bound")
	}
	if e = json.Unmarshal([]byte(raw), &d); e != nil {
		return d, exportInvalid("Invalid saved snapshot document")
	}
	if len(d.Observations) < 1 || len(d.Observations) > 100 || len(d.Research.Records) != len(d.Observations) || d.Research.Scope.PlanID == nil || *d.Research.Scope.PlanID != plan {
		return d, exportInvalid("Incomplete saved snapshot document")
	}
	for n, o := range d.Observations {
		if o.Item.Rank != n+1 || o.Item.SearchID != d.Research.Records[n].SearchID || o.Item.ChildBatchID != nil {
			return d, exportInvalid("Invalid saved snapshot membership")
		}
	}
	return d, nil
}

func (s *server) structuredResearchSnapshot(ctx context.Context, tx pgx.Tx, library, run, batch, plan string, frozenPlan ...bool) (structuredDocument, error) {
	if s.savedSnapshots && plan != "" {
		var state string
		if e := tx.QueryRow(ctx, "SELECT state FROM native_plans WHERE library_id=$1 AND plan_id=$2", library, plan).Scan(&state); e != nil {
			return structuredDocument{}, e
		}
		if state == "saved_snapshot" {
			d, e := loadResearchSnapshot(ctx, tx, library, plan)
			return d.Research, e
		}
	}
	return s.liveStructuredResearchSnapshot(ctx, tx, library, run, batch, plan, frozenPlan...)
}
