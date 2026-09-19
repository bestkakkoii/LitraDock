package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

const runSelectionLimit = 1000

func (s *server) savedSelectionLimit() int {
	if s.stagedQuery {
		return captureMembershipLimit
	}
	return runSelectionLimit
}

const runSelectionDetailLimit = 100
const runSelectionMetadataLimit = 4 << 20

const runSelectionSchema = `
CREATE TABLE native_run_selections(
 library_id uuid NOT NULL,run_id text NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 default_selected boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(library_id,run_id),FOREIGN KEY(library_id,run_id) REFERENCES ld_runs);
CREATE TABLE native_run_selection_exceptions(
 library_id uuid NOT NULL,run_id text NOT NULL,search_id text NOT NULL,selected boolean NOT NULL,
 PRIMARY KEY(library_id,run_id,search_id),
 FOREIGN KEY(library_id,run_id) REFERENCES native_run_selections,
 FOREIGN KEY(library_id,run_id,search_id) REFERENCES ld_results);
CREATE TABLE native_run_selection_actions(
 library_id uuid NOT NULL,request_id uuid NOT NULL,run_id text NOT NULL,intent text NOT NULL,receipt text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(library_id,request_id),
 FOREIGN KEY(library_id,run_id) REFERENCES native_run_selections);
INSERT INTO native_schema(version) VALUES(9);`

func migrateRunSelection(ctx context.Context, tx pgx.Tx, rollback bool) error {
	var version int
	if err := tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); err != nil {
		return err
	}
	if !rollback {
		if version == 9 {
			return nil
		}
		if version != 8 {
			return errors.New("durable selection requires schema 8")
		}
		_, err := tx.Exec(ctx, runSelectionSchema)
		return err
	}
	if version != 9 {
		return errors.New("durable selection rollback requires schema 9")
	}
	var used bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_run_selections)
 OR EXISTS(SELECT 1 FROM native_run_selection_actions) OR EXISTS(SELECT 1 FROM native_run_selection_exceptions)`).Scan(&used); err != nil {
		return err
	}
	if used {
		return errors.New("Saved selection exists; retain schema 9 and a compatible reader with selection writes disabled. No choices were deleted")
	}
	_, err := tx.Exec(ctx, `DROP TABLE native_run_selection_actions,native_run_selection_exceptions,native_run_selections;
 DELETE FROM native_schema WHERE version=9`)
	return err
}

type runSelectionView struct {
	RunID           string           `json:"runID"`
	Revision        int              `json:"revision"`
	DefaultSelected bool             `json:"defaultSelected"`
	SavedCount      int              `json:"savedCount"`
	SelectedCount   int              `json:"selectedCount"`
	SelectedIDs     []string         `json:"selectedIDs"`
	SelectedRecords []map[string]any `json:"selectedRecords"`
	RecordsComplete bool             `json:"recordsComplete"`
	RecordsReason   string           `json:"recordsReason"`
	CanEdit         bool             `json:"canEdit"`
	SelectionLimit  int              `json:"selectionLimit"`
	DetailLimit     int              `json:"detailLimit"`
}

type runSelectionAction struct {
	RequestID string   `json:"requestID"`
	Revision  int      `json:"revision"`
	Action    string   `json:"action"`
	IDs       []string `json:"ids,omitempty"`
	Selected  *bool    `json:"selected,omitempty"`
}

type runSelectionReceipt struct {
	RunID     string `json:"runID"`
	RequestID string `json:"requestID"`
	Revision  int    `json:"revision"`
}

func selectionIntent(run string, action runSelectionAction) (string, error) {
	if !runIDPattern.MatchString(run) || !uuidPattern.MatchString(action.RequestID) || action.Revision < 1 {
		return "", &planError{400, "A saved run, request UUID and positive selection revision are required."}
	}
	switch action.Action {
	case "all", "none":
		if action.IDs != nil || action.Selected != nil {
			return "", &planError{400, "All/none selection actions must omit record IDs and the selected value."}
		}
	case "set":
		if len(action.IDs) < 1 || len(action.IDs) > runSelectionDetailLimit || action.Selected == nil {
			return "", &planError{400, "A page selection requires 1–100 distinct saved record IDs and an explicit selected value."}
		}
		action.IDs = slices.Clone(action.IDs)
		slices.Sort(action.IDs)
		for i, id := range action.IDs {
			if !savedIDPattern.MatchString(id) || i > 0 && id == action.IDs[i-1] {
				return "", &planError{400, "Selection record IDs must be valid and distinct."}
			}
		}
	default:
		return "", &planError{400, "Choose all, none, or an explicit record/page selection."}
	}
	// A request UUID identifies one intent; array order does not create a new intent.
	value := struct {
		RunID string `json:"runID"`
		runSelectionAction
	}{run, action}
	value.RequestID = ""
	encoded, err := json.Marshal(value)
	return string(encoded), err
}

// An untouched run has the immutable schema-9 default policy. Reads never create
// action history. Its first explicit action persists the policy and exceptions
// atomically, so a new run needs no HTTP read side effect or background write.
func (s *server) selectionStateFrom(ctx context.Context, tx pgx.Tx, library, run string) (runSelectionView, error) {
	v := runSelectionView{RunID: run, SelectedIDs: []string{}, SelectedRecords: []map[string]any{},
		RecordsComplete: true, CanEdit: s.cfg.SelectionWriteEnabled,
		SelectionLimit: s.savedSelectionLimit(), DetailLimit: runSelectionDetailLimit}
	if !s.runSelection || !runIDPattern.MatchString(run) {
		return v, &planError{404, "Durable selection is unavailable for this saved run."}
	}
	var capacityAvailable bool
	err := tx.QueryRow(ctx, `SELECT COALESCE(s.revision,1),COALESCE(s.default_selected,true),
 (SELECT count(*)<20000 FROM native_run_selection_actions)
 FROM ld_runs r LEFT JOIN native_run_selections s USING(library_id,run_id)
 WHERE r.library_id=$1 AND r.run_id=$2`, library, run).Scan(&v.Revision, &v.DefaultSelected, &capacityAvailable)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, &planError{404, "Saved run not found."}
	}
	if err != nil {
		return v, err
	}
	v.CanEdit = v.CanEdit && capacityAvailable
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM ld_results WHERE library_id=$1 AND run_id=$2", library, run).Scan(&v.SavedCount); err != nil {
		return v, err
	}
	if v.SavedCount > v.SelectionLimit {
		return v, &planError{413, "This saved run exceeds its supported selection limit. No partial selection was returned."}
	}
	// Saved run membership is append-only. Include its size in the public revision
	// so a newly committed page also invalidates an earlier selection/export view.
	// The stored counter advances only for explicit actions, never for reads.
	v.Revision += v.SavedCount
	rows, err := tx.Query(ctx, `SELECT x.search_id FROM ld_results x
 LEFT JOIN native_run_selection_exceptions e USING(library_id,run_id,search_id)
 WHERE x.library_id=$1 AND x.run_id=$2 AND COALESCE(e.selected,$3) ORDER BY x.rank,x.search_id`, library, run, v.DefaultSelected)
	if err != nil {
		return v, err
	}
	v.SelectedIDs, err = pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return v, err
	}
	if v.SelectedIDs == nil {
		v.SelectedIDs = []string{}
	}
	v.SelectedCount = len(v.SelectedIDs)
	if v.SelectedCount > v.SavedCount || v.SelectedCount > v.SelectionLimit {
		return v, errors.New("inconsistent saved selection count")
	}
	return v, nil
}

func (s *server) readRunSelection(ctx context.Context, library, run string) (runSelectionView, error) {
	var v runSelectionView
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return v, err
	}
	defer tx.Rollback(context.Background())
	if err = snapshotAdmission(ctx, tx, library); err != nil {
		return v, err
	}
	v, err = s.selectionStateFrom(ctx, tx, library, run)
	if err != nil {
		return v, err
	}
	if v.SelectedCount > runSelectionDetailLimit {
		v.RecordsComplete = false
		v.RecordsReason = "PDFs and research snapshots support at most 100 selected records. All selected IDs remain saved."
	} else if v.SelectedCount > 0 {
		var metadataBytes int64
		if err = tx.QueryRow(ctx, `SELECT COALESCE(sum(octet_length((metadata::jsonb-'RawXml'-'FullTextMetadataXml')::text)),0)
 FROM ld_records WHERE library_id=$1 AND search_id=ANY($2)`, library, v.SelectedIDs).Scan(&metadataBytes); err != nil {
			return v, err
		}
		if metadataBytes > runSelectionMetadataLimit {
			v.RecordsComplete = false
			v.RecordsReason = "Selected record details exceed the response limit. Select fewer records for PDF or research-snapshot preparation; saved choices remain available."
		} else {
			rows, err := tx.Query(ctx, `SELECT r.search_id,(r.metadata::jsonb-'RawXml'-'FullTextMetadataXml')::text
 FROM ld_records r JOIN ld_results x USING(library_id,search_id)
 WHERE x.library_id=$1 AND x.run_id=$2 AND x.search_id=ANY($3) ORDER BY x.rank,x.search_id`, library, run, v.SelectedIDs)
			if err != nil {
				return v, err
			}
			for rows.Next() {
				var id, raw string
				var article map[string]any
				if err = rows.Scan(&id, &raw); err != nil {
					break
				}
				if json.Unmarshal([]byte(raw), &article) != nil || articleString(article, "SearchId") != id {
					err = errors.New("saved selection metadata identity mismatch")
					break
				}
				links(article)
				v.SelectedRecords = append(v.SelectedRecords, article)
			}
			rows.Close()
			if err != nil {
				return v, err
			}
			if err = rows.Err(); err != nil {
				return v, err
			}
			if len(v.SelectedRecords) != v.SelectedCount {
				return v, errors.New("saved selection metadata membership changed")
			}
			outcomes, err := sourceHistory(ctx, tx, library, v.SelectedIDs, "pdf")
			if err != nil {
				return v, err
			}
			for _, article := range v.SelectedRecords {
				article["SourceOutcome"] = outcomes[articleString(article, "SearchId")]
			}
		}
	}
	return v, tx.Commit(ctx)
}

func (s *server) changeRunSelection(ctx context.Context, library, run string, action runSelectionAction) (runSelectionReceipt, error) {
	var receipt runSelectionReceipt
	intent, err := selectionIntent(run, action)
	if err != nil {
		return receipt, err
	}
	if !s.runSelection {
		return receipt, &planError{409, "Durable selection is unavailable; no choices were changed."}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return receipt, err
	}
	defer tx.Rollback(context.Background())
	if err = capacityLock(ctx, tx); err != nil {
		return receipt, err
	}
	if err = snapshotAdmission(ctx, tx, library); err != nil {
		return receipt, err
	}
	var priorIntent, rawReceipt string
	err = tx.QueryRow(ctx, "SELECT intent,receipt FROM native_run_selection_actions WHERE library_id=$1 AND request_id=$2", library, action.RequestID).Scan(&priorIntent, &rawReceipt)
	if err == nil {
		if priorIntent != intent {
			return receipt, &planError{409, "The selection request UUID already belongs to a different intent."}
		}
		if json.Unmarshal([]byte(rawReceipt), &receipt) != nil || receipt.RunID != run || receipt.RequestID != strings.ToLower(action.RequestID) || receipt.Revision != action.Revision+1 {
			return receipt, errors.New("invalid saved selection receipt")
		}
		return receipt, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return receipt, err
	}
	if !s.cfg.SelectionWriteEnabled {
		return receipt, &planError{409, "Selection writes are disabled. Saved choices and prior request receipts remain available."}
	}
	var lockedRun string
	if err = tx.QueryRow(ctx, "SELECT run_id FROM ld_runs WHERE library_id=$1 AND run_id=$2 FOR UPDATE", library, run).Scan(&lockedRun); errors.Is(err, pgx.ErrNoRows) {
		return receipt, &planError{404, "Saved run not found."}
	} else if err != nil {
		return receipt, err
	}
	v, err := s.selectionStateFrom(ctx, tx, library, run)
	if err != nil {
		return receipt, err
	}
	if action.Revision != v.Revision {
		return receipt, &planError{409, "Selection changed. Reload its current state before choosing again."}
	}
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM native_run_selection_actions").Scan(&count); err != nil {
		return receipt, err
	}
	if count >= 20000 {
		return receipt, &planError{409, "Saved selection action capacity is full. Existing choices and receipts remain available."}
	}
	if action.Action == "set" {
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM ld_results WHERE library_id=$1 AND run_id=$2 AND search_id=ANY($3)", library, run, action.IDs).Scan(&count); err != nil {
			return receipt, err
		}
		if count != len(action.IDs) {
			return receipt, &planError{409, "Selection contains records outside this saved run. No choices were changed."}
		}
	}
	if _, err = tx.Exec(ctx, "INSERT INTO native_run_selections(library_id,run_id) VALUES($1,$2) ON CONFLICT DO NOTHING", library, run); err != nil {
		return receipt, err
	}
	if action.Action == "set" {
		if *action.Selected == v.DefaultSelected {
			_, err = tx.Exec(ctx, "DELETE FROM native_run_selection_exceptions WHERE library_id=$1 AND run_id=$2 AND search_id=ANY($3)", library, run, action.IDs)
		} else {
			_, err = tx.Exec(ctx, `INSERT INTO native_run_selection_exceptions(library_id,run_id,search_id,selected)
 SELECT $1,$2,unnest($3::text[]),$4 ON CONFLICT(library_id,run_id,search_id) DO UPDATE SET selected=EXCLUDED.selected`, library, run, action.IDs, *action.Selected)
		}
	} else {
		v.DefaultSelected = action.Action == "all"
		_, err = tx.Exec(ctx, "DELETE FROM native_run_selection_exceptions WHERE library_id=$1 AND run_id=$2", library, run)
	}
	if err != nil {
		return receipt, err
	}
	receipt = runSelectionReceipt{run, strings.ToLower(action.RequestID), v.Revision + 1}
	if _, err = tx.Exec(ctx, "UPDATE native_run_selections SET revision=revision+1,default_selected=$3,updated_at=now() WHERE library_id=$1 AND run_id=$2", library, run, v.DefaultSelected); err != nil {
		return receipt, err
	}
	raw, err := json.Marshal(receipt)
	if err != nil {
		return receipt, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO native_run_selection_actions(library_id,request_id,run_id,intent,receipt) VALUES($1,$2,$3,$4,$5)", library, action.RequestID, run, intent, string(raw)); err != nil {
		return receipt, err
	}
	return receipt, tx.Commit(ctx)
}

func (s *server) runSelectionRoute(w http.ResponseWriter, r *http.Request, ctx context.Context, library string, parts []string) bool {
	if len(parts) != 6 || parts[3] != "runs" || parts[5] != "selection" {
		return false
	}
	switch r.Method {
	case http.MethodGet:
		v, err := s.readRunSelection(ctx, library, parts[4])
		if err == nil {
			release, allowed := s.snapshotResponseAdmission(w, r, ctx, library)
			if !allowed {
				return true
			}
			defer release()
		}
		runSelectionReply(w, v, err)
	case http.MethodPost:
		var action runSelectionAction
		if !decode(w, r, &action) {
			return true
		}
		v, err := s.changeRunSelection(ctx, library, parts[4], action)
		runSelectionReply(w, v, err)
	default:
		w.Header().Set("Allow", "GET, POST")
		reply(w, http.StatusMethodNotAllowed, nil)
	}
	return true
}

func runSelectionReply(w http.ResponseWriter, value any, err error) {
	if err == nil {
		reply(w, http.StatusOK, value)
		return
	}
	var pe *planError
	if errors.As(err, &pe) {
		reply(w, pe.Status, map[string]string{"error": pe.Message})
		return
	}
	reply(w, http.StatusServiceUnavailable, map[string]string{"error": "Saved selection could not be confirmed. Reload it or retry the same pending request."})
}
