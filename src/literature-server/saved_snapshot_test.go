package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Entire workload is synthetic and isolated. Never writes to a public database.
func TestSavedSnapshotActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Dedicated actual PostgreSQL not configured")
	}
	raw, e := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if e != nil {
		t.Fatal(e)
	}
	var cfg config
	if json.Unmarshal(raw, &cfg) != nil {
		t.Fatal("config")
	}
	pc, e := pgxpool.ParseConfig(cfg.Database)
	if e != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_test_") {
		t.Fatal("dedicated test database required")
	}
	pc.MaxConns = 12
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	db, e := pgxpool.NewWithConfig(ctx, pc)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	must := func(q string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	var tables int
	if e = db.QueryRow(ctx, "SELECT count(*) FROM pg_tables WHERE schemaname='public'").Scan(&tables); e != nil {
		t.Fatal(e)
	}
	if tables == 0 {
		must(nativeSchema)
	}
	migration := func(fn func(context.Context, pgx.Tx, bool) error, rollback, commit bool) error {
		tx, e := db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		if e = fn(ctx, tx, rollback); e != nil {
			return e
		}
		if commit {
			return tx.Commit(ctx)
		}
		return nil
	}
	for _, fn := range []func(context.Context, pgx.Tx, bool) error{migrateMultirun, migrateContinuation, migrateBundles} {
		if e = migration(fn, false, true); e != nil {
			t.Fatal(e)
		}
	}
	if e = migration(migrateSavedSnapshots, false, false); e != nil {
		t.Fatal(e)
	}
	var version int
	db.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version)
	if version != 6 {
		t.Fatal("aborted migration escaped")
	}
	if e = migration(migrateSavedSnapshots, false, true); e != nil {
		t.Fatal(e)
	}
	if e = migration(migrateSavedSnapshots, true, true); e != nil {
		t.Fatal(e)
	}
	if e = migration(migrateSavedSnapshots, false, true); e != nil {
		t.Fatal(e)
	}
	account, other, library, foreign := newUUID(), newUUID(), newUUID(), newUUID()
	runs := []string{newID("RUN-"), newID("RUN-")}
	must("INSERT INTO ld_accounts VALUES($1,$2,'unused',true),($3,$4,'unused',true)", account, "SYNTHETIC-"+account, other, "SYNTHETIC-"+other)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC SNAPSHOTS',true),($3,$4,'SYNTHETIC FOREIGN',true)", library, account, foreign, other)
	defer func() {
		for _, table := range []string{"native_bundles", "native_research_snapshots", "native_plan_sources", "native_plan_commands", "native_plan_items", "native_items", "native_batches", "native_plans", "native_originals", "ld_results", "ld_jobs", "ld_runs", "ld_records"} {
			must("DELETE FROM "+table+" WHERE library_id=$1", library)
		}
		must("DELETE FROM ld_sessions WHERE account_id IN ($1,$2)", account, other)
		must("DELETE FROM ld_libraries WHERE library_id IN ($1,$2)", library, foreign)
		must("DELETE FROM ld_accounts WHERE account_id IN ($1,$2)", account, other)
		for _, fn := range []func(context.Context, pgx.Tx, bool) error{migrateSavedSnapshots, migrateBundles, migrateContinuation, migrateMultirun} {
			if e := migration(fn, true, true); e != nil {
				t.Error(e)
			}
		}
	}()
	for _, r := range runs {
		must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state) VALUES($1,$2,'SYNTHETIC 醫學 Boolean',25001,12,100,'partial')", library, r)
	}
	members := []savedSetMember{}
	hashes := []string{}
	for n := 0; n < 12; n++ {
		id := newID("LD-")
		a := syntheticArticle()
		a["SearchId"] = id
		a["Title"] = "SYNTHETIC 醫學\n\"study\""
		if n >= 3 {
			a["Pmid"] = "0001234567890123456789"
		}
		a["Abstract"] = "SYNTHETIC multiline abstract\n資料 with quotes \"α\""
		a["Journal"] = "SYNTHETIC Medical Journal"
		if n >= 3 {
			a["Pmcid"] = ""
		}
		b, _ := json.Marshal(a)
		must("INSERT INTO ld_records VALUES($1,$2,$3,'SYNTHETIC')", library, id, string(b))
		must("INSERT INTO ld_results VALUES($1,$2,$3,$4)", library, runs[n%2], id, n+1)
		members = append(members, savedSetMember{id, []string{runs[n%2]}})
		if n < 3 {
			body := syntheticPDF("same bytes")
			if n == 2 {
				body = syntheticPDF("distinct bytes")
			}
			proof := syntheticPDFProof(t, body, a)
			info, e := validatePDF(body, proofBytes(proof), a)
			if e != nil {
				t.Fatal(e)
			}
			hashes = append(hashes, info.Hash)
			must("INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy,format,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pdf',$9)", library, id, info.Hash, body, info.Source, info.Rights, info.Stamp, pdfPolicy, proofBytes(proof))
		}
	}
	var calls atomic.Int32
	s := &server{db: db, native: true, savedSnapshots: true, bundles: true, cfg: config{LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour), SavedSetEnabled: true, PDFEnabled: true, AcquisitionEnabled: true, BundleDeliveryEnabled: true}, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{Transport: nativeTransport(func(*http.Request) (*http.Response, error) { calls.Add(1); return nil, fmt.Errorf("source prohibited") })}}
	countWork := func() string {
		var x string
		e := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM native_batches)::text||':'||(SELECT count(*) FROM native_items)::text||':'||(SELECT count(*) FROM ld_jobs)::text||':'||(SELECT COALESCE(sum(requests),0) FROM ld_source_usage)::text`).Scan(&x)
		if e != nil {
			t.Fatal(e)
		}
		return x
	}
	before := countWork()
	// Fail at the final document insert: header, ordered members and provenance
	// must all roll back, not merely fail before mutation starts.
	must(`CREATE FUNCTION synthetic_snapshot_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC final-write abort'; END $$;
 CREATE TRIGGER synthetic_snapshot_abort BEFORE INSERT ON native_research_snapshots FOR EACH ROW EXECUTE FUNCTION synthetic_snapshot_abort()`)
	failedRequest := newUUID()
	if _, e = s.saveResearchSnapshot(ctx, library, failedRequest, "pdf", members); e == nil {
		t.Fatal("injected final-write failure accepted")
	}
	var residue int
	if e = db.QueryRow(ctx, "SELECT count(*) FROM native_plans WHERE library_id=$1 AND request_id=$2", library, failedRequest).Scan(&residue); e != nil || residue != 0 {
		t.Fatal("partial snapshot escaped rollback", e)
	}
	must("DROP TRIGGER synthetic_snapshot_abort ON native_research_snapshots; DROP FUNCTION synthetic_snapshot_abort()")
	request := newUUID()
	results := make(chan planReceipt, 2)
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for n := 0; n < 2; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := s.saveResearchSnapshot(ctx, library, request, "pdf", members)
			results <- r
			errs <- e
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal("concurrent identical intent", e)
		}
	}
	var saved planReceipt
	for r := range results {
		if saved.PlanID != "" && saved.PlanID != r.PlanID {
			t.Fatal("duplicate snapshot")
		}
		saved = r
	}
	if saved.State != "saved_snapshot" || saved.SelectedCount != 12 || saved.AffectedCount != 0 {
		t.Fatal(saved)
	}
	for _, m := range [][]savedSetMember{{members[1], members[0]}, {{members[0].SearchID, []string{runs[1]}}}} {
		if _, e = s.saveResearchSnapshot(ctx, library, request, "pdf", m); e == nil {
			t.Fatal("changed intent accepted")
		}
	}
	if _, e = s.saveResearchSnapshot(ctx, foreign, newUUID(), "pdf", members); e == nil {
		t.Fatal("foreign selection accepted")
	}
	if _, e = s.saveResearchSnapshot(ctx, library, newUUID(), "pdf", []savedSetMember{{members[0].SearchID, []string{runs[1]}}}); e == nil {
		t.Fatal("wrong run accepted")
	}
	cancelled, stop := context.WithCancel(ctx)
	stop()
	if _, e = s.saveResearchSnapshot(cancelled, library, newUUID(), "pdf", members); e == nil {
		t.Fatal("cancelled transaction admitted")
	}
	if e = migration(migrateSavedSnapshots, true, true); e == nil {
		t.Fatal("occupied downgrade accepted")
	}
	for _, action := range []string{"resume", "pause", "cancel", "retry"} {
		if _, e = s.controlPlan(ctx, library, saved.PlanID, newUUID(), action, 1); e == nil {
			t.Fatal("snapshot can enter scheduler", action)
		}
	}
	s.cfg.PlanEnabled = true
	if e = s.admitPlan(ctx); e != nil {
		t.Fatal("scheduler", e)
	}
	if countWork() != before || calls.Load() != 0 {
		t.Fatal("snapshot scheduled source work")
	}
	data, e := s.snapshotMetadata(ctx, library, saved.PlanID, "json")
	if e != nil {
		t.Fatal(e)
	}
	var d structuredDocument
	if json.Unmarshal(data, &d) != nil || len(d.Records) != 12 || d.Counts.Provider != nil || len(d.Queries) != 2 {
		t.Fatal("count/provenance")
	}
	if d.Records[3].IDs.PMID == nil || *d.Records[3].IDs.PMID != "0001234567890123456789" {
		t.Fatal("identifier loss")
	}
	must("UPDATE ld_records SET metadata=jsonb_set(metadata::jsonb,'{Title}','\"SYNTHETIC later title\"')::text WHERE library_id=$1", library)
	again, e := s.snapshotMetadata(ctx, library, saved.PlanID, "json")
	if e != nil || !bytes.Equal(data, again) {
		t.Fatal("snapshot drift", e)
	}
	zipData, e := s.exportPlan(ctx, library, saved.PlanID, "zip")
	if e != nil {
		t.Fatal(e)
	}
	z, e := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if e != nil {
		t.Fatal(e)
	}
	originals := 0
	var manifest planExportDocument
	for _, f := range z.File {
		r, e := f.Open()
		if e != nil {
			t.Fatal(e)
		}
		b, e := io.ReadAll(r)
		r.Close()
		if e != nil {
			t.Fatal(e)
		}
		if strings.HasPrefix(f.Name, "originals/") {
			originals++
			if f.Name != "originals/"+bundleDigest(b)+".pdf" {
				t.Fatal("changed original")
			}
		}
		if f.Name == "manifest.json" {
			if json.Unmarshal(b, &manifest) != nil {
				t.Fatal("manifest")
			}
		}
	}
	if originals != 2 || *manifest.Counts.Included != 3 || *manifest.Counts.Unresolved != 9 || len(manifest.Items) != 12 {
		t.Fatal("dedup/member loss", originals, manifest.Counts)
	}
	for n, i := range manifest.Items {
		if i.SearchID != members[n].SearchID || i.ChildBatchID != nil {
			t.Fatal("order/children")
		}
	}
	for _, format := range []string{"jsonl", "csv", "xlsx"} {
		b, e := s.snapshotMetadata(ctx, library, saved.PlanID, format)
		if e != nil || len(b) == 0 {
			t.Fatal(format, e)
		}
		if dir := os.Getenv("NATIVE_SNAPSHOT_TEST_OUTPUT"); dir != "" {
			os.MkdirAll(dir, 0700)
			if e = os.WriteFile(filepath.Join(dir, "snapshot."+format), b, 0600); e != nil {
				t.Fatal(e)
			}
		}
	}
	if dir := os.Getenv("NATIVE_SNAPSHOT_TEST_OUTPUT"); dir != "" {
		os.WriteFile(filepath.Join(dir, "snapshot.json"), data, 0600)
		os.WriteFile(filepath.Join(dir, "snapshot.zip"), zipData, 0600)
	}
	// Current grant invalidation suppresses a pinned original without removing a member.
	s.cfg.BlockedPMCIDs = []string{articleString(syntheticArticle(), "Pmcid")}
	denied, e := s.exportPlan(ctx, library, saved.PlanID, "zip")
	if e != nil {
		t.Fatal(e)
	}
	dz, _ := zip.NewReader(bytes.NewReader(denied), int64(len(denied)))
	for _, f := range dz.File {
		if strings.HasPrefix(f.Name, "originals/") {
			t.Fatal("changed rights escaped")
		}
	}
	s.cfg.BlockedPMCIDs = nil
	for _, fn := range []func() error{func() error { _, e := s.planDetail(ctx, foreign, saved.PlanID, 0, 25); return e }, func() error { _, e := s.snapshotMetadata(ctx, foreign, saved.PlanID, "json"); return e }, func() error { _, e := s.exportPlan(ctx, foreign, saved.PlanID, "zip"); return e }} {
		if fn() == nil {
			t.Fatal("foreign export")
		}
	}
	token, csrf := strings.Repeat("a", 64), "synthetic-csrf"
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", digest(token), account, csrf)
	requestHTTP := func(csrfValue, origin string) int {
		body, _ := json.Marshal(map[string]any{"requestID": newUUID(), "scopeKind": "saved_snapshot", "format": "pdf", "members": members})
		r := httptest.NewRequest("POST", s.cfg.Origin+"/api/libraries/"+library+"/plans", bytes.NewReader(body))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF", csrfValue)
		r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: token})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	if code := requestHTTP("", s.cfg.Origin); code != 403 {
		t.Fatal("CSRF", code)
	}
	if code := requestHTTP(csrf, "https://wrong.invalid"); code != 403 {
		t.Fatal("origin with valid CSRF", code)
	}
	must("DELETE FROM ld_sessions WHERE account_id=$1", account)
	if code := requestHTTP(csrf, s.cfg.Origin); code != 401 {
		t.Fatal("revoked session", code)
	}
	// Authentication succeeded before a capacity wait, then logout revoked it.
	// The committing transaction must revalidate after that wait.
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", digest(token), account, csrf)
	lock, e := db.Acquire(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = lock.Exec(ctx, "SELECT pg_advisory_lock(724913015)"); e != nil {
		t.Fatal(e)
	}
	lateCtx := context.WithValue(ctx, snapshotSessionKey{}, &session{Hash: digest(token), Account: account, CSRF: csrf})
	late := make(chan error, 1)
	go func() { _, e := s.saveResearchSnapshot(lateCtx, library, newUUID(), "pdf", members); late <- e }()
	waiting := false
	for until := time.Now().Add(3 * time.Second); time.Now().Before(until); {
		if e = db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=724913015 AND NOT granted)").Scan(&waiting); e != nil {
			t.Fatal(e)
		}
		if waiting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waiting {
		t.Fatal("late-session schedule not established")
	}
	must("DELETE FROM ld_sessions WHERE account_id=$1", account)
	if _, e = lock.Exec(ctx, "SELECT pg_advisory_unlock(724913015)"); e != nil {
		t.Fatal(e)
	}
	lock.Release()
	if e = <-late; e == nil {
		t.Fatal("revoked session committed after capacity wait")
	}
	for _, revoke := range []bool{false, true} {
		must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour') ON CONFLICT(token_hash) DO NOTHING", digest(token), account, csrf)
		blocker, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = blocker.Exec(ctx, "LOCK native_research_snapshots IN ACCESS EXCLUSIVE MODE"); e != nil {
			t.Fatal(e)
		}
		response := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			r := httptest.NewRequest("POST", s.cfg.Origin+"/api/libraries/"+library+"/plans/"+saved.PlanID+"/metadata", strings.NewReader(`{"format":"json"}`))
			r.Header.Set("Origin", s.cfg.Origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF", csrf)
			r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: token})
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			response <- w
		}()
		waiting = false
		for until := time.Now().Add(3 * time.Second); time.Now().Before(until); {
			if e = db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='native_research_snapshots'::regclass AND NOT granted)").Scan(&waiting); e != nil {
				t.Fatal(e)
			}
			if waiting {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !waiting {
			t.Fatal("export table-wait schedule not established")
		}
		if revoke {
			must("DELETE FROM ld_sessions WHERE account_id=$1", account)
		}
		if e = blocker.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		w := <-response
		if revoke {
			if w.Code != 401 || w.Header().Get("Content-Disposition") != "" {
				t.Fatal("late revoked export escaped", w.Code)
			}
		} else {
			if w.Code != 200 || w.Header().Get("Content-Disposition") == "" {
				t.Fatal("positive export control", w.Code)
			}
		}
	}
	if countWork() != before || calls.Load() != 0 {
		t.Fatal("export/reopen changed source work")
	}
	t.Log("SYNTHETIC actual PostgreSQL: 12 records, 2 runs, 3 original associations, 2 unique files, 9 held; concurrent replay, conflicts, frozen metadata, source-zero, foreign/CSRF/revocation, occupied rollback denied")
}
