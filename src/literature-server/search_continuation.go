package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const searchWindowLimit = 1000

// Provider-specific failures must not strand a frozen page outside the public
// lifecycle vocabulary. Preserve its reason and require an explicit bounded retry.
func continuationFailureState(state string) string {
	switch state {
	case "rate_wait", "unavailable", "expired", "failed":
		return state
	case "unsupported":
		return "unavailable"
	default:
		return "failed"
	}
}

const continuationSchema = `
CREATE TABLE native_search_windows(
 library_id uuid NOT NULL,run_id text NOT NULL,request_id uuid NOT NULL,
 ids text NOT NULL DEFAULT '[]',frozen boolean NOT NULL DEFAULT false,started boolean NOT NULL DEFAULT false,
 next_offset integer NOT NULL DEFAULT 0 CHECK(next_offset BETWEEN 0 AND 1000),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),state text NOT NULL DEFAULT 'queued',
 missing text NOT NULL DEFAULT '[]',snapshot_at timestamptz,
 PRIMARY KEY(library_id,run_id),UNIQUE(library_id,request_id),
 FOREIGN KEY(library_id,run_id) REFERENCES ld_runs);
CREATE TABLE native_search_actions(
 library_id uuid NOT NULL,request_id uuid NOT NULL,run_id text NOT NULL,intent text NOT NULL,receipt text NOT NULL,
 PRIMARY KEY(library_id,request_id),FOREIGN KEY(library_id,run_id) REFERENCES native_search_windows);
CREATE TABLE native_search_pages(
 library_id uuid NOT NULL,run_id text NOT NULL,start_offset integer NOT NULL,
 requested_ids text NOT NULL,missing_ids text NOT NULL,retrieved_at timestamptz NOT NULL,
 PRIMARY KEY(library_id,run_id,start_offset),FOREIGN KEY(library_id,run_id) REFERENCES native_search_windows);
INSERT INTO native_schema(version) VALUES(5);`

func migrateContinuation(ctx context.Context, tx pgx.Tx, rollback bool) error {
	var version int
	if e := tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); e != nil {
		return e
	}
	if !rollback {
		if version == 5 {
			return nil
		}
		if version != 4 {
			return errors.New("search continuation requires schema 4")
		}
		_, e := tx.Exec(ctx, continuationSchema)
		return e
	}
	if version != 5 {
		return errors.New("search rollback requires schema 5")
	}
	var used bool
	if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM native_search_windows)").Scan(&used); e != nil {
		return e
	}
	if used {
		return errors.New("saved continuation exists; retain schema 5 with compatible admission disabled")
	}
	_, e := tx.Exec(ctx, "DROP TABLE native_search_pages,native_search_actions,native_search_windows; DELETE FROM native_schema WHERE version=5")
	return e
}

type continuationView struct {
	Execution        string     `json:"execution,omitempty"`
	CredentialMode   string     `json:"credentialMode,omitempty"`
	CanStart         bool       `json:"canStart,omitempty"`
	CanRecover       bool       `json:"canRecover,omitempty"`
	AttemptID        string     `json:"attemptID,omitempty"`
	AttemptExpiresAt *time.Time `json:"attemptExpiresAt,omitempty"`
	RunID            string     `json:"runID"`
	Revision         int        `json:"revision"`
	State            string     `json:"state"`
	WindowLimit      int        `json:"windowLimit"`
	WindowCount      int        `json:"windowCount"`
	Processed        int        `json:"processedCount"`
	Saved            int        `json:"savedCount"`
	Missing          int        `json:"missingCount"`
	MissingPMIDs     []string   `json:"missingPMIDs"`
	Provider         int        `json:"providerTotal"`
	PageSize         int        `json:"pageSize"`
	Attempts         int        `json:"attempts"`
	CanContinue      bool       `json:"canContinue"`
	CanRetry         bool       `json:"canRetry"`
	CanCancel        bool       `json:"canCancel"`
	Reason           string     `json:"reason"`
	SnapshotAt       *time.Time `json:"snapshotAt"`
}
type continuationReceipt struct {
	RunID    string `json:"runID"`
	Revision int    `json:"revision"`
	State    string `json:"state"`
}
type continuationAction struct {
	RequestID      string `json:"requestID"`
	Revision       int    `json:"revision"`
	Action         string `json:"action"`
	CredentialMode string `json:"credentialMode,omitempty"`
}

func (s *server) queueContinuedSearch(ctx context.Context, library, query string, limit int, request string) (string, error) {
	if request == "" {
		request = newUUID()
	}
	if !uuidPattern.MatchString(request) {
		return "", &planError{400, "A valid search request UUID is required."}
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(context.Background())
	if e = capacityLock(ctx, tx); e != nil {
		return "", e
	}
	var prior, input string
	var priorLimit int
	e = tx.QueryRow(ctx, `SELECT w.run_id,r.input,r.requested_limit FROM native_search_windows w JOIN ld_runs r USING(library_id,run_id) WHERE w.library_id=$1 AND w.request_id=$2`, library, request).Scan(&prior, &input, &priorLimit)
	if e == nil {
		if input != query || priorLimit != limit {
			return "", &planError{409, "The search request UUID already has a different query or page size."}
		}
		return prior, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return "", e
	}
	if !s.cfg.SearchEnabled || !s.cfg.SearchContinuationEnabled {
		return "", &planError{409, "New continuation admission is disabled; prior request receipts remain recoverable."}
	}
	var runs, jobs, active int
	if e = tx.QueryRow(ctx, "SELECT (SELECT count(*) FROM ld_runs),(SELECT count(*) FROM ld_jobs),(SELECT count(*) FROM ld_jobs WHERE state IN ('queued','running','scheduled'))").Scan(&runs, &jobs, &active); e != nil {
		return "", e
	}
	if runs >= 200 || jobs >= 1000 || active >= 20 {
		return "", &planError{409, "Shared search capacity is full; saved work remains available."}
	}
	run := newID("RUN-")
	if _, e = tx.Exec(ctx, "INSERT INTO ld_runs(library_id,run_id,input,requested_limit,state) VALUES($1,$2,$3,$4,'queued')", library, run, query, limit); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO ld_jobs(library_id,job_id,kind,run_id,state) VALUES($1,$2,'search',$3,'queued')", library, newID("JOB-"), run); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO native_search_windows(library_id,run_id,request_id) VALUES($1,$2,$3)", library, run, request); e != nil {
		return "", e
	}
	return run, tx.Commit(ctx)
}

func (s *server) continuationStatus(ctx context.Context, library, run string) (*continuationView, error) {
	return s.continuationStatusFrom(ctx, s.db, library, run)
}

type continuationReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (s *server) continuationStatusFrom(ctx context.Context, reader continuationReader, library, run string) (*continuationView, error) {
	if !s.continuation {
		return nil, nil
	}
	v := &continuationView{RunID: run, WindowLimit: searchWindowLimit}
	var ids, missing string
	var frozen bool
	e := reader.QueryRow(ctx, `SELECT w.revision,w.state,w.ids,w.next_offset,w.missing,w.attempts,w.snapshot_at,w.frozen,r.total,r.fetched,r.requested_limit,r.reason FROM native_search_windows w JOIN ld_runs r USING(library_id,run_id) WHERE w.library_id=$1 AND w.run_id=$2`, library, run).Scan(&v.Revision, &v.State, &ids, &v.Processed, &missing, &v.Attempts, &v.SnapshotAt, &frozen, &v.Provider, &v.Saved, &v.PageSize, &v.Reason)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var ii, mm []string
	if json.Unmarshal([]byte(ids), &ii) != nil || json.Unmarshal([]byte(missing), &mm) != nil {
		return nil, errors.New("invalid window")
	}
	v.WindowCount, v.Missing = len(ii), len(mm)
	v.MissingPMIDs = mm
	enabled := s.cfg.SearchEnabled && s.cfg.SearchContinuationEnabled
	v.CanContinue = enabled && frozen && v.Processed < len(ii) && (v.State == "ready" || v.State == "cancelled") && v.Attempts < 3
	v.CanRetry = enabled && frozen && v.Processed < len(ii) && (v.State == "failed" || v.State == "rate_wait" || v.State == "unavailable") && v.Attempts < 3
	v.CanCancel = v.State == "queued" || v.State == "running"
	if s.userRoute {
		var mode, attempt string
		var until *time.Time
		var expired bool
		err := reader.QueryRow(ctx, `SELECT u.credential_mode,COALESCE(j.lease_token::text,''),j.lease_until,COALESCE(j.lease_until<=clock_timestamp(),false) FROM native_user_route_runs u JOIN ld_jobs j USING(library_id,run_id) WHERE u.library_id=$1 AND u.run_id=$2`, library, run).Scan(&mode, &attempt, &until, &expired)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if err == nil {
			v.Execution, v.CredentialMode, v.AttemptID, v.AttemptExpiresAt = userRouteExecution, mode, attempt, until
			v.CanStart = enabled && s.cfg.UserRouteEnabled && v.State == "queued"
			v.CanRecover = v.State == "running" && expired
			if !s.cfg.UserRouteEnabled {
				v.CanContinue = false
				v.CanRetry = false
			}
		}
	}
	return v, nil
}

func (s *server) controlContinuation(ctx context.Context, library, run string, a continuationAction) (continuationReceipt, error) {
	out := continuationReceipt{}
	if !runIDPattern.MatchString(run) || !uuidPattern.MatchString(a.RequestID) || a.Revision < 1 || (a.Action != "continue" && a.Action != "retry" && a.Action != "cancel") {
		return out, &planError{400, "A run, request UUID, revision and supported action are required."}
	}
	intent := fmt.Sprintf("%s:%d:%s", run, a.Revision, a.Action)
	if a.CredentialMode != "" {
		if !validCredentialMode(a.CredentialMode) {
			return out, &planError{400, "Invalid credential mode."}
		}
		intent += ":" + a.CredentialMode
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(context.Background())
	if e = capacityLock(ctx, tx); e != nil {
		return out, e
	}
	if s.userRoute {
		if e = retireExpiredUserRouteWork(ctx, tx); e != nil {
			return out, e
		}
	}
	var old, receipt string
	e = tx.QueryRow(ctx, "SELECT intent,receipt FROM native_search_actions WHERE library_id=$1 AND request_id=$2", library, a.RequestID).Scan(&old, &receipt)
	if e == nil {
		if old != intent {
			return out, &planError{409, "Request UUID already has a different action."}
		}
		if json.Unmarshal([]byte(receipt), &out) != nil {
			return out, errors.New("invalid receipt")
		}
		return out, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	var commands int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM native_search_actions").Scan(&commands); e != nil {
		return out, e
	}
	if commands >= 20000 {
		return out, &planError{409, "Saved search action capacity is full; contact the operator. Existing receipts remain recoverable."}
	}
	var job, state, raw string
	var revision, attempts, offset int
	var frozen bool
	e = tx.QueryRow(ctx, "SELECT job_id FROM ld_jobs WHERE library_id=$1 AND run_id=$2 FOR UPDATE", library, run).Scan(&job)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, &planError{404, "Saved run not found."}
	}
	if e != nil {
		return out, e
	}
	e = tx.QueryRow(ctx, "SELECT state,revision,attempts,next_offset,ids,frozen FROM native_search_windows WHERE library_id=$1 AND run_id=$2 FOR UPDATE", library, run).Scan(&state, &revision, &attempts, &offset, &raw, &frozen)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, &planError{404, "This saved run has no continuation window; submit a separate new search."}
	}
	if e != nil {
		return out, e
	}
	if revision != a.Revision {
		return out, &planError{409, "Run changed; reopen its current state before acting."}
	}
	var ids []string
	if json.Unmarshal([]byte(raw), &ids) != nil {
		return out, errors.New("invalid saved window")
	}
	next := "queued"
	if a.Action == "cancel" {
		if state != "queued" && state != "running" {
			return out, &planError{409, "No queued or running page to cancel."}
		}
		next = "cancelled"
	} else {
		allowed := a.Action == "continue" && (state == "ready" || state == "cancelled") || a.Action == "retry" && (state == "failed" || state == "rate_wait" || state == "unavailable")
		if !s.cfg.SearchEnabled || !s.cfg.SearchContinuationEnabled || !allowed || !frozen || offset >= len(ids) || attempts >= 3 {
			return out, &planError{409, "Continuation is unavailable, exhausted or at its three-attempt ceiling; saved records remain available."}
		}
		var active int
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM ld_jobs WHERE state IN ('queued','running','scheduled')").Scan(&active); e != nil {
			return out, e
		}
		if active >= 20 {
			return out, &planError{409, "Shared search capacity is full; retry admission later."}
		}
		if s.userRoute {
			var existingMode string
			err := tx.QueryRow(ctx, "SELECT credential_mode FROM native_user_route_runs WHERE library_id=$1 AND run_id=$2", library, run).Scan(&existingMode)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return out, err
			}
			if err == nil && !s.cfg.UserRouteEnabled {
				return out, &planError{409, "Browser source admission is disabled; no server fallback is available."}
			}
			if s.cfg.UserRouteEnabled {
				if err == nil && a.CredentialMode != "" && a.CredentialMode != existingMode {
					return out, &planError{409, "This run retains its original credential mode; no automatic identity change is allowed."}
				}
				if errors.Is(err, pgx.ErrNoRows) {
					mode := a.CredentialMode
					if mode == "" {
						mode = "unkeyed"
					}
					if _, e = tx.Exec(ctx, "INSERT INTO native_user_route_runs VALUES($1,$2,$3)", library, run, mode); e != nil {
						return out, e
					}
				}
				if _, e = tx.Exec(ctx, "UPDATE ld_jobs SET kind='browser_search' WHERE library_id=$1 AND job_id=$2", library, job); e != nil {
					return out, e
				}
			}
		}
	}
	if s.userRoute && a.Action == "cancel" {
		if _, e = tx.Exec(ctx, "UPDATE native_user_route_attempts SET state='interrupted' WHERE library_id=$1 AND run_id=$2 AND state='running'", library, run); e != nil {
			return out, e
		}
	}
	out = continuationReceipt{run, revision + 1, next}
	if _, e = tx.Exec(ctx, "UPDATE ld_jobs SET state=$3,reason='',lease_token=NULL,lease_until=CASE WHEN kind='browser_search' AND $3='queued' THEN clock_timestamp()+interval '120 seconds' END WHERE library_id=$1 AND job_id=$2", library, job, next); e != nil {
		return out, e
	}
	if _, e = tx.Exec(ctx, "UPDATE native_search_windows SET state=$3,revision=$4 WHERE library_id=$1 AND run_id=$2", library, run, next, out.Revision); e != nil {
		return out, e
	}
	if _, e = tx.Exec(ctx, "UPDATE ld_runs SET state=$3,reason=$4 WHERE library_id=$1 AND run_id=$2", library, run, next, "Saved records retained; only the requested page action was admitted."); e != nil {
		return out, e
	}
	encoded, _ := json.Marshal(out)
	if _, e = tx.Exec(ctx, "INSERT INTO native_search_actions VALUES($1,$2,$3,$4,$5)", library, a.RequestID, run, intent, string(encoded)); e != nil {
		return out, e
	}
	return out, tx.Commit(ctx)
}

func (s *server) continuationRoute(w http.ResponseWriter, r *http.Request, ctx context.Context, library string, parts []string) bool {
	if len(parts) != 6 || parts[3] != "runs" || parts[5] != "continuation" || r.Method != "POST" {
		return false
	}
	if !s.continuation {
		reply(w, 409, map[string]string{"error": "Search continuation requires the supported schema."})
		return true
	}
	var a continuationAction
	if !decode(w, r, &a) {
		return true
	}
	v, e := s.controlContinuation(ctx, library, parts[4], a)
	planReply(w, v, e)
	return true
}

// Persist membership before fetching a page. A crashed initial ESearch is never
// repeated under the same run: its unknown membership must remain unknown.
func (s *server) continuedSearch(ctx context.Context, c claim) (bool, searchResult, error) {
	result := searchResult{Window: true}
	if !s.continuation {
		return false, result, nil
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return true, result, e
	}
	defer tx.Rollback(context.Background())
	var job string
	if e = tx.QueryRow(ctx, "SELECT job_id FROM ld_jobs WHERE library_id=$1 AND job_id=$2 AND lease_token=$3 AND state='running' AND lease_until>now() FOR UPDATE", c.Library, c.Job, c.Lease).Scan(&job); e != nil {
		return true, result, e
	}
	var idsRaw, missing string
	var frozen, started bool
	var attempts int
	e = tx.QueryRow(ctx, "SELECT ids,frozen,started,next_offset,attempts,missing FROM native_search_windows WHERE library_id=$1 AND run_id=$2 FOR UPDATE", c.Library, c.Run).Scan(&idsRaw, &frozen, &started, &result.Offset, &attempts, &missing)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, result, nil
	}
	if e != nil {
		return true, result, e
	}
	if !frozen && started {
		return true, result, &sourceError{"expired", "Initial query was interrupted before its membership was saved. Submit a new run; this query will not be silently repeated."}
	}
	if attempts >= 3 {
		return true, result, &sourceError{"failed", "This metadata page reached its three-attempt ceiling. Saved records remain available."}
	}
	if _, e = tx.Exec(ctx, "UPDATE native_search_windows SET started=true,state='running',attempts=attempts+1,revision=revision+1 WHERE library_id=$1 AND run_id=$2", c.Library, c.Run); e != nil {
		return true, result, e
	}
	if _, e = tx.Exec(ctx, "UPDATE ld_runs SET state='running',reason='' WHERE library_id=$1 AND run_id=$2", c.Library, c.Run); e != nil {
		return true, result, e
	}
	if e = tx.Commit(ctx); e != nil {
		return true, result, e
	}
	if !s.cfg.SearchEnabled {
		return true, result, &sourceError{"unavailable", "Provider access is disabled; no source result fabricated."}
	}
	if !frozen {
		initial, e := s.searchIDs(ctx, c.Query, searchWindowLimit)
		if e != nil {
			return true, result, e
		}
		if len(initial.IDs) != min(initial.Total, searchWindowLimit) {
			return true, result, &sourceError{"failed", "PubMed returned an incomplete identity window; no continuation membership was assumed."}
		}
		if !validWindowIDs(initial.IDs) {
			return true, result, &sourceError{"failed", "Invalid bounded PubMed membership; no identity window saved."}
		}
		if e = s.freezeSearchWindow(ctx, c, initial); e != nil {
			return true, result, e
		}
		encoded, _ := json.Marshal(initial.IDs)
		idsRaw = string(encoded)
	}
	var ids []string
	if json.Unmarshal([]byte(idsRaw), &ids) != nil || result.Offset < 0 || result.Offset > len(ids) || !validWindowIDs(ids) {
		return true, result, &sourceError{"expired", "Saved membership is invalid; no query was repeated."}
	}
	result.IDs = slices.Clone(ids[result.Offset:min(result.Offset+c.Limit, len(ids))])
	result.Started = time.Now().UTC().Format(time.RFC3339Nano)
	result.Articles, e = s.fetchSearchIDs(ctx, result.IDs)
	return true, result, e
}

func validWindowIDs(ids []string) bool {
	if len(ids) > searchWindowLimit {
		return false
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if len(id) > 20 || !numeric.MatchString(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func (s *server) freezeSearchWindow(ctx context.Context, c claim, r searchResult) error {
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(context.Background())
	var job string
	if e = tx.QueryRow(ctx, "SELECT job_id FROM ld_jobs WHERE library_id=$1 AND job_id=$2 AND lease_token=$3 AND state='running' AND lease_until>now() FOR UPDATE", c.Library, c.Job, c.Lease).Scan(&job); e != nil {
		return e
	}
	ids, _ := json.Marshal(r.IDs)
	tag, e := tx.Exec(ctx, "UPDATE native_search_windows SET ids=$3,frozen=true,snapshot_at=$4 WHERE library_id=$1 AND run_id=$2 AND NOT frozen AND state='running'", c.Library, c.Run, string(ids), r.Started)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return errors.New("window lease changed")
	}
	snapshot, _ := json.Marshal(map[string]any{"SubmittedQuery": r.Query, "Translation": r.Translation, "StartedAt": r.Started, "SourceIds": r.IDs, "MembershipKind": "local_uid_window_v1", "WindowLimit": searchWindowLimit})
	if _, e = tx.Exec(ctx, "UPDATE ld_runs SET total=$3,snapshot=$4 WHERE library_id=$1 AND run_id=$2", c.Library, c.Run, r.Total, string(snapshot)); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func (s *server) finishSearchPage(ctx context.Context, tx pgx.Tx, c claim, r searchResult) error {
	var raw, priorMissing string
	var offset, total int
	if e := tx.QueryRow(ctx, "SELECT ids,next_offset,missing FROM native_search_windows WHERE library_id=$1 AND run_id=$2 FOR UPDATE", c.Library, c.Run).Scan(&raw, &offset, &priorMissing); e != nil {
		return e
	}
	var ids, missing []string
	if json.Unmarshal([]byte(raw), &ids) != nil || json.Unmarshal([]byte(priorMissing), &missing) != nil || offset != r.Offset || offset+len(r.IDs) > len(ids) || !slices.Equal(r.IDs, ids[offset:offset+len(r.IDs)]) {
		return errors.New("page membership changed")
	}
	present := map[string]bool{}
	for _, a := range r.Articles {
		present[a["Pmid"].(string)] = true
	}
	pageMissing := []string{}
	for _, id := range r.IDs {
		if !present[id] {
			pageMissing = append(pageMissing, id)
		}
	}
	missing = append(missing, pageMissing...)
	var saved int
	var size int64
	if e := tx.QueryRow(ctx, "SELECT count(*),COALESCE(sum(octet_length(r.metadata)),0) FROM ld_results x JOIN ld_records r USING(library_id,search_id) WHERE x.library_id=$1 AND x.run_id=$2", c.Library, c.Run).Scan(&saved, &size); e != nil {
		return e
	}
	if size > 32*1024*1024 {
		return &sourceError{"failed", "The saved run would exceed its 32 MiB metadata budget; this entire page was not saved. Refine a separate query."}
	}
	if e := tx.QueryRow(ctx, "SELECT total FROM ld_runs WHERE library_id=$1 AND run_id=$2", c.Library, c.Run).Scan(&total); e != nil {
		return e
	}
	next := offset + len(r.IDs)
	state := "ready"
	if next == len(ids) {
		state = "exhausted"
		if total > len(ids) {
			state = "window_limited"
		}
	}
	reason := fmt.Sprintf("Saved %d unique records; processed %d of %d frozen PMIDs; %d metadata records unavailable; provider reported %d matches.", saved, next, len(ids), len(missing), total)
	mm, _ := json.Marshal(missing)
	pm, _ := json.Marshal(pageMissing)
	ii, _ := json.Marshal(r.IDs)
	if _, e := tx.Exec(ctx, "INSERT INTO native_search_pages VALUES($1,$2,$3,$4,$5,$6)", c.Library, c.Run, offset, string(ii), string(pm), r.Started); e != nil {
		return e
	}
	if _, e := tx.Exec(ctx, "UPDATE native_search_windows SET next_offset=$3,missing=$4,state=$5,attempts=0,revision=revision+1 WHERE library_id=$1 AND run_id=$2", c.Library, c.Run, next, string(mm), state); e != nil {
		return e
	}
	runState := "partial"
	if saved == total {
		runState = "complete"
	}
	_, e := tx.Exec(ctx, "UPDATE ld_runs SET fetched=$3,state=$4,reason=$5 WHERE library_id=$1 AND run_id=$2", c.Library, c.Run, saved, runState, reason)
	return e
}

func (s *server) searchIDs(ctx context.Context, query string, limit int) (searchResult, error) {
	r := searchResult{Started: time.Now().UTC().Format(time.RFC3339Nano), IDs: []string{}, Articles: []map[string]any{}}
	query = normalizedPubMedQuery(query)
	r.Query = query
	b, e := s.request(ctx, "esearch.fcgi", url.Values{"term": {query}, "retmax": {fmt.Sprint(limit)}, "sort": {"relevance"}})
	if e != nil {
		return r, e
	}
	r.Total, r.IDs, r.Translation, e = parseSearchMetadata(b, limit)
	return r, e
}
func (s *server) fetchSearchIDs(ctx context.Context, ids []string) ([]map[string]any, error) {
	if len(ids) == 0 {
		return []map[string]any{}, nil
	}
	b, e := s.request(ctx, "efetch.fcgi", url.Values{"id": {strings.Join(ids, ",")}})
	if e != nil {
		return nil, e
	}
	records, e := parsePubMed(b)
	if e != nil {
		return nil, e
	}
	byID := map[string]map[string]any{}
	for _, a := range records {
		id := a["Pmid"].(string)
		if !slices.Contains(ids, id) || byID[id] != nil {
			return nil, &sourceError{"failed", "PubMed metadata did not match requested identities."}
		}
		byID[id] = a
	}
	out := []map[string]any{}
	for _, id := range ids {
		if a := byID[id]; a != nil {
			out = append(out, a)
		}
	}
	return out, nil
}

// List counts, projected records and progress belong to one database snapshot.
// Raw source XML remains durable but is not repeated in ordinary result pages.
func (s *server) savedRunPage(ctx context.Context, library, run string, offset, limit int) (any, error) {
	tx, e := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	rows, e := tx.Query(ctx, "SELECT run_id,input,total,fetched,state,reason FROM ld_runs WHERE library_id=$1 AND run_id=$2", library, run)
	if e != nil {
		return nil, e
	}
	runs, e := pgx.CollectRows(rows, pgx.RowToMap)
	if e != nil {
		return nil, e
	}
	if len(runs) != 1 {
		return nil, &planError{404, "Saved run not found."}
	}
	var total int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM ld_results WHERE library_id=$1 AND run_id=$2", library, run).Scan(&total); e != nil {
		return nil, e
	}
	rows, e = tx.Query(ctx, "SELECT (r.metadata::jsonb - 'RawXml' - 'FullTextMetadataXml')::text FROM ld_records r JOIN ld_results x USING(library_id,search_id) WHERE x.library_id=$1 AND x.run_id=$2 ORDER BY x.rank,x.search_id LIMIT $4 OFFSET $3", library, run, offset, limit)
	if e != nil {
		return nil, e
	}
	articles := []any{}
	size := 0
	for rows.Next() {
		var raw string
		if e = rows.Scan(&raw); e != nil {
			rows.Close()
			return nil, e
		}
		size += len(raw)
		if size > 8*1024*1024 {
			rows.Close()
			return nil, &planError{413, "Saved page exceeds 8 MiB; request a smaller page. No records were truncated."}
		}
		var a any
		if e = json.Unmarshal([]byte(raw), &a); e != nil {
			rows.Close()
			return nil, e
		}
		articles = append(articles, a)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	if s.native {
		ids := make([]string, 0, len(articles))
		for _, value := range articles {
			ids = append(ids, articleString(value.(map[string]any), "SearchId"))
		}
		outcomes, err := sourceHistory(ctx, tx, library, ids, "pdf")
		if err != nil {
			return nil, err
		}
		for _, value := range articles {
			a := value.(map[string]any)
			links(a)
			a["SourceOutcome"] = outcomes[articleString(a, "SearchId")]
		}
	}
	continuation, e := s.continuationStatusFrom(ctx, tx, library, run)
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return map[string]any{"records": articles, "run": runs[0], "total": total, "offset": offset, "limit": limit, "continuation": continuation}, nil
}
