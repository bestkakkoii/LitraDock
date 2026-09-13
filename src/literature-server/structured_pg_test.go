package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStructuredActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Dedicated actual PostgreSQL not configured")
	}
	raw, e := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if e != nil {
		t.Fatal("protected configuration absent")
	}
	var cfg config
	if json.Unmarshal(raw, &cfg) != nil {
		t.Fatal("configuration")
	}
	pc, e := pgxpool.ParseConfig(cfg.Database)
	if e != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_test_") {
		t.Fatal("dedicated test database required")
	}
	pc.MaxConns = 8
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	db, e := pgxpool.NewWithConfig(ctx, pc)
	if e != nil {
		t.Fatal("database connection")
	}
	defer db.Close()
	must := func(q string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	var tables int
	if db.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables) != nil {
		t.Fatal("schema")
	}
	if tables == 0 {
		must(nativeSchema)
	}
	a, b, lib, other, run, batch := newUUID(), newUUID(), newUUID(), newUUID(), newID("RUN-"), newID("BAT-")
	must("INSERT INTO ld_accounts VALUES($1,$2,'unused',true),($3,$4,'unused',true)", a, "synthetic-export-"+a, b, "synthetic-export-"+b)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC export',true),($3,$4,'SYNTHETIC foreign',true)", lib, a, other, b)
	defer func() {
		for _, table := range []string{"native_originals", "native_items", "native_batches", "ld_results", "ld_jobs", "ld_runs", "ld_records"} {
			must("DELETE FROM "+table+" WHERE library_id=$1", lib)
		}
		must("DELETE FROM ld_libraries WHERE library_id IN ($1,$2)", lib, other)
		must("DELETE FROM ld_sessions WHERE account_id IN ($1,$2)", a, b)
		must("DELETE FROM ld_accounts WHERE account_id IN ($1,$2)", a, b)
	}()
	must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state,reason) VALUES($1,$2,$3,25001,1000,1000,'partial','Saved retrieval limit')", lib, run, "SYNTHETIC 醫學 AND (English OR العربية)\n2026")
	must("INSERT INTO native_batches(library_id,batch_id,request_id,selection,state,requested_format) VALUES($1,$2,$3,'synthetic','complete','pdf')", lib, batch, newUUID())
	ids := make([]string, 1000)
	tx, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	for i := range ids {
		ids[i] = fmt.Sprintf("000012345678901234567890-%04d", i)
		m := map[string]any{"SearchId": ids[i], "Title": "SYNTHETIC 醫學 😀 \"quote\"\nline", "Pmid": "0000123", "Pmcid": "PMC990000001", "Doi": "10.0000/synthetic", "password": "PRIVATE_SENTINEL", "RawXml": "PRIVATE_SENTINEL"}
		if i == 0 {
			m["Abstract"] = "=SUM(1,2)\n資料"
		}
		raw, _ := json.Marshal(m)
		if _, e = tx.Exec(ctx, "INSERT INTO ld_records VALUES($1,$2,$3,'synthetic')", lib, ids[i], string(raw)); e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, "INSERT INTO ld_results VALUES($1,$2,$3,$4)", lib, run, ids[i], i+1); e != nil {
			t.Fatal(e)
		}
		if i < 3 {
			state, reason := "acquired", ""
			if i == 2 {
				state, reason = "held", "Unknown rights; use the source link"
			}
			if _, e = tx.Exec(ctx, "INSERT INTO native_items(library_id,batch_id,search_id,rank,state,reason) VALUES($1,$2,$3,$4,$5,$6)", lib, batch, ids[i], i+1, state, reason); e != nil {
				t.Fatal(e)
			}
		}
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	hash := strings.Repeat("a", 64)
	must("INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy,format) VALUES($1,$2,$3,$4,$5,$6,'2026-01-01','synthetic','pdf')", lib, ids[0], hash, []byte("SYNTHETIC DESCRIPTOR ONLY; NOT A PDF"), "https://pmc-oa-opendata.s3.amazonaws.com/PMC990000001.1/PMC990000001.1.pdf", "https://creativecommons.org/licenses/by/4.0/")
	var calls atomic.Int32
	s := &server{db: db, native: true, cfg: config{LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour)}, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{Transport: nativeTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, fmt.Errorf("export must not request a provider")
	})}}
	tokenA, tokenB, csrf := randomToken(), randomToken(), randomToken()
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour'),($4,$5,$3,now()+interval '1 hour')", digest(tokenA), a, csrf, digest(tokenB), b)
	request := func(library, token, anti, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/libraries/"+library+"/exports", strings.NewReader(body))
		r.Host = "127.0.0.1:18089"
		r.AddCookie(&http.Cookie{Name: "LitraDockTest", Value: token})
		r.Header.Set("Origin", s.cfg.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF", anti)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	body := func(run, batch, format string) string {
		b, _ := json.Marshal(map[string]string{"runID": run, "batchID": batch, "format": format})
		return string(b)
	}
	t.Run("whole-scope-typed-counts-provenance-and-zero-provider-calls", func(t *testing.T) {
		for _, format := range []string{"json", "jsonl"} {
			w := request(lib, tokenA, csrf, body(run, "", format))
			if w.Code != 200 || strings.Contains(w.Body.String(), "PRIVATE_SENTINEL") || w.Header().Get("Content-Type") != structuredMedia(format) {
				t.Fatal("export boundary", w.Code, w.Body.String())
			}
			if out := os.Getenv("NATIVE_STRUCTURED_TEST_OUTPUT"); out != "" {
				if e = os.MkdirAll(out, 0700); e != nil {
					t.Fatal(e)
				}
				if e = os.WriteFile(filepath.Join(out, "postgres-synthetic."+format), w.Body.Bytes(), 0600); e != nil {
					t.Fatal(e)
				}
			}
		}
		d, e := s.structuredResearch(ctx, lib, run, "")
		if e != nil || len(d.Records) != 1000 || *d.Counts.Provider != 25001 || d.Queries[0].Complete || d.Records[1].Publication.Abstract != nil || d.Records[0].SearchID != ids[0] {
			t.Fatal("run fidelity", e)
		}
		d, e = s.structuredResearch(ctx, lib, "", batch)
		if e != nil || len(d.Records) != 3 || d.Counts.Provider != nil || d.Counts.Retrieved != nil || *d.Records[2].Acquisition.State != "held" || d.Records[2].Links.PubMed == nil {
			t.Fatal("batch context", e)
		}
		o := d.Records[0].Originals[0]
		if o.SHA256 != hash || o.Format != "PDF" || o.Deposit == nil || *o.Deposit != "1" || o.Availability != "not_revalidated" {
			t.Fatal("historical provenance")
		}
		if calls.Load() != 0 {
			t.Fatal("hidden provider request")
		}
	})
	t.Run("tenant-csrf-stale-scope-malformed-and-session-denials", func(t *testing.T) {
		for _, v := range []struct {
			lib, token, csrf, body string
			status                 int
		}{{lib, tokenB, csrf, body(run, "", "json"), 404}, {other, tokenB, csrf, body(run, "", "json"), 409}, {lib, tokenA, "", body(run, "", "json"), 403}, {lib, tokenA, csrf, body("missing", "", "jsonl"), 409}, {lib, tokenA, csrf, body(run, batch, "json"), 409}} {
			w := request(v.lib, v.token, v.csrf, v.body)
			if w.Code != v.status {
				t.Fatalf("denial got%d want%d", w.Code, v.status)
			}
		}
		must("UPDATE ld_records SET metadata=$3 WHERE library_id=$1 AND search_id=$2", lib, ids[999], `{"SearchId":"wrong","password":"PRIVATE_SENTINEL"}`)
		w := request(lib, tokenA, csrf, body(run, "", "jsonl"))
		if w.Code != 409 || strings.Contains(w.Body.String(), "PRIVATE_SENTINEL") || strings.Contains(w.Body.String(), "manifest") {
			t.Fatal("partial or private error escaped")
		}
		raw, _ := json.Marshal(map[string]string{"SearchId": ids[999], "Title": "SYNTHETIC restored"})
		must("UPDATE ld_records SET metadata=$3 WHERE library_id=$1 AND search_id=$2", lib, ids[999], string(raw))
		must("DELETE FROM ld_sessions WHERE token_hash=$1", digest(tokenA))
		if request(lib, tokenA, csrf, body(run, "", "json")).Code != 401 {
			t.Fatal("revoked session exported")
		}
	})
	t.Run("repeatable-read-observed-lock-schedule", func(t *testing.T) {
		holder, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer holder.Rollback(ctx)
		if _, e = holder.Exec(ctx, "LOCK TABLE ld_records IN ACCESS EXCLUSIVE MODE"); e != nil {
			t.Fatal(e)
		}
		type result struct {
			d structuredDocument
			e error
		}
		done := make(chan result, 1)
		go func() { d, e := s.structuredResearch(ctx, lib, run, ""); done <- result{d, e} }()
		deadline := time.Now().Add(5 * time.Second)
		observed := false
		for time.Now().Before(deadline) {
			var waiting bool
			e = db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT count(*),COALESCE(sum(octet_length(r.metadata))%')").Scan(&waiting)
			if e != nil {
				t.Fatal(e)
			}
			if waiting {
				observed = true
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !observed {
			t.Fatal("export lock not observed")
		}
		if _, e = holder.Exec(ctx, "UPDATE ld_runs SET input='SYNTHETIC later revision' WHERE library_id=$1 AND run_id=$2", lib, run); e != nil {
			t.Fatal(e)
		}
		if _, e = holder.Exec(ctx, "UPDATE ld_records SET metadata=jsonb_set(metadata::jsonb,'{Title}','\"SYNTHETIC later title\"')::text WHERE library_id=$1 AND search_id=$2", lib, ids[0]); e != nil {
			t.Fatal(e)
		}
		if e = holder.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		got := <-done
		if got.e != nil || got.d.Queries[0].Query == "SYNTHETIC later revision" || *got.d.Records[0].Publication.Title == "SYNTHETIC later title" {
			t.Fatal("mixed snapshot", got.e)
		}
		fresh, e := s.structuredResearch(ctx, lib, run, "")
		if e != nil || fresh.Queries[0].Query != "SYNTHETIC later revision" || *fresh.Records[0].Publication.Title != "SYNTHETIC later title" {
			t.Fatal("fresh snapshot", e)
		}
	})
	if calls.Load() != 0 {
		t.Fatal("provider calls")
	}
}
