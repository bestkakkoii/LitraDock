package main

import (
	"context"
	"encoding/binary"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSourceOutcomeActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Dedicated PostgreSQL not configured")
	}
	raw, e := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if e != nil {
		t.Fatal("protected test config absent")
	}
	var cfg config
	if json.Unmarshal(raw, &cfg) != nil {
		t.Fatal("test config invalid")
	}
	pc, e := pgxpool.ParseConfig(cfg.Database)
	if e != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_test_") {
		t.Fatal("disposable database required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
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
	if e = db.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); e != nil {
		t.Fatal(e)
	}
	if tables == 0 {
		must(nativeSchema)
	}
	account, foreign, library, other, run, batch := newUUID(), newUUID(), newUUID(), newUUID(), newID("RUN-"), newID("BAT-")
	must("INSERT INTO ld_accounts VALUES($1,$2,'unused',true),($3,$4,'unused',true)", account, "synthetic-outcome-"+account, foreign, "synthetic-outcome-"+foreign)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC outcomes',true),($3,$4,'SYNTHETIC foreign',true)", library, account, other, foreign)
	defer func() {
		for _, table := range []string{"native_plan_sources", "native_plan_commands", "native_plan_items", "native_originals", "native_items", "native_batches", "native_plans", "ld_results", "ld_jobs", "ld_runs", "ld_records"} {
			var exists bool
			db.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", table).Scan(&exists)
			if exists {
				must("DELETE FROM "+table+" WHERE library_id IN ($1,$2)", library, other)
			}
		}
		must("DELETE FROM ld_libraries WHERE library_id IN ($1,$2)", library, other)
		must("DELETE FROM ld_sessions WHERE account_id IN ($1,$2)", account, foreign)
		must("DELETE FROM ld_accounts WHERE account_id IN ($1,$2)", account, foreign)
	}()
	states := []string{"unavailable", "unavailable", "unavailable", "unavailable", "transient", "acquired", "", "unavailable"}
	reasons := []string{retainedPrefix + "2026-09-18T14:43:50.2946762Z: " + pdfNoDeposit + pdfSuffix, pdfManuscriptTDM + pdfSuffix, pdfManyVersions + pdfSuffix, "Operator source restriction: article rights need clarification; open source links.", "Metadata network or TLS request failed; no completion assumed.", "Original PDF acquired on server; use Save to download to your device.", "", "No single complete, unambiguous deposit version was listed." + pdfSuffix}
	wants := []string{"no_deposit", "manuscript_tdm", "version_ambiguous", "restricted", "retryable", "stored", "not_checked", "held"}
	must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state) VALUES($1,$2,'SYNTHETIC source states',25001,8,8,'partial')", library, run)
	must("INSERT INTO native_batches(library_id,batch_id,request_id,selection,state,requested_format) VALUES($1,$2,$3,'synthetic','partial','pdf')", library, batch, newUUID())
	ids := []string{}
	for n := range states {
		id := fmt.Sprintf("LD-%032x", n+1)
		ids = append(ids, id)
		a := syntheticArticle()
		a["SearchId"] = id
		a["OriginalUri"] = "https://user:PRIVATE_SENTINEL@pubmed.ncbi.nlm.nih.gov/private?token=PRIVATE_SENTINEL"
		raw, _ := json.Marshal(a)
		must("INSERT INTO ld_records VALUES($1,$2,$3,'SYNTHETIC source outcome')", library, id, string(raw))
		must("INSERT INTO ld_results VALUES($1,$2,$3,$4)", library, run, id, n+1)
		if states[n] != "" {
			must("INSERT INTO native_items(library_id,batch_id,search_id,rank,state,reason,attempts) VALUES($1,$2,$3,$4,$5,$6,1)", library, batch, id, n+1, states[n], reasons[n])
		}
	}
	// The same Search ID in another library must never lend its diagnosis.
	a := syntheticArticle()
	a["SearchId"] = ids[6]
	raw, _ = json.Marshal(a)
	must("INSERT INTO ld_records VALUES($1,$2,$3,'SYNTHETIC foreign')", other, ids[6], string(raw))
	foreignBatch := newID("BAT-")
	must("INSERT INTO native_batches(library_id,batch_id,request_id,selection,state,requested_format) VALUES($1,$2,$3,'foreign','partial','pdf')", other, foreignBatch, newUUID())
	must("INSERT INTO native_items(library_id,batch_id,search_id,rank,state,reason) VALUES($1,$2,$3,1,'unavailable',$4)", other, foreignBatch, ids[6], pdfNoDeposit+pdfSuffix)
	content := syntheticPDF("source-outcome-current-bytes")
	proof := syntheticPDFProof(t, content, syntheticArticle())
	info, e := validatePDF(content, proofBytes(proof), syntheticArticle())
	if e != nil {
		t.Fatal(e)
	}
	must("INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy,format,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pdf',$9)", library, ids[5], info.Hash, content, info.Source, info.Rights, info.Stamp, pdfPolicy, proofBytes(proof))
	must("UPDATE native_items SET original_hash=$4 WHERE library_id=$1 AND batch_id=$2 AND search_id=$3", library, batch, ids[5], info.Hash)
	calls := 0
	s := &server{db: db, native: true, cfg: config{LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour), AcquisitionEnabled: true, PDFEnabled: true, PlanEnabled: true}, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{Transport: nativeTransport(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, fmt.Errorf("provider transport forbidden")
	})}}
	for offset := 0; offset < 8; offset += 5 {
		v, e := s.savedRunPage(ctx, library, run, offset, 5)
		if e != nil {
			t.Fatal(e)
		}
		page := v.(map[string]any)
		if page["total"] != 8 {
			t.Fatal("scope count")
		}
		for n, value := range page["records"].([]any) {
			a := value.(map[string]any)
			o := a["SourceOutcome"].(sourceOutcome)
			if o.Status != wants[offset+n] {
				t.Fatal("search outcome", offset+n, o.Status)
			}
			b, _ := json.Marshal(a)
			if strings.Contains(string(b), "PRIVATE_SENTINEL") {
				t.Fatal("unsafe link leaked")
			}
		}
	}
	for _, scope := range []struct{ run, batch string }{{run, ""}, {"", batch}} {
		d, e := s.structuredResearch(ctx, library, scope.run, scope.batch)
		if e != nil {
			t.Fatal(e)
		}
		for _, r := range d.Records {
			n := 0
			for ids[n] != r.SearchID {
				n++
			}
			if r.SourceOutcome == nil || r.SourceOutcome.Status != wants[n] {
				t.Fatal("structured outcome", r.SearchID, r.SourceOutcome)
			}
		}
		b, e := s.exportCSV(ctx, library, scope.run, scope.batch)
		if e != nil {
			t.Fatal(e)
		}
		rows, e := csv.NewReader(strings.NewReader(string(b))).ReadAll()
		if e != nil || rows[0][14] != "Source outcome" || rows[1][14] != "no_deposit" || rows[1][18] != "2026-09-18T14:43:50.2946762Z" {
			t.Fatal("CSV outcomes", e)
		}
	}
	detail, e := s.batchDetail(ctx, library, batch)
	if e != nil {
		t.Fatal(e)
	}
	for _, item := range detail.(map[string]any)["items"].([]map[string]any) {
		if item["search_id"] == ids[5] && item["sourceOutcome"].(sourceOutcome).Status != "ready" {
			t.Fatal("current byte validation omitted")
		}
	}
	plan, e := s.queuePlan(ctx, library, newUUID(), run, ids, "pdf")
	if e != nil {
		t.Fatal(e)
	}
	must("UPDATE native_plan_items m SET child_batch_id=$3 WHERE library_id=$1 AND plan_id=$2 AND EXISTS(SELECT 1 FROM native_items i WHERE i.library_id=m.library_id AND i.batch_id=$3 AND i.search_id=m.search_id)", library, plan.PlanID, batch)
	must("UPDATE native_batches SET plan_id=$3 WHERE library_id=$1 AND batch_id=$2", library, batch, plan.PlanID)
	page, e := s.planDetail(ctx, library, plan.PlanID, 0, 100)
	if e != nil {
		t.Fatal(e)
	}
	for n, i := range page.(map[string]any)["items"].([]planItem) {
		want := wants[n]
		if n == 5 {
			want = "ready"
		}
		if n == 6 {
			want = "waiting"
		}
		if i.SourceOutcome == nil || i.SourceOutcome.Status != want {
			t.Fatal("plan mapping", n, i.SourceOutcome)
		}
	}
	b, e := s.exportPlan(ctx, library, plan.PlanID, "json")
	if e != nil {
		t.Fatal(e)
	}
	var pd planExportDocument
	if json.Unmarshal(b, &pd) != nil || pd.Counts.Members != 8 || pd.Items[0].SourceOutcome.Status != "no_deposit" || pd.Items[5].SourceOutcome.Status != "stored" {
		t.Fatal("plan export scope and current-validation boundary")
	}
	checkPackage := func(included int) {
		t.Helper()
		for _, kind := range []string{"batch", "plan"} {
			id := batch
			archive, err := s.exportBundle(ctx, library, id)
			if kind == "plan" {
				id = plan.PlanID
				archive, err = s.exportPlan(ctx, library, id, "zip")
			}
			if err != nil {
				t.Fatal(err)
			}
			// Ordinary metadata ZIP remains valid even when validation loses all PDFs.
			if len(archive) == 0 {
				t.Fatal("metadata ZIP lost")
			}
			header, file, err := pdfDownloadPackage(archive, kind, id)
			if err != nil {
				t.Fatal(kind, err)
			}
			var report pdfDownloadReport
			if json.Unmarshal(header, &report) != nil || report.Included != included || report.Unresolved != report.Selected-included || (len(file) > 0) != (included > 0) {
				t.Fatal("final package availability", kind)
			}
			for _, i := range report.Items {
				if i.SearchID == ids[5] && ((i.Outcome.Status == "ready") != (included > 0) || i.Available != (included > 0)) {
					t.Fatal("stale package outcome")
				}
			}
		}
	}
	checkPackage(1)
	token, foreignToken, csrf := randomToken(), randomToken(), randomToken()
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour'),($4,$5,$3,now()+interval '1 hour')", digest(token), account, csrf, digest(foreignToken), foreign)
	request := func(method, path, credential, anti string, custom ...string) *httptest.ResponseRecorder {
		body := `{"runID":"` + run + `","format":"json"}`
		if len(custom) > 0 {
			body = custom[0]
		}
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Host = "127.0.0.1:18089"
		r.AddCookie(&http.Cookie{Name: "LitraDockTest", Value: credential})
		r.Header.Set("Origin", s.cfg.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF", anti)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	path := "/api/libraries/" + library + "/runs/" + run
	if request("GET", path, token, "").Code != 200 || request("GET", path, foreignToken, "").Code != 404 {
		t.Fatal("session/library isolation")
	}
	if request("POST", "/api/libraries/"+library+"/exports", token, "").Code != 403 {
		t.Fatal("CSRF boundary")
	}
	for _, endpoint := range []struct{ path, body string }{
		{"/api/libraries/" + library + "/exports", `{"batchID":"` + batch + `","format":"pdf-download"}`},
		{"/api/libraries/" + library + "/plans/" + plan.PlanID + "/exports", `{"format":"pdf-download"}`},
	} {
		w := request("POST", endpoint.path, token, csrf, endpoint.body)
		if w.Code != 200 || w.Header().Get("Content-Type") != pdfDownloadMedia || w.Body.Len() < 4 {
			t.Fatal("PDF package HTTP", w.Code, w.Body.String())
		}
		n := int(binary.BigEndian.Uint32(w.Body.Bytes()[:4]))
		var report pdfDownloadReport
		if n > w.Body.Len()-4 || json.Unmarshal(w.Body.Bytes()[4:4+n], &report) != nil || report.Included != 1 {
			t.Fatal("HTTP package framing")
		}
		if request("POST", endpoint.path, foreignToken, csrf, endpoint.body).Code != 404 || request("POST", endpoint.path, token, "", endpoint.body).Code != 403 {
			t.Fatal("PDF package ownership/CSRF")
		}
	}
	must("DELETE FROM ld_sessions WHERE token_hash=$1", digest(token))
	if request("GET", path, token, "").Code != 401 {
		t.Fatal("revoked session leaked outcomes")
	}
	must("UPDATE native_originals SET content=$3 WHERE library_id=$1 AND search_id=$2", library, ids[5], []byte("SYNTHETIC corrupted original"))
	checkPackage(0)
	detail, e = s.batchDetail(ctx, library, batch)
	if e != nil {
		t.Fatal(e)
	}
	for _, item := range detail.(map[string]any)["items"].([]map[string]any) {
		if item["search_id"] == ids[5] && (item["downloadAvailable"] == true || item["sourceOutcome"].(sourceOutcome).Status != "restricted") {
			t.Fatal("integrity failure claimed ready")
		}
	}
	if calls != 0 {
		t.Fatal("provider traffic")
	}
	t.Log("SYNTHETIC actual PostgreSQL: eight records, exact page/scope membership, library/session/CSRF isolation, current original integrity, consistent search/batch/plan/export outcomes; zero provider calls")
}
