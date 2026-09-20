package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const userRouteBodyLimit = 8 * 1024 * 1024
const userRouteVerification = "client_submitted_parsed"
const userRouteExecution = "user_browser"

// Browser ownership is durable. An old worker's kind='search' selector must not
// accidentally claim this work, including after a compatible rollback.
const userRouteSchema = `
ALTER TABLE ld_jobs DROP CONSTRAINT ld_jobs_kind_check;
ALTER TABLE ld_jobs ADD CONSTRAINT ld_jobs_kind_check CHECK(kind IN ('search','browser_search'));
CREATE TABLE native_user_route_runs(
 library_id uuid NOT NULL,run_id text NOT NULL,credential_mode text NOT NULL CHECK(credential_mode IN ('unkeyed','personal_key')),
 PRIMARY KEY(library_id,run_id),FOREIGN KEY(library_id,run_id) REFERENCES native_search_windows);
CREATE TABLE native_user_route_attempts(
 library_id uuid NOT NULL,request_id uuid NOT NULL,run_id text NOT NULL,session_hash text NOT NULL,
 revision integer NOT NULL,stage text NOT NULL CHECK(stage IN ('esearch','efetch')),start_offset integer NOT NULL,
 descriptor text NOT NULL,state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','completed','failed','interrupted')),
 admitted_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '120 seconds',
 body bytea,body_sha256 text NOT NULL DEFAULT '',outcome text NOT NULL DEFAULT '',receipt text NOT NULL DEFAULT '',
 PRIMARY KEY(library_id,request_id),FOREIGN KEY(library_id,run_id) REFERENCES native_user_route_runs,
 CHECK(body IS NULL OR octet_length(body)<=8388608));
CREATE INDEX user_route_run_attempts ON native_user_route_attempts(library_id,run_id,admitted_at);
CREATE TABLE native_user_route_budget(
 session_hash text PRIMARY KEY REFERENCES ld_sessions(token_hash) ON DELETE CASCADE,
 next_at timestamptz NOT NULL DEFAULT now(),cooldown_until timestamptz NOT NULL DEFAULT now());
INSERT INTO native_schema(version) VALUES(10);`

func migrateUserRoute(ctx context.Context, tx pgx.Tx, rollback bool) error {
	var version int
	if e := tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); e != nil {
		return e
	}
	if !rollback {
		if version == 10 {
			return nil
		}
		if version != 9 {
			return errors.New("browser-origin requests require schema 9")
		}
		_, e := tx.Exec(ctx, userRouteSchema)
		return e
	}
	if version != 10 {
		return errors.New("browser-origin rollback requires schema 10")
	}
	var used bool
	if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM native_user_route_runs) OR EXISTS(SELECT 1 FROM ld_jobs WHERE kind='browser_search')").Scan(&used); e != nil {
		return e
	}
	if used {
		return errors.New("browser-origin research exists; retain schema 10 with browser admission disabled")
	}
	_, e := tx.Exec(ctx, `DROP TABLE native_user_route_budget,native_user_route_attempts,native_user_route_runs;
ALTER TABLE ld_jobs DROP CONSTRAINT ld_jobs_kind_check;
ALTER TABLE ld_jobs ADD CONSTRAINT ld_jobs_kind_check CHECK(kind='search'); DELETE FROM native_schema WHERE version=10`)
	return e
}

func validCredentialMode(mode string) bool { return mode == "unkeyed" || mode == "personal_key" }

func (s *server) queueUserSearch(ctx context.Context, library, query string, limit int, requestID, mode string) (string, error) {
	if !s.userRoute || !uuidPattern.MatchString(requestID) || !validCredentialMode(mode) || strings.TrimSpace(query) == "" || !utf8.ValidString(query) || len([]rune(query)) > 2000 || limit < 1 || limit > 100 {
		return "", &planError{400, "Browser search needs a request UUID, credential mode, query up to 2000 characters and page size 1–100."}
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(context.Background())
	if e = capacityLock(ctx, tx); e != nil {
		return "", e
	}
	if e = retireExpiredUserRouteWork(ctx, tx, s.stagedQuery); e != nil {
		return "", e
	}
	var prior, input, previousMode string
	var previousLimit int
	e = tx.QueryRow(ctx, `SELECT w.run_id,r.input,r.requested_limit,u.credential_mode FROM native_search_windows w JOIN ld_runs r USING(library_id,run_id) JOIN native_user_route_runs u USING(library_id,run_id) WHERE w.library_id=$1 AND w.request_id=$2`, library, requestID).Scan(&prior, &input, &previousLimit, &previousMode)
	if e == nil {
		if input != query || previousLimit != limit || previousMode != mode {
			return "", &planError{409, "Search request UUID already has different input."}
		}
		return prior, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return "", e
	}
	if !s.cfg.UserRouteEnabled || !s.cfg.SearchEnabled || !s.cfg.SearchContinuationEnabled {
		return "", &planError{409, "Browser searches are disabled; saved work and prior receipts remain available."}
	}
	var runs, jobs, active int
	if e = tx.QueryRow(ctx, "SELECT (SELECT count(*) FROM ld_runs),(SELECT count(*) FROM ld_jobs),(SELECT count(*) FROM ld_jobs WHERE state IN ('queued','running','scheduled'))").Scan(&runs, &jobs, &active); e != nil {
		return "", e
	}
	if runs >= 200 || jobs >= 1000 || active >= 20 {
		return "", &planError{409, "Shared storage admission is full; no provider request was started."}
	}
	run := newID("RUN-")
	if _, e = tx.Exec(ctx, "INSERT INTO ld_runs(library_id,run_id,input,requested_limit,state) VALUES($1,$2,$3,$4,'queued')", library, run, query, limit); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO ld_jobs(library_id,job_id,kind,run_id,state,lease_until) VALUES($1,$2,'browser_search',$3,'queued',clock_timestamp()+interval '120 seconds')", library, newID("JOB-"), run); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO native_search_windows(library_id,run_id,request_id) VALUES($1,$2,$3)", library, run, requestID); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO native_user_route_runs VALUES($1,$2,$3)", library, run, mode); e != nil {
		return "", e
	}
	return run, tx.Commit(ctx)
}

type userRouteDescriptor struct {
	CaptureSegment int               `json:"captureSegment,omitempty"`
	RunID          string            `json:"runID"`
	AttemptID      string            `json:"attemptID"`
	Revision       int               `json:"revision"`
	Stage          string            `json:"stage"`
	Parameters     map[string]string `json:"parameters"`
	CredentialMode string            `json:"credentialMode"`
	MaxBytes       int               `json:"maxBytes"`
	ExpiresAt      time.Time         `json:"expiresAt"`
	Fresh          bool              `json:"fresh"`
	State          string            `json:"state"`
}

type userRouteClaim struct {
	RequestID string `json:"requestID"`
	Revision  int    `json:"revision"`
}

type userRouteUpload struct {
	AttemptID string `json:"attemptID"`
	Body      []byte `json:"body"`
	Failure   string `json:"failure"`
}

// Replays are read-only and never convey permission to reissue provider traffic.
func readUserRouteAttempt(ctx context.Context, tx pgx.Tx, library, run, requestID string, sess *session) (userRouteDescriptor, bool, error) {
	d := userRouteDescriptor{}
	var raw, owner, state string
	e := tx.QueryRow(ctx, "SELECT descriptor,session_hash,state FROM native_user_route_attempts WHERE library_id=$1 AND request_id=$2 AND run_id=$3", library, requestID, run).Scan(&raw, &owner, &state)
	if errors.Is(e, pgx.ErrNoRows) {
		return d, false, nil
	}
	if e != nil {
		return d, false, e
	}
	if owner != sess.Hash {
		return d, false, &planError{409, "This attempt belongs to another signed-in session; refresh the saved run."}
	}
	if json.Unmarshal([]byte(raw), &d) != nil {
		return d, false, errors.New("invalid browser descriptor")
	}
	d.Fresh, d.State = false, state
	return d, true, nil
}

func (s *server) claimUserRoute(ctx context.Context, library, run string, a userRouteClaim, sess *session) (userRouteDescriptor, error) {
	d := userRouteDescriptor{}
	if !s.userRoute || sess == nil || !runIDPattern.MatchString(run) || !uuidPattern.MatchString(a.RequestID) || a.Revision < 1 {
		return d, &planError{400, "A saved run, request UUID and revision are required."}
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return d, e
	}
	defer tx.Rollback(context.Background())
	// This lock protects storage reservations only. Source pacing and refusal are
	// scoped to this session, including separate sessions on the shared demo account.
	if e = capacityLock(ctx, tx); e != nil {
		return d, e
	}
	if e = retireExpiredUserRouteWork(ctx, tx, s.stagedQuery); e != nil {
		return d, e
	}
	if prior, exists, err := readUserRouteAttempt(ctx, tx, library, run, a.RequestID, sess); err != nil || exists {
		if err != nil {
			return d, err
		}
		if prior.Revision != a.Revision+1 {
			return d, &planError{409, "Attempt UUID already has a different revision."}
		}
		return prior, tx.Commit(ctx)
	}
	if !s.cfg.UserRouteEnabled || !s.cfg.SearchEnabled || !s.cfg.SearchContinuationEnabled {
		return d, &planError{409, "Browser source admission is disabled; saved work remains available."}
	}
	var job, state, query, rawIDs, mode string
	var revision, offset, size, attempts int
	var frozen, started bool
	e = tx.QueryRow(ctx, `SELECT j.job_id,j.state,r.input,r.requested_limit,w.revision,w.next_offset,w.ids,w.frozen,w.started,w.attempts,u.credential_mode
FROM ld_jobs j JOIN ld_runs r USING(library_id,run_id) JOIN native_search_windows w USING(library_id,run_id) JOIN native_user_route_runs u USING(library_id,run_id)
WHERE j.library_id=$1 AND j.run_id=$2 AND j.kind='browser_search' FOR UPDATE OF j,w`, library, run).Scan(&job, &state, &query, &size, &revision, &offset, &rawIDs, &frozen, &started, &attempts, &mode)
	if errors.Is(e, pgx.ErrNoRows) {
		return d, &planError{404, "Browser-owned saved run not found."}
	}
	if e != nil {
		return d, e
	}
	if state != "queued" || revision != a.Revision || attempts >= 3 || !frozen && started {
		return d, &planError{409, "Saved source state changed or is interrupted; reconcile it before requesting another attempt."}
	}
	var capture *queryCapturePlan
	if s.stagedQuery {
		capture, e = readCapturePlan(ctx, tx, library, run)
		if e != nil {
			return d, e
		}
	}
	captureActive := capture != nil && capture.Active
	if captureActive && (!s.cfg.StagedQueryEnabled || capture.State != "ready" || len(capture.Frontier) == 0 || capture.Requests >= captureRequestLimit) {
		return d, &planError{409, "Staged capture admission is disabled or exhausted; no provider request was started."}
	}
	var ids []string
	if json.Unmarshal([]byte(rawIDs), &ids) != nil || !validWindowIDs(ids) || offset < 0 || offset > len(ids) || size < 1 || size > 100 {
		return d, errors.New("invalid browser window")
	}
	if frozen && offset >= len(ids) && !captureActive {
		return d, &planError{409, "The saved identity window is exhausted."}
	}
	var count int
	var reserved int64
	if e = tx.QueryRow(ctx, "SELECT count(*),COALESCE(sum(CASE WHEN state='running' THEN $1 ELSE COALESCE(octet_length(body),0) END),0) FROM native_user_route_attempts", userRouteBodyLimit).Scan(&count, &reserved); e != nil {
		return d, e
	}
	if count >= 20000 || reserved+userRouteBodyLimit > 128*1024*1024 {
		return d, &planError{409, "Browser response storage is full; no provider request was started."}
	}
	if _, e = tx.Exec(ctx, "INSERT INTO native_user_route_budget(session_hash) VALUES($1) ON CONFLICT DO NOTHING", sess.Hash); e != nil {
		return d, e
	}
	var ready, databaseNow time.Time
	if e = tx.QueryRow(ctx, "SELECT greatest(next_at,cooldown_until),clock_timestamp() FROM native_user_route_budget WHERE session_hash=$1 FOR UPDATE", sess.Hash).Scan(&ready, &databaseNow); e != nil {
		return d, e
	}
	// 資料庫時間是耐久排程的共同時鐘；不可拿另一台主機的時鐘誤判首次請求。
	if databaseNow.Before(ready) {
		return d, &planError{429, "This session is waiting for its source cooldown; no provider request was started."}
	}
	d = userRouteDescriptor{RunID: run, AttemptID: a.RequestID, Revision: revision + 1, Stage: "esearch", Parameters: map[string]string{"db": "pubmed", "retmode": "xml", "term": normalizedPubMedQuery(query), "retmax": fmt.Sprint(searchWindowLimit), "retstart": "0", "sort": "relevance", "tool": "LitraDock"}, CredentialMode: mode, MaxBytes: userRouteBodyLimit, ExpiresAt: databaseNow.UTC().Add(120 * time.Second), State: "running"}
	if captureActive {
		query, err := segmentQuery(normalizedPubMedQuery(query), capture.Frontier[0])
		if err != nil {
			return d, err
		}
		d.CaptureSegment = capture.Frontier[0].ID
		d.Parameters["term"], d.Parameters["retmax"] = query, fmt.Sprint(captureProviderBoundary)
		capture.Requests++
		if e = saveCapturePlan(ctx, tx, library, run, capture); e != nil {
			return d, e
		}
	} else if frozen {
		d.Stage = "efetch"
		d.Parameters = map[string]string{"db": "pubmed", "retmode": "xml", "id": strings.Join(ids[offset:min(offset+size, len(ids))], ","), "tool": "LitraDock"}
	}
	if s.cfg.PubMedDeveloperEmail != "" {
		d.Parameters["email"] = s.cfg.PubMedDeveloperEmail
	}
	raw, e := json.Marshal(d)
	if e != nil {
		return d, e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO native_user_route_attempts(library_id,request_id,run_id,session_hash,revision,stage,start_offset,descriptor,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", library, a.RequestID, run, sess.Hash, d.Revision, d.Stage, offset, string(raw), d.ExpiresAt); e != nil {
		return d, e
	}
	if _, e = tx.Exec(ctx, "UPDATE ld_jobs SET state='running',lease_token=$3,lease_until=$4 WHERE library_id=$1 AND job_id=$2", library, job, a.RequestID, d.ExpiresAt); e != nil {
		return d, e
	}
	if _, e = tx.Exec(ctx, "UPDATE native_search_windows SET started=true,state='running',revision=$3,attempts=attempts+1 WHERE library_id=$1 AND run_id=$2", library, run, d.Revision); e != nil {
		return d, e
	}
	if _, e = tx.Exec(ctx, "UPDATE ld_runs SET state='running',reason='Waiting for this browser to submit the source response.' WHERE library_id=$1 AND run_id=$2", library, run); e != nil {
		return d, e
	}
	if _, e = tx.Exec(ctx, "UPDATE native_user_route_budget SET next_at=clock_timestamp()+interval '1200 milliseconds' WHERE session_hash=$1", sess.Hash); e != nil {
		return d, e
	}
	if e = tx.Commit(ctx); e != nil {
		return d, e
	}
	d.Fresh = true
	return d, nil
}

func userRouteFailure(code string) (string, string, time.Duration, bool) {
	switch code {
	case "rate_limited":
		return "rate_wait", "NCBI limited this browser request. Other users may share your institution network or key. Saved research remains available.", time.Minute, true
	case "request_rejected":
		return "unavailable", "NCBI rejected this request or personal key. Check your query and NCBI key; no alternate credential or server route was used.", time.Minute, true
	case "network_unavailable":
		return "failed", "This browser could not read NCBI. Network, CORS, device or provider failure cannot be distinguished here; this does not establish a provider-wide outage.", 30 * time.Second, true
	case "provider_unavailable":
		return "unavailable", "NCBI returned a temporary failure to this browser. Saved work remains available; no server fallback was used.", time.Minute, true
	case "invalid_response":
		return "failed", "The browser response exceeded bounds or was not supported PubMed XML. No records were fabricated.", 30 * time.Second, true
	case "cancelled":
		return "cancelled", "Browser request cancelled; saved work retained and late responses refused.", 0, true
	case "interrupted":
		return "failed", "Browser request was interrupted. Reconcile saved status before explicitly retrying the current stage.", 30 * time.Second, true
	default:
		return "", "", 0, false
	}
}

func (s *server) submitUserRoute(ctx context.Context, library, run string, a userRouteUpload, sess *session) (continuationReceipt, error) {
	out := continuationReceipt{}
	if !s.userRoute || sess == nil || !uuidPattern.MatchString(a.AttemptID) || !runIDPattern.MatchString(run) || len(a.Body) > userRouteBodyLimit || (len(a.Body) > 0) == (a.Failure != "") {
		return out, &planError{400, "Submit one bounded response or a supported failure code."}
	}
	state, reason, cooldown, validFailure := userRouteFailure(a.Failure)
	if a.Failure != "" && !validFailure {
		return out, &planError{400, "Unsupported browser failure code."}
	}
	hash := sha256.Sum256(a.Body)
	bodyHash := hex.EncodeToString(hash[:])
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(context.Background())
	// Match continuation's job-first order; an upload cannot revive a cancelled job.
	var job, jobState, lease string
	var leaseActive bool
	e = tx.QueryRow(ctx, "SELECT job_id,state,COALESCE(lease_token::text,''),COALESCE(lease_until>clock_timestamp(),false) FROM ld_jobs WHERE library_id=$1 AND run_id=$2 AND kind='browser_search' FOR UPDATE", library, run).Scan(&job, &jobState, &lease, &leaseActive)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, &planError{404, "Browser-owned run not found."}
	}
	if e != nil {
		return out, e
	}
	var descriptor, owner, attemptState, priorHash, priorFailure, receipt string
	var offset int
	e = tx.QueryRow(ctx, "SELECT descriptor,session_hash,state,body_sha256,outcome,receipt,start_offset FROM native_user_route_attempts WHERE library_id=$1 AND request_id=$2 AND run_id=$3 FOR UPDATE", library, a.AttemptID, run).Scan(&descriptor, &owner, &attemptState, &priorHash, &priorFailure, &receipt, &offset)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, &planError{404, "Browser attempt not found."}
	}
	if e != nil {
		return out, e
	}
	if owner != sess.Hash {
		return out, &planError{409, "This attempt belongs to another signed-in session."}
	}
	if receipt != "" {
		if priorHash != bodyHash || priorFailure != a.Failure {
			return out, &planError{409, "Attempt already has a different response; no data changed."}
		}
		if json.Unmarshal([]byte(receipt), &out) != nil {
			return out, errors.New("invalid source receipt")
		}
		return out, tx.Commit(ctx)
	}
	if attemptState != "running" || jobState != "running" || lease != a.AttemptID || !leaseActive {
		return out, &planError{409, "Browser attempt expired or was cancelled; reconcile saved status before any new request."}
	}
	d := userRouteDescriptor{}
	if json.Unmarshal([]byte(descriptor), &d) != nil {
		return out, errors.New("invalid source descriptor")
	}
	var revision int
	var frozen bool
	if e = tx.QueryRow(ctx, "SELECT revision,frozen FROM native_search_windows WHERE library_id=$1 AND run_id=$2 FOR UPDATE", library, run).Scan(&revision, &frozen); e != nil {
		return out, e
	}
	if revision != d.Revision {
		return out, &planError{409, "The saved search changed; late response refused."}
	}
	c := claim{Library: library, Job: job, Run: run, Lease: a.AttemptID}
	if a.Failure != "" {
		if d.Stage == "esearch" && d.CaptureSegment == 0 {
			reason += " Initial membership was not saved; submit a separate new search."
			if state != "cancelled" {
				state = "expired"
			}
		}
		out = continuationReceipt{run, revision + 1, state}
		if _, e = tx.Exec(ctx, "UPDATE native_search_windows SET state=$3,revision=$4 WHERE library_id=$1 AND run_id=$2", library, run, state, out.Revision); e != nil {
			return out, e
		}
		if _, e = tx.Exec(ctx, "UPDATE ld_jobs SET state=$3,reason=$4,lease_token=NULL,lease_until=NULL WHERE library_id=$1 AND job_id=$2", library, job, state, reason); e != nil {
			return out, e
		}
		if _, e = tx.Exec(ctx, "UPDATE ld_runs SET state=$3,reason=$4 WHERE library_id=$1 AND run_id=$2", library, run, state, reason); e != nil {
			return out, e
		}
		if _, e = tx.Exec(ctx, "UPDATE native_user_route_budget SET cooldown_until=greatest(cooldown_until,clock_timestamp()+$2*interval '1 millisecond') WHERE session_hash=$1", sess.Hash, cooldown.Milliseconds()); e != nil {
			return out, e
		}
		attemptState = "failed"
		if d.CaptureSegment > 0 {
			settled, err := settleCaptureCeiling(ctx, tx, s.stagedQuery, library, run)
			if err != nil {
				return out, err
			}
			if settled != "" {
				out.State = settled
			}
		}
	} else if d.Stage == "esearch" && d.CaptureSegment > 0 {
		if !s.stagedQuery || !frozen {
			return out, &planError{409, "Staged capture is unavailable for this run."}
		}
		out, e = s.finishQueryCapture(ctx, tx, library, run, job, d, a.Body)
		if e != nil {
			return out, e
		}
		attemptState = "completed"
	} else if d.Stage == "esearch" {
		if frozen {
			return out, &planError{409, "Search membership is already frozen."}
		}
		total, ids, translation, err := parseSearchMetadata(a.Body, searchWindowLimit)
		if err != nil || total > 2147483647 || len(ids) != min(total, searchWindowLimit) || !validWindowIDs(ids) {
			return out, &planError{400, "Invalid or incomplete browser-submitted PubMed membership."}
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		encodedIDs, _ := json.Marshal(ids)
		snapshot, _ := json.Marshal(map[string]any{"SubmittedQuery": d.Parameters["term"], "Translation": translation, "StartedAt": d.ExpiresAt.Add(-120 * time.Second).Format(time.RFC3339Nano), "SourceIds": ids, "MembershipKind": "local_uid_window_v1", "WindowLimit": searchWindowLimit, "Execution": userRouteExecution, "SourceClaim": "pubmed", "Verification": userRouteVerification, "ReceivedAt": now, "ResponseSHA256": bodyHash})
		state = "queued"
		jobState = "queued"
		runState := "queued"
		if len(ids) == 0 {
			state = "exhausted"
			jobState = "completed"
			runState = "complete"
		}
		out = continuationReceipt{run, revision + 1, state}
		if _, e = tx.Exec(ctx, "UPDATE native_search_windows SET ids=$3,frozen=true,snapshot_at=$4,attempts=0,state=$5,revision=$6 WHERE library_id=$1 AND run_id=$2", library, run, string(encodedIDs), now, state, out.Revision); e != nil {
			return out, e
		}
		if _, e = tx.Exec(ctx, "UPDATE ld_runs SET total=$3,snapshot=$4,state=$5,reason='Browser-submitted membership saved; metadata is not independently source-attested.' WHERE library_id=$1 AND run_id=$2", library, run, total, string(snapshot), runState); e != nil {
			return out, e
		}
		if _, e = tx.Exec(ctx, "UPDATE ld_jobs SET state=$3,lease_token=NULL,lease_until=CASE WHEN $3='queued' THEN clock_timestamp()+interval '120 seconds' END WHERE library_id=$1 AND job_id=$2", library, job, jobState); e != nil {
			return out, e
		}
		attemptState = "completed"
	} else if d.Stage == "efetch" {
		ids := strings.Split(d.Parameters["id"], ",")
		articles, err := parseUserRouteMetadata(a.Body, ids, bodyHash, a.AttemptID)
		if err != nil {
			return out, err
		}
		result := searchResult{IDs: ids, Articles: articles, Offset: offset, Window: true, Started: time.Now().UTC().Format(time.RFC3339Nano), ClientSubmitted: true}
		page, err := tx.Begin(ctx)
		if err != nil {
			return out, err
		}
		err = s.saveSearchTx(ctx, page, c, result)
		if err != nil {
			_ = page.Rollback(ctx)
			var conflict *planError
			var rejected *sourceError
			if !(errors.As(err, &conflict) && conflict.Status == 409) && !errors.As(err, &rejected) {
				return out, err
			}
			// 保留可檢閱的原始回應，但整頁撤回，不能讓衝突資料改寫既有紀錄。
			reason = "Browser-submitted metadata conflicts with saved identifiers or the page storage bound. No records changed; the response is retained for review."
			out = continuationReceipt{run, revision + 1, "failed"}
			if _, e = tx.Exec(ctx, "UPDATE native_search_windows SET state='failed',revision=$3 WHERE library_id=$1 AND run_id=$2", library, run, out.Revision); e != nil {
				return out, e
			}
			if _, e = tx.Exec(ctx, "UPDATE ld_jobs SET state='failed',reason=$3,lease_token=NULL,lease_until=NULL WHERE library_id=$1 AND job_id=$2", library, job, reason); e != nil {
				return out, e
			}
			if _, e = tx.Exec(ctx, "UPDATE ld_runs SET state='failed',reason=$3 WHERE library_id=$1 AND run_id=$2", library, run, reason); e != nil {
				return out, e
			}
			attemptState = "failed"
		} else if e = page.Commit(ctx); e != nil {
			return out, e
		} else if e = tx.QueryRow(ctx, "SELECT revision,state FROM native_search_windows WHERE library_id=$1 AND run_id=$2", library, run).Scan(&out.Revision, &out.State); e != nil {
			return out, e
		} else {
			out.RunID = run
			attemptState = "completed"
		}
	} else {
		return out, errors.New("invalid browser stage")
	}
	encoded, _ := json.Marshal(out)
	if _, e = tx.Exec(ctx, "UPDATE native_user_route_attempts SET state=$3,body=$4,body_sha256=$5,outcome=$6,receipt=$7 WHERE library_id=$1 AND request_id=$2", library, a.AttemptID, attemptState, a.Body, bodyHash, a.Failure, string(encoded)); e != nil {
		return out, e
	}
	return out, tx.Commit(ctx)
}

func parseUserRouteMetadata(body []byte, ids []string, hash, attempt string) ([]map[string]any, error) {
	if len(body) < 1 || len(body) > userRouteBodyLimit || !utf8.Valid(body) || len(ids) < 1 || len(ids) > 100 || !validWindowIDs(ids) {
		return nil, &planError{400, "Invalid bounded metadata response."}
	}
	articles, e := parsePubMed(body)
	if e != nil {
		return nil, &planError{400, "Unsupported browser-submitted PubMed XML."}
	}
	byID := map[string]map[string]any{}
	for _, a := range articles {
		id := articleString(a, "Pmid")
		if !slices.Contains(ids, id) || byID[id] != nil {
			return nil, &planError{400, "Metadata contains a foreign or duplicate PMID."}
		}
		a["MetadataVerification"], a["MetadataExecution"], a["MetadataSourceClaim"] = userRouteVerification, userRouteExecution, "pubmed"
		a["MetadataResponseSHA256"], a["MetadataAttemptID"], a["MetadataReceivedAt"] = hash, attempt, time.Now().UTC().Format(time.RFC3339Nano)
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

// 過期只結束本機保留容量，不可重送 PubMed。每次最多處理既有上限的
// 20 個工作，並使用資料庫共同時鐘；有效租約與所有已儲存研究資料不變。
// 呼叫者必須先持有 capacityLock，並在同一交易內提交狀態與容量變更。
func retireExpiredUserRouteWork(ctx context.Context, tx pgx.Tx, staged ...bool) error {
	rows, e := tx.Query(ctx, `SELECT j.library_id::text,j.job_id,j.run_id,w.frozen
FROM ld_jobs j JOIN native_search_windows w USING(library_id,run_id)
WHERE j.kind='browser_search' AND j.state IN ('queued','running')
AND COALESCE(j.lease_until,j.created_at+interval '120 seconds')<=clock_timestamp()
ORDER BY j.library_id,j.job_id LIMIT 20 FOR UPDATE OF j,w`)
	if e != nil {
		return e
	}
	type expiredWork struct {
		library, job, run string
		frozen            bool
	}
	expired := []expiredWork{}
	for rows.Next() {
		var work expiredWork
		if e = rows.Scan(&work.library, &work.job, &work.run, &work.frozen); e != nil {
			break
		}
		expired = append(expired, work)
	}
	rows.Close()
	if e != nil {
		return e
	}
	if e = rows.Err(); e != nil {
		return e
	}
	for _, work := range expired {
		state, reason := interruptedUserRouteState(work.frozen)
		if _, e = tx.Exec(ctx, "UPDATE native_user_route_attempts SET state='interrupted' WHERE library_id=$1 AND run_id=$2 AND state='running'", work.library, work.run); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "UPDATE ld_jobs SET state=$3,reason=$4,lease_token=NULL,lease_until=NULL WHERE library_id=$1 AND job_id=$2", work.library, work.job, state, reason); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "UPDATE native_search_windows SET state=$3,revision=revision+1 WHERE library_id=$1 AND run_id=$2", work.library, work.run, state); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "UPDATE ld_runs SET state=$3,reason=$4 WHERE library_id=$1 AND run_id=$2", work.library, work.run, state, reason); e != nil {
			return e
		}
		if len(staged) > 0 && staged[0] {
			if _, e = settleCaptureCeiling(ctx, tx, true, work.library, work.run); e != nil {
				return e
			}
		}
	}
	return nil
}

func (s *server) retireUserRouteWork(ctx context.Context) error {
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(context.Background())
	if e = capacityLock(ctx, tx); e != nil {
		return e
	}
	if e = retireExpiredUserRouteWork(ctx, tx, s.stagedQuery); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func interruptedUserRouteState(frozen bool) (string, string) {
	if frozen {
		return "failed", "Browser attempt ended without a saved response. Review saved progress before explicitly retrying the current stage."
	}
	return "expired", "Initial membership is unknown after browser interruption. Submit a separate new search; this run will not be silently repeated."
}

// Explicit reconciliation expires only an observed unfinished lease. It neither
// replays a source request nor treats a closed browser as successful acquisition.
func (s *server) recoverUserRoute(ctx context.Context, library, run, attempt string) (continuationReceipt, error) {
	out := continuationReceipt{}
	if !s.userRoute || !runIDPattern.MatchString(run) || !uuidPattern.MatchString(attempt) {
		return out, &planError{400, "A valid run and attempt are required."}
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(context.Background())
	var job, state, lease string
	var expired bool
	if e = tx.QueryRow(ctx, "SELECT job_id,state,COALESCE(lease_token::text,''),COALESCE(lease_until<=clock_timestamp(),false) FROM ld_jobs WHERE library_id=$1 AND run_id=$2 AND kind='browser_search' FOR UPDATE", library, run).Scan(&job, &state, &lease, &expired); e != nil {
		return out, &planError{404, "Browser run not found."}
	}
	var priorState string
	if e = tx.QueryRow(ctx, "SELECT state FROM native_user_route_attempts WHERE library_id=$1 AND run_id=$2 AND request_id=$3", library, run, attempt).Scan(&priorState); e != nil {
		return out, &planError{404, "Browser attempt not found."}
	}
	var revision int
	var frozen bool
	if e = tx.QueryRow(ctx, "SELECT revision,state,frozen FROM native_search_windows WHERE library_id=$1 AND run_id=$2 FOR UPDATE", library, run).Scan(&revision, &out.State, &frozen); e != nil {
		return out, e
	}
	out.RunID, out.Revision = run, revision
	if priorState != "running" {
		return out, tx.Commit(ctx)
	}
	if state != "running" || lease != attempt || !expired {
		return out, &planError{409, "An active browser still owns this attempt; wait or explicitly cancel it."}
	}
	state, reason := interruptedUserRouteState(frozen)
	out.State, out.Revision = state, revision+1
	if _, e = tx.Exec(ctx, "UPDATE native_user_route_attempts SET state='interrupted' WHERE library_id=$1 AND request_id=$2", library, attempt); e != nil {
		return out, e
	}
	if _, e = tx.Exec(ctx, "UPDATE ld_jobs SET state=$3,reason=$4,lease_token=NULL,lease_until=NULL WHERE library_id=$1 AND job_id=$2", library, job, state, reason); e != nil {
		return out, e
	}
	if _, e = tx.Exec(ctx, "UPDATE native_search_windows SET state=$3,revision=$4 WHERE library_id=$1 AND run_id=$2", library, run, state, out.Revision); e != nil {
		return out, e
	}
	if _, e = tx.Exec(ctx, "UPDATE ld_runs SET state=$3,reason=$4 WHERE library_id=$1 AND run_id=$2", library, run, state, reason); e != nil {
		return out, e
	}
	settled, err := settleCaptureCeiling(ctx, tx, s.stagedQuery, library, run)
	if err != nil {
		return out, err
	}
	if settled != "" {
		out.State = settled
	}
	return out, tx.Commit(ctx)
}

func (s *server) userRouteRoutes(w http.ResponseWriter, r *http.Request, ctx context.Context, library string, parts []string, sess *session) bool {
	if len(parts) != 7 || parts[3] != "runs" || parts[5] != "user-route" || r.Method != "POST" {
		return false
	}
	if !s.userRoute {
		reply(w, 409, map[string]string{"error": "Browser-origin requests require the supported schema."})
		return true
	}
	switch parts[6] {
	case "claim":
		var input userRouteClaim
		if decode(w, r, &input) {
			value, e := s.claimUserRoute(ctx, library, parts[4], input, sess)
			planReply(w, value, e)
		}
	case "upload":
		var input userRouteUpload
		if decodeBounded(w, r, &input, 4*userRouteBodyLimit/3+16384) {
			value, e := s.submitUserRoute(ctx, library, parts[4], input, sess)
			planReply(w, value, e)
		}
	case "recover":
		var input struct {
			AttemptID string `json:"attemptID"`
		}
		if decode(w, r, &input) {
			value, e := s.recoverUserRoute(ctx, library, parts[4], input.AttemptID)
			planReply(w, value, e)
		}
	default:
		reply(w, 404, nil)
	}
	return true
}
