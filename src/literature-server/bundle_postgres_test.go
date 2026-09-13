package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
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
)

func TestBundleActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Dedicated actual PostgreSQL not configured")
	}
	raw, e := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if e != nil {
		t.Fatal("protected config missing")
	}
	var cfg config
	if json.Unmarshal(raw, &cfg) != nil {
		t.Fatal("config")
	}
	pc, e := pgxpool.ParseConfig(cfg.Database)
	if e != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_test_") {
		t.Fatal("dedicated database required")
	}
	pc.MaxConns = 8
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	root, e := pgxpool.NewWithConfig(ctx, pc)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	schema := "bundle_" + strings.ReplaceAll(newUUID(), "-", "")
	if _, e = root.Exec(ctx, "CREATE SCHEMA "+schema); e != nil {
		t.Fatal(e)
	}
	defer func() {
		if _, e := root.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); e != nil {
			t.Error(e)
		}
	}()
	pc.ConnConfig.RuntimeParams["search_path"] = schema
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
	must(nativeSchema)
	must(multirunSchema)
	must(continuationSchema)
	must(bundleSchema)
	migration, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = migrateBundles(ctx, migration, true); e != nil {
		t.Fatal(e)
	}
	if e = migration.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	migration, e = db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = migrateBundles(ctx, migration, false); e != nil {
		t.Fatal(e)
	}
	if e = migration.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	a, b, lib, foreign, run, plan := newUUID(), newUUID(), newUUID(), newUUID(), newID("RUN-"), newID("PLN-")
	must("INSERT INTO ld_accounts VALUES($1,$2,'unused',true),($3,$4,'unused',true)", a, "synthetic-plan-export-"+a, b, "synthetic-plan-export-"+b)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC plan export',true),($3,$4,'SYNTHETIC foreign',true)", lib, a, foreign, b)
	must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state,reason) VALUES($1,$2,$3,25001,100,100,'partial','Retrieval cap')", lib, run, "SYNTHETIC 醫學 AND العربية\n\"quoted\"")
	must("INSERT INTO native_plans(library_id,plan_id,run_id,request_id,selection,receipt,requested_format) VALUES($1,$2,$3,$4,'synthetic','{}','pdf')", lib, plan, run, newUUID())
	children := []string{newID("BAT-"), newID("BAT-")}
	for _, child := range children {
		must("INSERT INTO native_batches(library_id,batch_id,request_id,selection,state,requested_format,plan_id) VALUES($1,$2,$3,'synthetic','complete','pdf',$4)", lib, child, newUUID(), plan)
	}
	ids := []string{}
	for n := 0; n < 100; n++ {
		id := newID("LD-")
		ids = append(ids, id)
		article := syntheticArticle()
		article["SearchId"] = id
		article["Title"] = "SYNTHETIC 醫學 😀 \"quote\"\nline"
		article["Abstract"] = "=SUM(1,2)\n資料"
		article["password"] = "PRIVATE_PLAN_SENTINEL"
		metadata, _ := json.Marshal(article)
		must("INSERT INTO ld_records VALUES($1,$2,$3,'SYNTHETIC')", lib, id, string(metadata))
		must("INSERT INTO ld_results VALUES($1,$2,$3,$4)", lib, run, id, n+1)
		var child any
		state := "unavailable"
		reason := "Unknown rights; open source links"
		hash := ""
		if n < 20 {
			child = children[n/10]
		}
		if n < 9 {
			label := fmt.Sprint(n)
			if n == 1 {
				label = "0"
			}
			data := syntheticPDF(strings.Repeat("x", 5*1024*1024) + label)
			if n == 2 {
				data = syntheticPDF(strings.Repeat("y", 5*1024*1024) + "distinct deposit 2")
			}
			proof := syntheticPDFProof(t, data, article)
			if n == 2 {
				proof.Listing = bytes.ReplaceAll(proof.Listing, []byte(".1"), []byte(".2"))
				proof.Metadata = bytes.ReplaceAll(proof.Metadata, []byte(".1"), []byte(".2"))
				proof.Metadata = bytes.ReplaceAll(proof.Metadata, []byte(`"version":1`), []byte(`"version":2`))
			}
			info, e := validatePDF(data, proofBytes(proof), article)
			if e != nil {
				t.Fatal(e)
			}
			hash = info.Hash
			state = "acquired"
			reason = ""
			must("INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy,format,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pdf',$9)", lib, id, hash, data, info.Source, info.Rights, info.Stamp, pdfPolicy, proofBytes(proof))
		}
		if n == 40 {
			state = "transient"
			reason = "Source cooldown; explicit retry remains bounded"
		}
		if n == 41 {
			state = "cancelled"
			reason = "Cancelled"
		}
		if n == 42 {
			state = "running"
			reason = ""
		}
		if n == 43 {
			state = "queued"
		}
		if n == 44 {
			state = "failed"
		}
		if child != nil {
			must("INSERT INTO native_items(library_id,batch_id,search_id,rank,state,reason,original_hash) VALUES($1,$2,$3,$4,$5,$6,$7)", lib, child, id, n%10+1, state, reason, hash)
		}
		must("INSERT INTO native_plan_items(library_id,plan_id,search_id,rank,child_batch_id,cancelled) VALUES($1,$2,$3,$4,$5,$6)", lib, plan, id, n+1, child, n == 21)
	}
	var calls atomic.Int32
	s := &server{db: db, native: true, bundles: true, cfg: config{LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour), AcquisitionEnabled: true, PDFEnabled: true, PlanEnabled: true, BundleDeliveryEnabled: true}, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{Transport: nativeTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, fmt.Errorf("no provider permitted")
	})}}
	token, other, csrf := randomToken(), randomToken(), randomToken()
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour'),($4,$5,$3,now()+interval '1 hour')", digest(token), a, csrf, digest(other), b)

	request := func(method, path, credential, anti, body, rangeHeader, etag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Host = "127.0.0.1:18089"
		r.AddCookie(&http.Cookie{Name: "LitraDockTest", Value: credential})
		r.Header.Set("Origin", s.cfg.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF", anti)
		r.Header.Set("Range", rangeHeader)
		r.Header.Set("If-Match", etag)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	path := "/api/libraries/" + lib + "/plans/" + plan + "/bundles"
	uuid := newUUID()
	intent := `{"requestID":"` + uuid + `"}`
	bad := request("POST", path, other, csrf, intent, "", "")
	if bad.Code != 404 {
		t.Fatal("foreign", bad.Code)
	}
	bad = request("POST", path, token, "", intent, "", "")
	if bad.Code != 403 {
		t.Fatal("csrf", bad.Code)
	}
	bad = request("POST", path, token, csrf, `{"requestID":"bad"}`, "", "")
	if bad.Code != 400 {
		t.Fatal("uuid", bad.Code)
	}
	start := time.Now()
	w := request("POST", path, token, csrf, intent, "", "")
	if w.Code != 200 {
		t.Fatalf("prepare %d %s", w.Code, w.Body.String())
	}
	var d bundleDocument
	if json.Unmarshal(w.Body.Bytes(), &d) != nil {
		t.Fatal("document")
	}
	if len(d.Manifest.Items) != 100 || len(d.Parts) != 8 || *d.Manifest.Counts.Included != 9 || *d.Manifest.Counts.Unique != 8 || *d.Manifest.Counts.Bytes <= 32*1024*1024 {
		t.Fatal("count/partition loss", d.Manifest.Counts, len(d.Parts))
	}
	if strings.Contains(w.Body.String(), "PRIVATE_PLAN_SENTINEL") {
		t.Fatal("private metadata leak")
	}
	first := append([]byte(nil), w.Body.Bytes()...)
	if output := os.Getenv("NATIVE_BUNDLE_TEST_OUTPUT"); output != "" {
		if e = os.MkdirAll(output, 0700); e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(output, "bundle.json"), first, 0600); e != nil {
			t.Fatal(e)
		}
	}
	migration, e = db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = migrateBundles(ctx, migration, true); e == nil {
		t.Fatal("populated schema rollback accepted")
	}
	migration.Rollback(ctx)
	if _, e = s.exportPlan(ctx, lib, plan, "zip"); e == nil {
		t.Fatal("old whole archive cap silently changed")
	}
	// Concurrent same-UUID responses may explicitly defer for capacity, but never create another snapshot.
	var wg sync.WaitGroup
	for n := 0; n < 3; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, e := s.prepareBundle(ctx, lib, plan, uuid)
			if e == nil && v.SnapshotID != d.SnapshotID {
				t.Error("duplicate receipt")
			}
		}()
	}
	wg.Wait()
	var count int
	db.QueryRow(ctx, "SELECT count(*) FROM native_bundles").Scan(&count)
	if count != 1 {
		t.Fatal("duplicate snapshots", count)
	}
	s.cfg.BundleDeliveryEnabled = false
	w = request("POST", path, token, csrf, intent, "", "")
	if w.Code != 200 || !bytes.Equal(first, w.Body.Bytes()) {
		t.Fatal("disabled exact replay", w.Code)
	}
	s.cfg.BundleDeliveryEnabled = true
	_, e = s.prepareBundle(ctx, lib, newID("PLN-"), uuid)
	if e == nil {
		t.Fatal("altered plan replay")
	}
	// Saved results remain immutable across parent control/progress changes.
	must("UPDATE native_plans SET state='cancelled',revision=revision+1 WHERE library_id=$1 AND plan_id=$2", lib, plan)
	w = request("GET", path+"/"+d.SnapshotID, token, "", "", "", "")
	if w.Code != 200 || !bytes.Equal(first, w.Body.Bytes()) {
		t.Fatal("snapshot changed after plan cancellation")
	}
	savedTotal := 0
	for _, part := range d.Parts {
		url := path + "/" + d.SnapshotID + "/parts/" + fmt.Sprint(part.Number)
		full := request("GET", url, token, "", "", "", "")
		if full.Code != 200 || full.Body.Len() != part.Bytes || bundleDigest(full.Body.Bytes()) != part.SHA256 {
			t.Fatal("part", part.Number, full.Code, full.Body.String())
		}
		if output := os.Getenv("NATIVE_BUNDLE_TEST_OUTPUT"); output != "" {
			if e = os.WriteFile(filepath.Join(output, part.Filename), full.Body.Bytes(), 0600); e != nil {
				t.Fatal(e)
			}
		}
		z, e := zip.NewReader(bytes.NewReader(full.Body.Bytes()), int64(full.Body.Len()))
		if e != nil {
			t.Fatal(e)
		}
		originals := 0
		for _, f := range z.File {
			rd, e := f.Open()
			if e != nil {
				t.Fatal(e)
			}
			b, e := io.ReadAll(rd)
			rd.Close()
			if e != nil {
				t.Fatal("crc", e)
			}
			if f.Name != "manifest.json" {
				originals++
				if !strings.Contains(f.Name, bundleDigest(b)) {
					t.Fatal("original hash")
				}
			}
		}
		if originals != len(part.Files) {
			t.Fatal("part files")
		}
		savedTotal += originals
		if part.Number == 1 {
			split := part.Bytes / 2
			etag := full.Header().Get("ETag")
			left := request("GET", url, token, "", "", fmt.Sprintf("bytes=0-%d", split-1), etag)
			right := request("GET", url, token, "", "", fmt.Sprintf("bytes=%d-%d", split, part.Bytes-1), etag)
			combined := append(left.Body.Bytes(), right.Body.Bytes()...)
			if left.Code != 206 || right.Code != 206 || !bytes.Equal(combined, full.Body.Bytes()) {
				t.Fatal("range reassembly")
			}
			if request("GET", url, token, "", "", "bytes=0-99", "\"wrong\"").Code != 412 {
				t.Fatal("mismatched validator")
			}
			if request("GET", url, other, "", "", "", "").Code != 404 {
				t.Fatal("foreign part")
			}
		}
	}
	if savedTotal != 8 || calls.Load() != 0 {
		t.Fatal("silent duplicate/provider request", savedTotal, calls.Load())
	}
	// Hold original access after entry authentication, revoke, then release build.
	held, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = held.Exec(ctx, "LOCK TABLE native_originals IN ACCESS EXCLUSIVE MODE"); e != nil {
		t.Fatal(e)
	}
	late := make(chan *httptest.ResponseRecorder, 1)
	lateURL := path + "/" + d.SnapshotID + "/parts/1"
	go func() { late <- request("GET", lateURL, token, "", "", "", "") }()
	waiting := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if e = db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND pid IN (SELECT pid FROM pg_locks WHERE NOT granted AND relation='native_originals'::regclass))`).Scan(&waiting); e != nil {
			t.Fatal(e)
		}
		if waiting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waiting {
		held.Rollback(ctx)
		t.Fatal("original read did not reach actual post-auth lock")
	}
	must("DELETE FROM ld_sessions WHERE token_hash=$1", digest(token))
	if e = held.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	denied := <-late
	if denied.Code != 401 || denied.Header().Get("Content-Disposition") != "" || bytes.Contains(denied.Body.Bytes(), []byte("%PDF-")) {
		t.Fatal("late revoked response escaped", denied.Code)
	}
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", digest(token), a, csrf)
	// The lightweight list is private too: revoke while its actual DB read waits.
	for _, ownerChange := range []bool{false, true} {
		lock, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = lock.Exec(ctx, "LOCK TABLE native_bundles IN ACCESS EXCLUSIVE MODE"); e != nil {
			t.Fatal(e)
		}
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- request("GET", path, token, "", "", "", "") }()
		blocked := false
		until := time.Now().Add(3 * time.Second)
		for time.Now().Before(until) {
			if e = db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND relation='native_bundles'::regclass)`).Scan(&blocked); e != nil {
				t.Fatal(e)
			}
			if blocked {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !blocked {
			lock.Rollback(ctx)
			t.Fatal("list did not reach post-auth data lock")
		}
		want := 401
		if ownerChange {
			must("UPDATE ld_libraries SET owner_id=$2 WHERE library_id=$1", lib, b)
			want = 404
		} else {
			must("DELETE FROM ld_sessions WHERE token_hash=$1", digest(token))
		}
		if e = lock.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		got := <-done
		if got.Code != want || strings.Contains(got.Body.String(), d.SnapshotID) {
			t.Fatal("late list metadata escaped", got.Code, want)
		}
		if ownerChange {
			must("UPDATE ld_libraries SET owner_id=$2 WHERE library_id=$1", lib, a)
		} else {
			must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", digest(token), a, csrf)
		}
	}
	// One alias loses its grant: the old part must fail even when another alias has identical bytes.
	must("UPDATE native_originals SET rights_uri='https://invalid.example/' WHERE library_id=$1 AND search_id=$2", lib, ids[1])
	url := path + "/" + d.SnapshotID + "/parts/1"
	w = request("GET", url, token, "", "", "", "")
	if w.Code != 409 || w.Header().Get("Content-Disposition") != "" {
		t.Fatal("dedup transferred a grant", w.Code)
	}
	must("UPDATE native_originals SET rights_uri='https://creativecommons.org/licenses/by/4.0/' WHERE library_id=$1 AND search_id=$2", lib, ids[1])
	must("UPDATE native_originals SET content='bad'::bytea WHERE library_id=$1 AND search_id=$2", lib, ids[0])
	w = request("GET", url, token, "", "", "", "")
	if w.Code != 409 {
		t.Fatal("corrupt original", w.Code)
	}
	// Restore the exact valid original before independent metadata-budget controls.
	must("UPDATE native_originals SET content=$3 WHERE library_id=$1 AND search_id=$2", lib, ids[0], syntheticPDF(strings.Repeat("x", 5*1024*1024)+"0"))
	var normal string
	var rawTotal int64
	if e = db.QueryRow(ctx, "SELECT metadata FROM ld_records WHERE library_id=$1 AND search_id=$2", lib, ids[99]).Scan(&normal); e != nil {
		t.Fatal(e)
	}
	if e = db.QueryRow(ctx, "SELECT sum(octet_length(metadata)) FROM ld_records WHERE library_id=$1", lib).Scan(&rawTotal); e != nil {
		t.Fatal(e)
	}
	var valid map[string]any
	if json.Unmarshal([]byte(normal), &valid) != nil {
		t.Fatal("valid control metadata")
	}
	valid["SyntheticPadding"] = strings.Repeat("x", 4*1024*1024-int(rawTotal)-256)
	under, _ := json.Marshal(valid)
	must("UPDATE ld_records SET metadata=$3 WHERE library_id=$1 AND search_id=$2", lib, ids[99], string(under))
	smaller, e := s.prepareBundle(ctx, lib, plan, newUUID())
	if e != nil || *smaller.Manifest.Counts.Bytes != *d.Manifest.Counts.Bytes {
		t.Fatal("valid below-budget snapshot", e)
	}
	valid["SyntheticPadding"] = valid["SyntheticPadding"].(string) + strings.Repeat("x", 512)
	over, _ := json.Marshal(valid)
	must("UPDATE ld_records SET metadata=$3 WHERE library_id=$1 AND search_id=$2", lib, ids[99], string(over))
	_, e = s.prepareBundle(ctx, lib, plan, newUUID())
	var budget *planError
	if !errors.As(e, &budget) || budget.Status != 409 || !strings.Contains(budget.Message, "4 MiB preparation read budget") {
		t.Fatal("specific metadata preflight did not reject", e)
	}
	must("UPDATE ld_records SET metadata=$3 WHERE library_id=$1 AND search_id=$2", lib, ids[99], normal)
	// Valid whitespace-padded saved documents exercise storage quota, not JSON corruption.
	must("UPDATE native_bundles SET document=document||repeat(' ',8388608-octet_length(document))")
	_, e = s.prepareBundle(ctx, lib, plan, newUUID())
	budget = nil
	if !errors.As(e, &budget) || budget.Status != 429 || !strings.Contains(budget.Message, "metadata storage is full") {
		t.Fatal("specific metadata quota", e)
	}
	cancelled, stop := context.WithCancel(ctx)
	stop()
	if _, e = s.prepareBundle(cancelled, lib, plan, newUUID()); e == nil {
		t.Fatal("cancelled admission")
	}
	db.QueryRow(ctx, "SELECT count(*) FROM native_bundles").Scan(&count)
	if count != 2 {
		t.Fatal("partial receipt committed")
	}
	must("UPDATE native_bundles SET expires_at=now()-interval '1 second'")
	if request("GET", path+"/"+d.SnapshotID, token, "", "", "", "").Code != 410 {
		t.Fatal("expired GET")
	}
	if request("POST", path, token, csrf, intent, "", "").Code != 410 {
		t.Fatal("expired UUID recreated")
	}
	must("UPDATE native_bundles SET document=NULL WHERE expires_at<=now()")
	if request("POST", path, token, csrf, intent, "", "").Code != 410 {
		t.Fatal("pruned UUID recreated")
	}
	must("DELETE FROM ld_sessions WHERE token_hash=$1", digest(token))
	if request("GET", url, token, "", "", "", "").Code != 401 {
		t.Fatal("revocation")
	}
	t.Logf("Actual PostgreSQL isolated schema:100 synthetic members/9 acquired/8 distinct padded PDFs over40MiB/8parts; exact full/range checksums, alias grant denial, immutable cancellation/replay, expiry tombstone and scope/resource rollback; source calls=%d elapsed=%s", calls.Load(), time.Since(start))
}
