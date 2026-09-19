package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("Random source unavailable")
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func newID(prefix string) string { return prefix + strings.ReplaceAll(newUUID(), "-", "") }
func (s *server) createLibrary(ctx context.Context, account, name string) (string, error) {
	if strings.TrimSpace(name) == "" || len([]rune(name)) > 120 {
		return "", errors.New("invalid name")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(724913015)"); err != nil {
		return "", err
	}
	var count, total int
	err = tx.QueryRow(ctx, "SELECT count(*) FILTER (WHERE owner_id=$1),count(*) FROM ld_libraries", account).Scan(&count, &total)
	if err != nil {
		return "", err
	}
	if count >= 5 || total >= 20 {
		return "", errors.New("library capacity")
	}
	id := newUUID()
	if _, err = tx.Exec(ctx, "INSERT INTO ld_libraries VALUES($1,$2,$3,true)", id, account, name); err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}
func (s *server) catalog(ctx context.Context, library string, offset int) (any, error) {
	if s.native {
		runs, e := s.rows(ctx, "SELECT run_id,input,total,fetched,state,reason FROM ld_runs WHERE library_id=$1 ORDER BY run_id LIMIT 100 OFFSET $2", library, offset)
		if e != nil {
			return nil, e
		}
		batches, e := s.rows(ctx, "SELECT batch_id,state FROM native_batches WHERE library_id=$1 ORDER BY created_at,batch_id LIMIT 100 OFFSET $2", library, offset)
		if e != nil {
			return nil, e
		}
		var nr, nb int
		if e = s.db.QueryRow(ctx, "SELECT (SELECT count(*) FROM ld_runs WHERE library_id=$1),(SELECT count(*) FROM native_batches WHERE library_id=$1)", library).Scan(&nr, &nb); e != nil {
			return nil, e
		}
		return map[string]any{"runs": runs, "batches": batches, "scopes": []any{}, "totals": map[string]int{"runs": nr, "batches": nb, "scopes": 0}, "offset": offset, "limit": 100}, nil
	}
	out := map[string]any{"offset": offset, "limit": 100}
	totals := map[string]int{}
	for _, entry := range []struct{ key, table, sql string }{
		{"runs", "ld_runs", "SELECT run_id,input,total,fetched,state,reason FROM ld_runs WHERE library_id=$1 ORDER BY run_id LIMIT 100 OFFSET $2"},
		{"scopes", "ld_scopes", "SELECT library_id::text,scope_id,run_id,parent_id,description FROM ld_scopes WHERE library_id=$1 ORDER BY scope_id LIMIT 100 OFFSET $2"},
		{"batches", "ld_batches", "SELECT library_id::text,batch_id,scope_id,state,template FROM ld_batches WHERE library_id=$1 ORDER BY batch_id LIMIT 100 OFFSET $2"},
	} {
		rows, err := s.rows(ctx, entry.sql, library, offset)
		if err != nil {
			return nil, err
		}
		out[entry.key] = rows
		var n int
		if err = s.db.QueryRow(ctx, "SELECT count(*) FROM "+entry.table+" WHERE library_id=$1", library).Scan(&n); err != nil {
			return nil, err
		}
		totals[entry.key] = n
	}
	out["totals"] = totals
	return out, nil
}
func (s *server) queueSearch(ctx context.Context, library, query string, limit int, request ...string) (string, error) {
	if strings.TrimSpace(query) == "" || len([]rune(query)) > 2000 || limit < 1 || limit > 100 {
		return "", &planError{400, "A query up to 2000 characters and a metadata page size of 1–100 are required."}
	}
	if s.continuation && (s.cfg.SearchContinuationEnabled || len(request) > 0 && request[0] != "") {
		id := ""
		if len(request) > 0 {
			id = request[0]
		}
		return s.queueContinuedSearch(ctx, library, query, limit, id)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(724913015)"); err != nil {
		return "", err
	}
	var runs, jobs, active int
	err = tx.QueryRow(ctx, "SELECT (SELECT count(*) FROM ld_runs),(SELECT count(*) FROM ld_jobs),(SELECT count(*) FROM ld_jobs WHERE state IN ('queued','running','scheduled'))").Scan(&runs, &jobs, &active)
	if err != nil {
		return "", err
	}
	if runs >= 200 || jobs >= 1000 || active >= 20 {
		return "", errors.New("candidate capacity")
	}
	run := newID("RUN-")
	_, err = tx.Exec(ctx, "INSERT INTO ld_runs(library_id,run_id,input,requested_limit,state) VALUES($1,$2,$3,$4,'queued')", library, run, query, limit)
	if err == nil {
		_, err = tx.Exec(ctx, "INSERT INTO ld_jobs(library_id,job_id,kind,run_id,state) VALUES($1,$2,'search',$3,'queued')", library, newID("JOB-"), run)
	}
	if err != nil {
		return "", err
	}
	return run, tx.Commit(ctx)
}

type claim struct {
	Library, Job, Run, Lease, Query string
	Limit                           int
}

func (s *server) worker(ctx context.Context) {
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.workOne(ctx)
			if s.native {
				s.batchOne(ctx)
			}
		}
	}
}
func (s *server) workOne(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 90*time.Second)
	defer cancel()
	gate, err := s.db.Acquire(ctx)
	if err != nil {
		return
	}
	defer gate.Release()
	defer func() {
		c, done := context.WithTimeout(context.Background(), 2*time.Second)
		defer done()
		if _, e := gate.Exec(c, "SELECT pg_advisory_unlock_all()"); e != nil {
			_ = gate.Conn().Close(c)
		}
	}()
	var shared, heavy bool
	if gate.QueryRow(ctx, "SELECT pg_try_advisory_lock_shared(724913010),pg_try_advisory_lock(724913011)").Scan(&shared, &heavy) != nil || !shared || !heavy {
		return
	}
	var recoveryRequired bool
	if gate.QueryRow(ctx, "SELECT required FROM ld_recovery_guard WHERE singleton=true").Scan(&recoveryRequired) != nil || recoveryRequired {
		return
	}
	if s.userRoute {
		if err = s.retireUserRouteWork(ctx); err != nil {
			return
		}
	}
	// Shared database fence prevents a concurrent supported worker from re-claiming this running attempt.
	_, err = s.db.Exec(ctx, "UPDATE ld_jobs SET state='queued',lease_token=NULL,lease_until=NULL WHERE kind='search' AND state='running' AND lease_until<now()")
	if err != nil {
		return
	}
	c := claim{Lease: newUUID()}
	err = s.db.QueryRow(ctx, `WITH chosen AS (SELECT library_id,job_id FROM ld_jobs WHERE kind='search' AND state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE ld_jobs j SET state='running',lease_token=$1,lease_until=now()+interval '120 seconds' FROM chosen c WHERE j.library_id=c.library_id AND j.job_id=c.job_id RETURNING j.library_id::text,j.job_id,j.run_id`, c.Lease).Scan(&c.Library, &c.Job, &c.Run)
	if err != nil {
		return
	}
	err = s.db.QueryRow(ctx, "SELECT input,requested_limit FROM ld_runs WHERE library_id=$1 AND run_id=$2", c.Library, c.Run).Scan(&c.Query, &c.Limit)
	var result searchResult
	if err == nil {
		var handled bool
		handled, result, err = s.continuedSearch(ctx, c)
		if handled {
			// The durable window owns source admission, including interrupted attempts.
		} else if !s.cfg.SearchEnabled {
			err = &sourceError{"unavailable", "Provider access is disabled for this isolated candidate; no live result fabricated."}
		} else {
			result, err = s.search(ctx, c.Query, c.Limit)
		}
	}
	if err == nil {
		err = s.saveSearch(ctx, c, result)
	}
	if err != nil {
		state, reason := "failed", "Search unavailable; no completion assumed."
		var se *sourceError
		if errors.As(err, &se) {
			state, reason = se.State, se.Reason
		}
		if s.continuation && result.Window {
			state = continuationFailureState(state)
		}
		if parent.Err() != nil {
			state, reason = "queued", "Service interrupted; unfinished search retained for restart."
		}
		finish, done := context.WithTimeout(context.Background(), 3*time.Second)
		defer done()
		tx, e := s.db.Begin(finish)
		if e != nil {
			return
		}
		defer tx.Rollback(context.Background())
		tag, e := tx.Exec(finish, "UPDATE ld_jobs SET state=$4,reason=$5,lease_token=NULL,lease_until=NULL WHERE library_id=$1 AND job_id=$2 AND lease_token=$3", c.Library, c.Job, c.Lease, state, reason)
		if e == nil && tag.RowsAffected() == 1 {
			_, e = tx.Exec(finish, "UPDATE ld_runs SET state=$3,reason=$4 WHERE library_id=$1 AND run_id=$2", c.Library, c.Run, state, reason)
			if e == nil && s.continuation {
				_, e = tx.Exec(finish, "UPDATE native_search_windows SET state=$3,revision=revision+1 WHERE library_id=$1 AND run_id=$2", c.Library, c.Run, state)
			}
		}
		if e == nil {
			_ = tx.Commit(finish)
		}
	}
}
func (s *server) saveSearch(ctx context.Context, c claim, result searchResult) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = s.saveSearchTx(ctx, tx, c, result); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *server) saveSearchTx(ctx context.Context, tx pgx.Tx, c claim, result searchResult) error {
	var err error
	var job string
	if err = tx.QueryRow(ctx, "SELECT job_id FROM ld_jobs WHERE library_id=$1 AND job_id=$2 AND lease_token=$3 AND state='running' AND lease_until>now() FOR UPDATE", c.Library, c.Job, c.Lease).Scan(&job); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", c.Library); err != nil {
		return err
	}
	for _, a := range result.Articles {
		rank := result.Offset + slices.Index(result.IDs, a["Pmid"].(string))
		ids := map[string]string{"pmid": a["Pmid"].(string), "pmcid": a["Pmcid"].(string), "doi": a["Doi"].(string)}
		id := ""
		for kind, value := range ids {
			if value == "" {
				continue
			}
			var match string
			e := tx.QueryRow(ctx, "SELECT search_id FROM ld_identifiers WHERE library_id=$1 AND kind=$2 AND value=$3", c.Library, kind, value).Scan(&match)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
			if e == nil {
				if id != "" && id != match {
					return &sourceError{"failed", "Conflicting repository identifiers; prior records preserved."}
				}
				id = match
			}
		}
		if id == "" {
			id = newID("LD-")
		} else {
			var old string
			if err = tx.QueryRow(ctx, "SELECT metadata FROM ld_records WHERE library_id=$1 AND search_id=$2 FOR UPDATE", c.Library, id).Scan(&old); err != nil {
				return err
			}
			var prior map[string]any
			if json.Unmarshal([]byte(old), &prior) != nil {
				return errors.New("stored metadata invalid")
			}
			if result.ClientSubmitted {
				// A syntactically valid client assertion cannot add identifiers to,
				// replace, or downgrade an existing canonical record. The complete
				// incoming body stays in the immutable attempt for later review.
				if articleString(prior, "Pmid") != articleString(a, "Pmid") {
					return &planError{409, "Client-submitted identifiers conflict with an existing record; independent review is required."}
				}
				for kind, key := range map[string]string{"doi": "Doi", "pmid": "Pmid", "pmcid": "Pmcid"} {
					value := articleString(prior, key)
					if ids[kind] != "" && value != "" && ids[kind] != value {
						return &planError{409, "Client-submitted identifiers conflict with an existing record; independent review is required."}
					}
					ids[kind] = value
				}
				a = prior
			}
			// Preserve fields unknown to the new backend and the established full-text/research metadata.
			for k, v := range prior {
				if _, exists := a[k]; !exists {
					a[k] = v
				}
			}
			for _, k := range []string{"FullTextMetadataXml", "RetrievalState", "License", "ArticleNumber", "EqualContribution"} {
				if v, ok := prior[k]; ok {
					a[k] = v
				}
			}
			for _, k := range []string{"Doi", "Pmid", "Pmcid"} {
				if a[k] == "" {
					a[k] = prior[k]
				}
			}
		}
		a["SearchId"] = id
		links(a)
		b, e := json.Marshal(a)
		if e != nil {
			return e
		}
		if _, err = tx.Exec(ctx, "INSERT INTO ld_records(library_id,search_id,metadata,title) VALUES($1,$2,$3,$4) ON CONFLICT(library_id,search_id) DO UPDATE SET metadata=excluded.metadata,title=excluded.title", c.Library, id, string(b), a["Title"]); err != nil {
			return err
		}
		for kind, value := range ids {
			if value != "" {
				if _, err = tx.Exec(ctx, "INSERT INTO ld_identifiers VALUES($1,$2,$3,$4) ON CONFLICT(library_id,kind,value) DO NOTHING", c.Library, kind, value, id); err != nil {
					return err
				}
			}
		}
		if _, err = tx.Exec(ctx, "INSERT INTO ld_results VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", c.Library, c.Run, id, rank+1); err != nil {
			return err
		}
	}
	if result.Window {
		if err = s.finishSearchPage(ctx, tx, c, result); err != nil {
			return err
		}
	} else {
		state, reason := "complete", ""
		if len(result.Articles) != result.Total {
			state = "partial"
			reason = fmt.Sprintf("Retrieved %d of %d; requested limit %d. Refine the query; remaining records were not retrieved.", len(result.Articles), result.Total, c.Limit)
		}
		snapshot, _ := json.Marshal(map[string]any{"SubmittedQuery": result.Query, "Translation": result.Translation, "StartedAt": result.Started, "SourceIds": result.IDs})
		_, err = tx.Exec(ctx, "UPDATE ld_runs SET total=$3,fetched=$4,state=$5,reason=$6,snapshot=$7 WHERE library_id=$1 AND run_id=$2", c.Library, c.Run, result.Total, len(result.Articles), state, reason, string(snapshot))
		if err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, "UPDATE ld_jobs SET state='completed',reason='Search metadata saved; source totals and partial status retained.',lease_token=NULL,lease_until=NULL WHERE library_id=$1 AND job_id=$2", c.Library, c.Job)
	if err != nil {
		return err
	}
	return nil
}
