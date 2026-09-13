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
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPlanExportBufferAndCancellation(t *testing.T) {
	var b planZIPBuffer
	if _, e := b.Write(make([]byte, planZIPBytes)); e != nil {
		t.Fatal(e)
	}
	if _, e := b.Write([]byte{1}); e == nil || b.Len() != planZIPBytes {
		t.Fatal("over-limit write accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if data, e := encodePlanDocument(ctx, planExportDocument{}); e == nil || data != nil {
		t.Fatal("cancelled metadata emitted")
	}
}

// A closed lazy pool models service failure after authentication/admission;
// this focused handler probe makes no connection and is not an auth test.
func TestPlanExportServiceFailure(t *testing.T) {
	ctx := context.Background()
	pc, err := pgxpool.ParseConfig("host=127.0.0.1 port=1 user=synthetic dbname=synthetic sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	db, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	s := &server{db: db}
	for _, format := range []string{"json", "zip"} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(`{"format":"`+format+`"}`))
		w := httptest.NewRecorder()
		s.planExportHTTP(w, r, ctx, newUUID(), newID("PLN-"))
		if w.Code != 503 || w.Header().Get("Content-Disposition") != "" || s.bundleBusy.Load() || strings.Contains(w.Body.String(), "pool") {
			t.Fatal("service failure classification/redaction/capacity", w.Code)
		}
	}
}

func TestPlanExportActualPostgres(t *testing.T) {
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
	a, b, lib, foreign, run, plan := newUUID(), newUUID(), newUUID(), newUUID(), newID("RUN-"), newID("PLN-")
	must("INSERT INTO ld_accounts VALUES($1,$2,'unused',true),($3,$4,'unused',true)", a, "synthetic-plan-export-"+a, b, "synthetic-plan-export-"+b)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC plan export',true),($3,$4,'SYNTHETIC foreign',true)", lib, a, foreign, b)
	defer func() {
		for _, table := range []string{"native_plan_commands", "native_plan_items", "native_items", "native_batches", "native_plans", "native_originals", "ld_results", "ld_jobs", "ld_runs", "ld_records"} {
			must("DELETE FROM "+table+" WHERE library_id=$1", lib)
		}
		must("DELETE FROM ld_sessions WHERE account_id IN ($1,$2)", a, b)
		must("DELETE FROM ld_libraries WHERE library_id IN ($1,$2)", lib, foreign)
		must("DELETE FROM ld_accounts WHERE account_id IN ($1,$2)", a, b)
	}()
	must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state,reason) VALUES($1,$2,$3,25001,100,100,'partial','Retrieval cap')", lib, run, "SYNTHETIC 醫學 AND العربية\n\"quoted\"")
	must("INSERT INTO native_plans(library_id,plan_id,run_id,request_id,selection,receipt,requested_format) VALUES($1,$2,$3,$4,'synthetic','{}','pdf')", lib, plan, run, newUUID())
	children := []string{newID("BAT-"), newID("BAT-")}
	for _, child := range children {
		must("INSERT INTO native_batches(library_id,batch_id,request_id,selection,state,requested_format,plan_id) VALUES($1,$2,$3,'synthetic','complete','pdf',$4)", lib, child, newUUID(), plan)
	}
	ids := []string{}
	articles := []map[string]any{}
	bodies := [][]byte{}
	infos := []originalInfo{}
	for n := 0; n < 100; n++ {
		id := newID("LD-")
		ids = append(ids, id)
		article := syntheticArticle()
		article["SearchId"] = id
		article["Title"] = "SYNTHETIC 醫學 😀 \"quote\"\nline"
		article["Abstract"] = "=SUM(1,2)\n資料"
		article["password"] = "PRIVATE_PLAN_SENTINEL"
		articles = append(articles, article)
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
		if n < 3 {
			data := syntheticPDF("same original")
			if n == 2 {
				data = syntheticPDF("distinct deposit 2")
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
			bodies = append(bodies, data)
			infos = append(infos, info)
			hash = info.Hash
			state = "acquired"
			reason = ""
			must("INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy,format,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pdf',$9)", lib, id, hash, data, info.Source, info.Rights, info.Stamp, pdfPolicy, proofBytes(proof))
		}
		if n == 4 {
			state = "transient"
			reason = "Source cooldown; explicit retry remains bounded"
		}
		if n == 5 {
			state = "cancelled"
			reason = "Cancelled"
		}
		if n == 6 {
			state = "running"
			reason = ""
		}
		if n == 8 {
			state = "queued"
		}
		if n == 9 {
			state = "failed"
		}
		if child != nil {
			must("INSERT INTO native_items(library_id,batch_id,search_id,rank,state,reason,original_hash) VALUES($1,$2,$3,$4,$5,$6,$7)", lib, child, id, n%10+1, state, reason, hash)
		}
		must("INSERT INTO native_plan_items(library_id,plan_id,search_id,rank,child_batch_id,cancelled) VALUES($1,$2,$3,$4,$5,$6)", lib, plan, id, n+1, child, n == 21)
	}
	var calls atomic.Int32
	s := &server{db: db, native: true, cfg: config{LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour), AcquisitionEnabled: true, PDFEnabled: true, PlanEnabled: true}, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{Transport: nativeTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, fmt.Errorf("no provider permitted")
	})}}
	token, other, csrf := randomToken(), randomToken(), randomToken()
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour'),($4,$5,$3,now()+interval '1 hour')", digest(token), a, csrf, digest(other), b)
	request := func(path, credential, anti, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Host = "127.0.0.1:18089"
		r.AddCookie(&http.Cookie{Name: "LitraDockTest", Value: credential})
		r.Header.Set("Origin", s.cfg.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF", anti)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	path := "/api/libraries/" + lib + "/plans/" + plan + "/exports"
	readZIP := func(data []byte) planExportDocument {
		t.Helper()
		z, e := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if e != nil {
			t.Fatal(e)
		}
		members := map[string][]byte{}
		for _, f := range z.File {
			if _, ok := members[f.Name]; ok {
				t.Fatal("duplicate filename")
			}
			r, e := f.Open()
			if e != nil {
				t.Fatal(e)
			}
			b, e := io.ReadAll(r)
			r.Close()
			if e != nil {
				t.Fatal(e)
			}
			members[f.Name] = b
		}
		var d planExportDocument
		if json.Unmarshal(members["manifest.json"], &d) != nil {
			t.Fatal("manifest")
		}
		var records structuredDocument
		if json.Unmarshal(members["records.json"], &records) != nil {
			t.Fatal("research")
		}
		m1, _ := json.Marshal(d.Research)
		m2, _ := json.Marshal(records)
		if !bytes.Equal(m1, m2) {
			t.Fatal("metadata mismatch")
		}
		if len(d.Items) != 100 || len(records.Records) != 100 || d.Counts.Members != 100 {
			t.Fatal("truncated membership")
		}
		for n, i := range d.Items {
			if i.SearchID != ids[n] || records.Records[n].SearchID != ids[n] {
				t.Fatal("ID order")
			}
			if i.File != nil {
				if i.Original == nil || !bytes.Equal(members[*i.File], bodies[n]) {
					t.Fatal("original fidelity")
				}
			}
		}
		return d
	}
	t.Run("100-member-multi-child-whole-scope-two-versions-dedup-and-HTTP", func(t *testing.T) {
		for _, format := range []string{"json", "zip"} {
			w := request(path, token, csrf, `{"format":"`+format+`"}`)
			if w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte("PRIVATE_PLAN_SENTINEL")) {
				t.Fatal("export", w.Code)
			}
			if out := os.Getenv("NATIVE_PLAN_EXPORT_TEST_OUTPUT"); out != "" {
				if e := os.MkdirAll(out, 0700); e != nil {
					t.Fatal(e)
				}
				if e := os.WriteFile(filepath.Join(out, "plan-synthetic."+format), w.Body.Bytes(), 0600); e != nil {
					t.Fatal(e)
				}
			}
			if format == "zip" {
				d := readZIP(w.Body.Bytes())
				if *d.Counts.Included != 3 || *d.Counts.Unique != 2 || *d.Counts.Unresolved != 97 || *d.Counts.Bytes != len(bodies[0])+len(bodies[2]) || d.Items[0].File == nil || *d.Items[0].File != *d.Items[1].File || *d.Items[2].Original.Deposit != "2" {
					t.Fatal("counts/version/dedup")
				}
				if d.Items[4].Phase != "retry" || d.Items[5].Phase != "cancelled" || d.Items[6].Phase != "running" || d.Items[20].Phase != "waiting" || d.Items[21].Phase != "cancelled" {
					t.Fatal("phases")
				}
			} else {
				var d planExportDocument
				if json.Unmarshal(w.Body.Bytes(), &d) != nil || d.Revalidated || d.Counts.Included != nil || len(d.Items) != 100 || d.Items[0].Availability != "not_revalidated" || d.Research.Counts.Provider != nil || d.Research.Queries[0].Provider != 25001 || d.Research.Queries[0].Complete {
					t.Fatal("metadata scope")
				}
			}
		}
	})
	t.Run("rights-corruption-and-current-policy-remain-explicit", func(t *testing.T) {
		must("UPDATE native_originals SET content=$3 WHERE library_id=$1 AND search_id=$2", lib, ids[0], []byte("CORRUPT SYNTHETIC"))
		must("UPDATE native_originals SET rights_uri='https://example.invalid/no-grant' WHERE library_id=$1 AND search_id=$2", lib, ids[2])
		data, e := s.exportPlan(ctx, lib, plan, "zip")
		if e != nil {
			t.Fatal(e)
		}
		d := readZIP(data)
		if *d.Counts.Included != 1 || d.Items[0].Availability != "unavailable" || d.Items[2].AvailabilityReason == nil || d.Items[0].AcquisitionState == nil || *d.Items[0].AcquisitionState != "acquired" {
			t.Fatal("historical/current conflation")
		}
		must("UPDATE native_originals SET content=$3 WHERE library_id=$1 AND search_id=$2", lib, ids[0], bodies[0])
		must("UPDATE native_originals SET rights_uri=$3 WHERE library_id=$1 AND search_id=$2", lib, ids[2], infos[2].Rights)
		s.cfg.PDFEnabled = false
		data, e = s.exportPlan(ctx, lib, plan, "zip")
		s.cfg.PDFEnabled = true
		if e != nil {
			t.Fatal(e)
		}
		if *readZIP(data).Counts.Included != 0 {
			t.Fatal("policy bypass")
		}
	})
	t.Run("ownership-CSRF-malformed-and-shared-child-plan-capacity", func(t *testing.T) {
		for _, v := range []struct {
			path, token, csrf, body string
			code                    int
		}{{path, other, csrf, `{"format":"zip"}`, 404}, {path, token, "", `{"format":"json"}`, 403}, {path, token, csrf, `{"format":"csv"}`, 400}, {path, token, csrf, `{"format":"json","searchIDs":[]}`, 400}, {strings.Replace(path, plan, newID("PLN-"), 1), token, csrf, `{"format":"json"}`, 404}} {
			w := request(v.path, v.token, v.csrf, v.body)
			if w.Code != v.code || w.Header().Get("Content-Disposition") != "" {
				t.Fatal("denial", w.Code, v.code)
			}
		}
		s.bundleBusy.Store(true)
		w := request(path, token, csrf, `{"format":"zip"}`)
		child := request("/api/libraries/"+lib+"/exports", token, csrf, `{"format":"zip","batchID":"`+children[0]+`"}`)
		s.bundleBusy.Store(false)
		if w.Code != 429 || child.Code != 429 {
			t.Fatal("shared capacity")
		}
		must("DELETE FROM ld_sessions WHERE token_hash=$1", digest(other))
		if request(path, other, csrf, `{"format":"json"}`).Code != 401 {
			t.Fatal("revoked session")
		}
	})

	t.Run("over-limit-original-set-refused-before-attachment", func(t *testing.T) {
		for n := 3; n < 7; n++ {
			hash := fmt.Sprintf("%064x", n)
			must("INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy,format) VALUES($1,$2,$3,decode(repeat('00',8388608),'hex'),'https://example.invalid/synthetic','https://creativecommons.org/licenses/by/4.0/','synthetic','synthetic','pdf')", lib, ids[n], hash)
			must("UPDATE native_items SET state='acquired',original_hash=$3 WHERE library_id=$1 AND search_id=$2", lib, ids[n], hash)
		}
		w := request(path, token, csrf, `{"format":"zip"}`)
		if w.Code != 409 || w.Header().Get("Content-Disposition") != "" || s.bundleBusy.Load() {
			t.Fatal("oversized plan returned partial attachment or retained capacity", w.Code)
		}
		for n := 3; n < 7; n++ {
			must("DELETE FROM native_originals WHERE library_id=$1 AND search_id=$2", lib, ids[n])
			state := []string{"unavailable", "transient", "cancelled", "running"}[n-3]
			must("UPDATE native_items SET state=$3,original_hash='' WHERE library_id=$1 AND search_id=$2", lib, ids[n], state)
		}
	})
	t.Run("observed-concurrent-progress-cancel-metadata-snapshot-and-restart", func(t *testing.T) {
		holder, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer holder.Rollback(context.Background())
		if _, e = holder.Exec(ctx, "LOCK TABLE ld_records IN ACCESS EXCLUSIVE MODE"); e != nil {
			t.Fatal(e)
		}
		type result struct {
			b []byte
			e error
		}
		done := make(chan result, 1)
		go func() { b, e := s.exportPlan(ctx, lib, plan, "zip"); done <- result{b, e} }()
		observed := false
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT m.search_id,m.rank,m.child_batch_id%')").Scan(&observed) != nil {
				t.Fatal("lock inspection")
			}
			if observed {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !observed {
			t.Fatal("export waiting schedule not observed")
		}
		for _, q := range []string{"UPDATE native_plans SET state='cancelled',revision=revision+1 WHERE library_id=$1", "UPDATE native_items SET state='cancelled',reason='Cancelled after snapshot' WHERE library_id=$1 AND state='running'", "UPDATE ld_records SET metadata=jsonb_set(metadata::jsonb,'{Title}','\"SYNTHETIC changed after snapshot\"')::text WHERE library_id=$1"} {
			if _, e = holder.Exec(ctx, q, lib); e != nil {
				t.Fatal(e)
			}
		}
		if e = holder.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		got := <-done
		if got.e != nil {
			t.Fatal(got.e)
		}
		d := readZIP(got.b)
		if d.Plan.State == "cancelled" || d.Items[6].Phase != "running" || *d.Research.Records[0].Publication.Title == "SYNTHETIC changed after snapshot" {
			t.Fatal("mixed snapshot")
		}
		restarted := &server{db: db, cfg: s.cfg, native: true}
		data, e := restarted.exportPlan(ctx, lib, plan, "zip")
		if e != nil {
			t.Fatal(e)
		}
		fresh := readZIP(data)
		if fresh.Plan.State != "cancelled" || fresh.Items[6].Phase != "cancelled" || *fresh.Research.Records[0].Publication.Title != "SYNTHETIC changed after snapshot" {
			t.Fatal("restart/fresh snapshot")
		}
	})
	if calls.Load() != 0 {
		t.Fatal("export called provider")
	}
	var count int
	if db.QueryRow(ctx, "SELECT count(*) FROM native_plan_items WHERE library_id=$1", lib).Scan(&count) != nil || count != 100 {
		t.Fatal("export changed membership")
	}
}
