package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSavedSetCanonicalIntent(t *testing.T) {
	id, a, b := newID("LD-"), newID("RUN-"), newID("RUN-")
	input := []savedSetMember{{id, []string{b, a}}}
	_, one, e := canonicalSavedSet(input)
	if e != nil {
		t.Fatal(e)
	}
	_, two, e := canonicalSavedSet([]savedSetMember{{id, []string{a, b}}})
	if e != nil || one != two || input[0].RunIDs[0] != b {
		t.Fatal("association order/caller mutation")
	}
	for _, v := range [][]savedSetMember{nil, {{"bad", []string{a}}}, {{id, nil}}, {{id, []string{a, a}}}, {{id, []string{"bad"}}}, {{id, []string{a}}, {id, []string{b}}}} {
		if _, _, e = canonicalSavedSet(v); e == nil {
			t.Fatal("invalid intent accepted")
		}
	}
	many := []savedSetMember{}
	for n := 0; n < 100; n++ {
		runs := []string{}
		for r := 0; r < 10; r++ {
			runs = append(runs, newID("RUN-"))
		}
		many = append(many, savedSetMember{newID("LD-"), runs})
	}
	if _, _, e = canonicalSavedSet(many); e != nil {
		t.Fatal("bounded100/1000", e)
	}
	wire, _ := json.Marshal(map[string]any{"requestID": newUUID(), "scopeKind": "saved_set", "members": many, "format": "pdf"})
	if len(wire) <= 16384 {
		t.Fatal("maximum body must expose previous 16KiB rejection")
	}
	var decoded struct {
		RequestID, ScopeKind, Format string
		Members                      []savedSetMember
	}
	if !decodeBounded(httptest.NewRecorder(), httptest.NewRequest("POST", "/", bytes.NewReader(wire)), &decoded, 128*1024) || len(decoded.Members) != 100 {
		t.Fatal("maximum canonical wire body rejected")
	}
	for _, body := range [][]byte{append(bytes.Repeat([]byte(" "), 128*1024), wire...), append(slices.Clone(wire), []byte("{}")...)} {
		if decodeBounded(httptest.NewRecorder(), httptest.NewRequest("POST", "/", bytes.NewReader(body)), &decoded, 128*1024) {
			t.Fatal("oversize or concatenated body accepted")
		}
	}
	many[0].RunIDs = append(many[0].RunIDs, newID("RUN-"))
	if _, _, e = canonicalSavedSet(many); e == nil {
		t.Fatal("1001 associations accepted")
	}
}

func TestSavedSetActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Dedicated actual PostgreSQL not configured")
	}
	raw, e := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if e != nil {
		t.Fatal("protected test config")
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
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
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
	if db.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables) != nil {
		t.Fatal("schema")
	}
	if tables == 0 {
		must(nativeSchema)
	}
	migration := func(rollback, commit bool) error {
		tx, e := db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(724913010)"); e != nil {
			return e
		}
		if e = migrateMultirun(ctx, tx, rollback); e != nil {
			return e
		}
		if commit {
			return tx.Commit(ctx)
		}
		return nil
	}
	if e = migration(false, false); e != nil {
		t.Fatal(e)
	}
	var version int
	db.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version)
	if version != 3 {
		t.Fatal("uncommitted migration escaped")
	}
	if e = migration(false, true); e != nil {
		t.Fatal(e)
	}
	if e = migration(true, true); e != nil {
		t.Fatal("empty rollback", e)
	}
	if e = migration(false, true); e != nil {
		t.Fatal(e)
	}
	account, other, lib, foreign := newUUID(), newUUID(), newUUID(), newUUID()
	runs := []string{newID("RUN-"), newID("RUN-"), newID("RUN-")}
	must("INSERT INTO ld_accounts VALUES($1,$2,'unused',true),($3,$4,'unused',true)", account, "synthetic-set-"+account, other, "synthetic-set-"+other)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC SET',true),($3,$4,'SYNTHETIC FOREIGN',true)", lib, account, foreign, other)
	defer func() {
		for _, table := range []string{"native_plan_commands", "native_plan_items", "native_items", "native_batches", "native_plans", "native_originals", "ld_results", "ld_jobs", "ld_runs", "ld_records"} {
			must("DELETE FROM "+table+" WHERE library_id=$1", lib)
		}
		must("DELETE FROM ld_sessions WHERE account_id IN ($1,$2)", account, other)
		must("DELETE FROM ld_libraries WHERE library_id IN ($1,$2)", lib, foreign)
		must("DELETE FROM ld_accounts WHERE account_id IN ($1,$2)", account, other)
		if e := migration(true, true); e != nil {
			t.Error("return test database to schema3", e)
		}
	}()
	for n, r := range runs {
		must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state) VALUES($1,$2,$3,$4,14,100,'partial')", lib, r, fmt.Sprintf("SYNTHETIC query%d 醫學", n), 25001+n)
	}
	selected := []savedSetMember{}
	hashes := []string{}
	for n := 0; n < 14; n++ {
		id := newID("LD-")
		article := syntheticArticle()
		article["SearchId"] = id
		article["Title"] = "SYNTHETIC multi-run \"資料\""
		if n >= 3 {
			article["Pmcid"] = ""
		}
		metadata, _ := json.Marshal(article)
		must("INSERT INTO ld_records VALUES($1,$2,$3,'SYNTHETIC')", lib, id, string(metadata))
		run := runs[n%3]
		must("INSERT INTO ld_results VALUES($1,$2,$3,$4)", lib, run, id, n+1)
		selected = append(selected, savedSetMember{id, []string{run}})
		if n < 3 {
			body := syntheticPDF("same original")
			if n == 2 {
				body = syntheticPDF("distinct deposit2")
			}
			proof := syntheticPDFProof(t, body, article)
			if n == 2 {
				proof.Listing = bytes.ReplaceAll(proof.Listing, []byte(".1"), []byte(".2"))
				proof.Metadata = bytes.ReplaceAll(proof.Metadata, []byte(".1"), []byte(".2"))
				proof.Metadata = bytes.ReplaceAll(proof.Metadata, []byte(`"version":1`), []byte(`"version":2`))
			}
			info, e := validatePDF(body, proofBytes(proof), article)
			if e != nil {
				t.Fatal(e)
			}
			hashes = append(hashes, info.Hash)
			must("INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy,format,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pdf',$9)", lib, id, info.Hash, body, info.Source, info.Rights, info.Stamp, pdfPolicy, proofBytes(proof))
		}
	}
	must("INSERT INTO ld_results VALUES($1,$2,$3,99)", lib, runs[1], selected[0].SearchID)
	selected[0].RunIDs = append(selected[0].RunIDs, runs[1])
	var calls atomic.Int32
	s := &server{db: db, native: true, cfg: config{LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour), PlanEnabled: true, SavedSetEnabled: true, PDFEnabled: true, AcquisitionEnabled: true}, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{Transport: nativeTransport(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("No external traffic allowed")
	})}}
	t.Run("validation-and-atomic-source-insert", func(t *testing.T) {
		for _, m := range [][]savedSetMember{{{selected[0].SearchID, []string{newID("RUN-")}}}, {{newID("LD-"), []string{runs[0]}}}} {
			if _, e = s.queueSavedSet(ctx, lib, newUUID(), "pdf", m); e == nil {
				t.Fatal("missing pair")
			}
		}
		if _, e = s.queueSavedSet(ctx, foreign, newUUID(), "pdf", selected); e == nil {
			t.Fatal("foreign library")
		}
		must("CREATE FUNCTION synthetic_saved_set_fail() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic source insertion rollback''; END'")
		must("CREATE TRIGGER synthetic_saved_set_fail BEFORE INSERT ON native_plan_sources FOR EACH ROW EXECUTE FUNCTION synthetic_saved_set_fail()")
		_, err := s.queueSavedSet(ctx, lib, newUUID(), "pdf", selected)
		must("DROP TRIGGER synthetic_saved_set_fail ON native_plan_sources; DROP FUNCTION synthetic_saved_set_fail()")
		var n int
		db.QueryRow(ctx, "SELECT count(*) FROM native_plans WHERE library_id=$1", lib).Scan(&n)
		if err == nil || n != 0 {
			t.Fatal("partial admission survived", n)
		}
	})
	var receipt planReceipt
	requestID := newUUID()
	t.Run("concurrent-idempotency-and-ordered-intent", func(t *testing.T) {
		var wg sync.WaitGroup
		results := make(chan planReceipt, 8)
		errs := make(chan error, 8)
		for n := 0; n < 8; n++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r, e := s.queueSavedSet(ctx, lib, requestID, "pdf", selected)
				results <- r
				errs <- e
			}()
		}
		wg.Wait()
		close(results)
		close(errs)
		for e := range errs {
			if e != nil {
				t.Fatal(e)
			}
		}
		for r := range results {
			if receipt.PlanID != "" && receipt.PlanID != r.PlanID {
				t.Fatal("duplicate plan")
			}
			receipt = r
		}
		reversed := slices.Clone(selected)
		reversed[0], reversed[1] = reversed[1], reversed[0]
		if _, e = s.queueSavedSet(ctx, lib, requestID, "pdf", reversed); e == nil {
			t.Fatal("changed rank accepted")
		}
		changed := slices.Clone(selected)
		changed[0].RunIDs = []string{runs[0]}
		if _, e = s.queueSavedSet(ctx, lib, requestID, "pdf", changed); e == nil {
			t.Fatal("changed provenance accepted")
		}
		if _, e = s.queueSavedSet(ctx, lib, requestID, "xml", selected); e == nil {
			t.Fatal("changed format accepted")
		}
		if e = migration(true, true); e == nil {
			t.Fatal("populated rollback deleted/reinterpreted data")
		}
	})
	t.Run("frozen-provenance-worker-reopen-and-original-associations", func(t *testing.T) {
		if _, e = s.controlPlan(ctx, lib, receipt.PlanID, newUUID(), "pause", 1); e != nil {
			t.Fatal(e)
		}
		if e = s.admitPlan(ctx); e != nil {
			t.Fatal(e)
		}
		var children int
		if e = db.QueryRow(ctx, "SELECT count(*) FROM native_batches WHERE library_id=$1 AND plan_id=$2", lib, receipt.PlanID).Scan(&children); e != nil || children != 0 {
			t.Fatal("paused saved set admitted children", e)
		}
		if _, e = s.controlPlan(ctx, lib, receipt.PlanID, newUUID(), "resume", 2); e != nil {
			t.Fatal(e)
		}
		var admission sync.WaitGroup
		failures := make(chan error, 4)
		for n := 0; n < 4; n++ {
			admission.Add(1)
			go func() { defer admission.Done(); failures <- s.admitPlan(ctx) }()
		}
		admission.Wait()
		close(failures)
		for err := range failures {
			if err != nil {
				t.Fatal(err)
			}
		}
		if e = db.QueryRow(ctx, "SELECT count(*) FROM native_batches WHERE library_id=$1 AND plan_id=$2", lib, receipt.PlanID).Scan(&children); e != nil || children != 1 {
			t.Fatal("concurrent saved-set duplicate children", e)
		}
		// Later genuine database association must not expand the saved intent.
		must("INSERT INTO ld_results VALUES($1,$2,$3,98)", lib, runs[2], selected[0].SearchID)
		for n := 0; n < 16; n++ {
			if e = s.admitPlan(ctx); e != nil {
				t.Fatal(e)
			}
			s.batchOne(ctx)
		}
		if calls.Load() != 0 {
			t.Fatal("unexpected source traffic")
		}
		s.cfg.SavedSetEnabled = false // Existing saved work remains readable and replayable.
		r, e := s.queueSavedSet(ctx, lib, requestID, "pdf", selected)
		if e != nil || r.PlanID != receipt.PlanID {
			t.Fatal("disabled replay")
		}
		jsonBytes, e := s.exportPlan(ctx, lib, receipt.PlanID, "json")
		if e != nil {
			t.Fatal(e)
		}
		var d planExportDocument
		if json.Unmarshal(jsonBytes, &d) != nil {
			t.Fatal("JSON")
		}
		expected := slices.Clone(selected[0].RunIDs)
		slices.Sort(expected)
		if d.Plan.RunID != "" || d.Plan.ScopeKind != "saved_set" || len(d.Plan.SourceRunIDs) != 3 || len(d.Items) != 14 || !slices.Equal(d.Research.Records[0].RunIDs, expected) || d.Research.Counts.Provider != nil || d.Plan.Counts["completed"] != 3 || d.Plan.Counts["held"] != 11 {
			t.Fatal("incorrect provenance/counts", d.Plan)
		}
		archive, e := s.exportPlan(ctx, lib, receipt.PlanID, "zip")
		if e != nil {
			t.Fatal(e)
		}
		z, e := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if e != nil || len(z.File) != 4 {
			t.Fatal("dedup archive", e)
		}
		if dir := os.Getenv("NATIVE_MULTIRUN_TEST_OUTPUT"); dir != "" {
			if e = os.MkdirAll(dir, 0700); e != nil {
				t.Fatal(e)
			}
			intent, err := json.Marshal(selected)
			if err != nil {
				t.Fatal(err)
			}
			for name, b := range map[string][]byte{"saved-set.json": jsonBytes, "saved-set.zip": archive, "intent.json": intent} {
				if e = os.WriteFile(filepath.Join(dir, name), b, 0600); e != nil {
					t.Fatal(e)
				}
			}
		}
		if hashes[0] != hashes[1] || hashes[1] == hashes[2] {
			t.Fatal("fixture must distinguish dedup/versions")
		}
	})
	t.Run("native-http-tenant-csrf-and-revocation", func(t *testing.T) {
		token, foreignToken, csrf := randomToken(), randomToken(), randomToken()
		must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1hour'),($4,$5,$3,now()+interval '1hour')", digest(token), account, csrf, digest(foreignToken), other)
		path := "/api/libraries/" + lib + "/plans/" + receipt.PlanID + "/exports"
		invoke := func(tok, anti string) int {
			r := httptest.NewRequest("POST", path, strings.NewReader(`{"format":"json"}`))
			r.Host = "127.0.0.1:18089"
			r.Header.Set("Origin", s.cfg.Origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF", anti)
			r.AddCookie(&http.Cookie{Name: "LitraDockTest", Value: tok})
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			return w.Code
		}
		if invoke(token, csrf) != 200 || invoke(token, "") != 403 || invoke(foreignToken, csrf) != 404 {
			t.Fatal("tenant/CSRF")
		}
		s.cfg.SavedSetEnabled = true
		for _, c := range []struct {
			body string
			want int
		}{
			{`{"requestID":"` + newUUID() + `","scopeKind":"saved_set","members":[],"format":"pdf"}`, 400},
			{`{"requestID":"` + newUUID() + `","scopeKind":"saved_set","runID":"` + runs[0] + `","members":[],"format":"pdf"}`, 400},
			{`{"scopeKind":"unknown","members":[]}`, 400},
		} {
			r := httptest.NewRequest("POST", "/api/libraries/"+lib+"/plans", strings.NewReader(c.body))
			r.Host = "127.0.0.1:18089"
			r.Header.Set("Origin", s.cfg.Origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF", csrf)
			r.AddCookie(&http.Cookie{Name: "LitraDockTest", Value: token})
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != c.want {
				t.Fatal("wire validation", w.Code)
			}
		}
		t.Run("maximum-through-authenticated-http", func(t *testing.T) {
			// Isolated workload: 100 saved records in ten actual synthetic run rows.
			ids, sourceRuns := []string{}, []string{}
			for n := 0; n < 100; n++ {
				ids = append(ids, newID("LD-"))
			}
			for n := 0; n < 10; n++ {
				sourceRuns = append(sourceRuns, newID("RUN-"))
			}
			must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state) SELECT $1,id,'SYNTHETIC upper-bound workload',25001,100,100,'partial' FROM unnest($2::text[]) id", lib, sourceRuns)
			must("INSERT INTO ld_records SELECT $1,id,json_build_object('SearchId',id,'Title','SYNTHETIC upper-bound workload')::text,'SYNTHETIC' FROM unnest($2::text[]) id", lib, ids)
			must("INSERT INTO ld_results SELECT $1,r.run,id.search_id,id.rank FROM unnest($2::text[]) WITH ORDINALITY id(search_id,rank) CROSS JOIN unnest($3::text[]) r(run)", lib, ids, sourceRuns)
			members := []savedSetMember{}
			for _, id := range ids {
				members = append(members, savedSetMember{id, sourceRuns})
			}
			wire, _ := json.Marshal(map[string]any{"requestID": newUUID(), "scopeKind": "saved_set", "members": members, "format": "pdf"})
			invokeAdmission := func(body []byte) *httptest.ResponseRecorder {
				r := httptest.NewRequest("POST", "/api/libraries/"+lib+"/plans", bytes.NewReader(body))
				r.Host = "127.0.0.1:18089"
				r.Header.Set("Origin", s.cfg.Origin)
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("X-CSRF", csrf)
				r.AddCookie(&http.Cookie{Name: "LitraDockTest", Value: token})
				w := httptest.NewRecorder()
				s.ServeHTTP(w, r)
				return w
			}
			w := invokeAdmission(wire)
			var bound planReceipt
			if len(wire) <= 16384 || w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &bound) != nil || bound.SelectedCount != 100 {
				t.Fatal("maximum HTTP admission", len(wire), w.Code, w.Body.String())
			}
			var pairs int
			if err := db.QueryRow(ctx, "SELECT count(*) FROM native_plan_sources WHERE library_id=$1 AND plan_id=$2", lib, bound.PlanID).Scan(&pairs); err != nil || pairs != 1000 {
				t.Fatal("maximum durable membership", pairs, err)
			}
			if invokeAdmission(append(bytes.Repeat([]byte(" "), 128*1024), wire...)).Code != 400 {
				t.Fatal("oversize authenticated admission")
			}
			members[0].RunIDs = append(slices.Clone(sourceRuns), newID("RUN-"))
			tooMany, _ := json.Marshal(map[string]any{"requestID": newUUID(), "scopeKind": "saved_set", "members": members, "format": "pdf"})
			if invokeAdmission(tooMany).Code != 400 {
				t.Fatal("1001 associations admitted")
			}
			if _, err := s.controlPlan(ctx, lib, bound.PlanID, newUUID(), "cancel", 1); err != nil {
				t.Fatal(err)
			}
		})
		must("DELETE FROM ld_sessions WHERE token_hash=$1", digest(token))
		if invoke(token, csrf) != 401 {
			t.Fatal("revoked session")
		}
	})
}
