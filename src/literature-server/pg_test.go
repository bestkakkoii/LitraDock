package main

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestActualPostgresMigrationContracts(t *testing.T) {
	if os.Getenv("LITRADOCK_GO_INTEGRATION") != "yes" {
		t.Skip("Actual disposable PostgreSQL authority/configuration absent")
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
	if e != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_migration_") {
		t.Fatal("isolated database required")
	}
	pc.MaxConns = 8
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	db, e := pgxpool.NewWithConfig(ctx, pc)
	if e != nil {
		t.Fatal("PG connection")
	}
	defer db.Close()
	s := &server{db: db, cfg: config{LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour)}, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1)}
	var v []struct{ Password, Hash string }
	raw, _ = os.ReadFile("testdata/identity-v3.json")
	if json.Unmarshal(raw, &v) != nil {
		t.Fatal("vectors")
	}
	a, b := newUUID(), newUUID()
	loginA, loginB := "synthetic-"+a, "synthetic-"+b
	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, q, args...); e != nil {
			t.Fatal("SQL contract failed: ", e)
		}
	}
	mustExec("INSERT INTO ld_accounts VALUES($1,$2,$3,true),($4,$5,$3,true)", a, loginA, v[0].Hash, b, loginB)
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		tx, e := db.Begin(cleanup)
		if e != nil {
			t.Error("fixture cleanup transaction failed")
			return
		}
		defer tx.Rollback(cleanup)
		for _, table := range []string{"ld_results", "ld_identifiers", "ld_jobs", "ld_records", "ld_runs"} {
			if _, e = tx.Exec(cleanup, "DELETE FROM "+table+" WHERE library_id IN (SELECT library_id FROM ld_libraries WHERE owner_id IN ($1,$2))", a, b); e != nil {
				t.Error("fixture child cleanup failed", table)
				return
			}
		}
		for _, q := range []string{"DELETE FROM ld_libraries WHERE owner_id IN ($1,$2)", "DELETE FROM ld_sessions WHERE account_id IN ($1,$2)", "DELETE FROM ld_accounts WHERE account_id IN ($1,$2)"} {
			if _, e = tx.Exec(cleanup, q, a, b); e != nil {
				t.Error("fixture identity cleanup failed")
				return
			}
		}
		if tx.Commit(cleanup) != nil {
			t.Error("fixture cleanup commit failed")
			return
		}
		var remaining int
		if db.QueryRow(cleanup, "SELECT count(*) FROM ld_accounts WHERE account_id IN ($1,$2)", a, b).Scan(&remaining) != nil || remaining != 0 {
			t.Error("fixture accounts remain")
		}
	}()
	tokenA, sa, e := s.login(ctx, loginA, v[0].Password)
	if e != nil || sa == nil {
		t.Fatal("enabled login")
	}
	_, sa2, e := s.login(ctx, loginA, v[0].Password)
	if e != nil || sa2 == nil || sa.Hash == sa2.Hash {
		t.Fatal("two independent sessions")
	}
	tokenB, sb, e := s.login(ctx, loginB, v[0].Password)
	if e != nil || sb == nil {
		t.Fatal("B login")
	}
	if _, ss, e := s.login(ctx, loginA, "wrong"); e != nil || ss != nil {
		t.Fatal("wrong password")
	}
	lib, e := s.createLibrary(ctx, a, "Synthetic migration test")
	if e != nil {
		t.Fatal("create library", e)
	}
	request := func(method, path, token, csrf, origin, body string) int {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Host = "127.0.0.1:18089"
		r.AddCookie(&http.Cookie{Name: "LitraDockTest", Value: token})
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF", csrf)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	for _, x := range []struct {
		method, path, token, csrf, origin, body string
		status                                  int
	}{
		{"GET", "/api/libraries/" + lib, tokenA, "", "", "", 200},
		{"GET", "/api/libraries/" + lib, tokenB, "", "", "", 404},
		{"POST", "/api/libraries/" + lib + "/search", tokenA, "", s.cfg.Origin, `{"query":"synthetic","limit":1}`, 403},
		{"POST", "/api/libraries/" + lib + "/search", tokenA, sa.CSRF, "https://wrong.invalid", `{"query":"synthetic","limit":1}`, 403},
		{"POST", "/api/libraries/" + lib + "/search", tokenA, sa.CSRF, s.cfg.Origin, `{"query":"synthetic","limit":101}`, 409},
		{"POST", "/api/libraries/" + lib + "/batch", tokenA, sa.CSRF, s.cfg.Origin, `{}`, 501},
	} {
		if status := request(x.method, x.path, x.token, x.csrf, x.origin, x.body); status != x.status {
			t.Fatalf("API %s %s got%d want%d", x.method, x.path, status, x.status)
		}
	}
	run, e := s.queueSearch(ctx, lib, "Explicit synthetic disabled-provider control", 1)
	if e != nil {
		t.Fatal(e)
	}
	s.workOne(ctx)
	var state string
	if db.QueryRow(ctx, "SELECT state FROM ld_runs WHERE library_id=$1 AND run_id=$2", lib, run).Scan(&state) != nil || state != "unavailable" {
		t.Fatal("disabled provider invented completion", state)
	}
	// Actual lock ordering: login starts while a disabling transaction holds the account row.
	tx, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(context.Background())
	if _, e = tx.Exec(ctx, "SELECT account_id FROM ld_accounts WHERE account_id=$1 FOR UPDATE", a); e != nil {
		t.Fatal(e)
	}
	done := make(chan bool, 1)
	go func() { _, ss, e := s.login(ctx, loginA, v[0].Password); done <- e == nil && ss == nil }()
	select {
	case <-done:
		t.Fatal("login bypassed row lock")
	case <-time.After(150 * time.Millisecond):
	}
	if _, e = tx.Exec(ctx, "UPDATE ld_accounts SET enabled=false WHERE account_id=$1", a); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, "DELETE FROM ld_sessions WHERE account_id=$1", a); e != nil {
		t.Fatal(e)
	}
	if tx.Commit(ctx) != nil {
		t.Fatal("commit")
	}
	if !<-done {
		t.Fatal("login serialized before disabled state")
	}
	for _, hash := range []string{sa.Hash, sa2.Hash} {
		var n int
		if db.QueryRow(ctx, "SELECT count(*) FROM ld_sessions WHERE token_hash=$1", hash).Scan(&n) != nil || n != 0 {
			t.Fatal("session revoke")
		}
	}
	if request("GET", "/api/session", tokenA, "", "", "") != 401 || request("GET", "/api/session", tokenB, "", "", "") != 200 {
		t.Fatal("session isolation after revoke")
	}
	mustExec("UPDATE ld_accounts SET enabled=true WHERE account_id=$1", a)
	if request("GET", "/api/session", tokenA, "", "", "") != 401 {
		t.Fatal("old session resurrected")
	}
	mustExec("UPDATE ld_recovery_guard SET required=true WHERE singleton=true")
	status := request("GET", "/api/session", tokenB, "", "", "")
	mustExec("UPDATE ld_recovery_guard SET required=false WHERE singleton=true")
	if status != 503 {
		t.Fatal("recovery guard bypass")
	}
	metadata, _ := os.ReadFile("testdata/synthetic-pubmed.xml")
	articles, e := parsePubMed(metadata)
	if e != nil {
		t.Fatal(e)
	}
	claimFor := func() claim {
		t.Helper()
		run, e := s.queueSearch(ctx, lib, "Explicit synthetic metadata persistence", 3)
		if e != nil {
			t.Fatal(e)
		}
		c := claim{Library: lib, Run: run, Lease: newUUID(), Limit: 3}
		e = db.QueryRow(ctx, "UPDATE ld_jobs SET state='running',lease_token=$3,lease_until=now()+interval '120 seconds' WHERE library_id=$1 AND run_id=$2 RETURNING job_id", lib, run, c.Lease).Scan(&c.Job)
		if e != nil {
			t.Fatal(e)
		}
		return c
	}
	c := claimFor()
	result := searchResult{Total: 3, IDs: []string{"990000001", "990000002", "990000003"}, Articles: articles}
	if e = s.saveSearch(ctx, c, result); e != nil {
		t.Fatal("metadata transaction", e)
	}
	if db.QueryRow(ctx, "SELECT state FROM ld_runs WHERE library_id=$1 AND run_id=$2", lib, c.Run).Scan(&state) != nil || state != "partial" {
		t.Fatal("partial completion misreported")
	}
	var identity string
	if db.QueryRow(ctx, "SELECT search_id FROM ld_identifiers WHERE library_id=$1 AND kind='pmid' AND value='990000001'", lib).Scan(&identity) != nil {
		t.Fatal("stable identifier")
	}
	mustExec(`UPDATE ld_records SET metadata=(metadata::jsonb || '{"License":"synthetic retained rights","FullTextMetadataXml":"synthetic retained metadata","ResearchFuture":"synthetic unknown field"}'::jsonb)::text WHERE library_id=$1 AND search_id=$2`, lib, identity)
	articles, e = parsePubMed(metadata)
	if e != nil {
		t.Fatal(e)
	}
	result.Articles = articles
	c = claimFor()
	if e = s.saveSearch(ctx, c, result); e != nil {
		t.Fatal(e)
	}
	var stored string
	if db.QueryRow(ctx, "SELECT metadata FROM ld_records WHERE library_id=$1 AND search_id=$2", lib, identity).Scan(&stored) != nil {
		t.Fatal("stable identity missing")
	}
	var preserved map[string]any
	_ = json.Unmarshal([]byte(stored), &preserved)
	if preserved["License"] != "synthetic retained rights" || preserved["ResearchFuture"] != "synthetic unknown field" {
		t.Fatal("inherited metadata lost")
	}
	// A source record trying to join identifiers belonging to different durable records rolls back.
	articles, e = parsePubMed(metadata)
	if e != nil {
		t.Fatal(e)
	}
	articles[0]["Doi"] = articles[1]["Doi"]
	result.Articles = articles[:1]
	c = claimFor()
	if e = s.saveSearch(ctx, c, result); e == nil {
		t.Fatal("conflicting identifiers committed")
	}
	var count int
	if db.QueryRow(ctx, "SELECT count(*) FROM ld_results WHERE library_id=$1 AND run_id=$2", lib, c.Run).Scan(&count) != nil || count != 0 {
		t.Fatal("failed save partially committed")
	}
	mustExec("UPDATE ld_jobs SET state='paused',lease_token=NULL,lease_until=NULL WHERE library_id=$1", lib)
	s.workOne(ctx)
	if db.QueryRow(ctx, "SELECT count(*) FROM ld_jobs WHERE library_id=$1 AND state!='paused'", lib).Scan(&count) != nil || count != 0 {
		t.Fatal("paused jobs resumed")
	}
	// Mutation rollback preserves prior enabled state; application never automatically enables.
	tx, e = db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	_, e = tx.Exec(ctx, "UPDATE ld_accounts SET enabled=false WHERE account_id=$1", a)
	if e != nil {
		t.Fatal(e)
	}
	if tx.Rollback(ctx) != nil {
		t.Fatal("rollback")
	}
	if _, ss, e := s.login(ctx, loginA, v[0].Password); e != nil || ss == nil {
		t.Fatal("rollback changed account")
	}
	var unicodeVector struct{ Password, Hash string }
	raw, e = os.ReadFile("testdata/imported-unicode-credential.json")
	if e != nil || json.Unmarshal(raw, &unicodeVector) != nil {
		t.Fatal("imported Unicode vector absent")
	}
	mustExec("UPDATE ld_accounts SET password_hash=$2 WHERE account_id=$1", a, unicodeVector.Hash)
	if _, ss, e := s.login(ctx, loginA, unicodeVector.Password); e != nil || ss == nil {
		t.Fatal("valid 90-code-point imported credential rejected")
	}
	t.Log("Actual PostgreSQL: two A sessions, B isolation, CSRF/origin/limits/unsupported controls, disabled-source truth, account lock ordering, revocation, enable non-resurrection and rollback passed")
}
