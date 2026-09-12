package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func syntheticOAI() string {
	rights, err := os.ReadFile("testdata/rights-template-001.xml")
	if err != nil {
		panic(err)
	}
	return `<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/" xmlns:xlink="http://www.w3.org/1999/xlink"><request verb="GetRecord" metadataPrefix="pmc" identifier="oai:pubmedcentral.nih.gov:990000001">https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/</request><GetRecord><record><header><identifier>oai:pubmedcentral.nih.gov:990000001</identifier><datestamp>2026-09-01</datestamp></header><metadata><article><front><article-meta><article-id pub-id-type="pmc">990000001</article-id><article-id pub-id-type="pmid">990000001</article-id><article-id pub-id-type="doi">10.0000/synthetic</article-id>` + string(rights) + `</article-meta></front><body><p>SYNTHETIC ONLY: multilingual α 中文, never a product fallback.</p></body></article></metadata></record></GetRecord></OAI-PMH>`
}
func syntheticArticle() map[string]any {
	return map[string]any{"SearchId": "LD-00000000000000000000000000000001", "Pmid": "990000001", "Pmcid": "PMC990000001", "Doi": "10.0000/synthetic", "Title": "SYNTHETIC ONLY", "Authors": "Synthetic Team", "Year": "2026"}
}
func TestNativeRightsAndDate(t *testing.T) {
	good := syntheticOAI()
	a := syntheticArticle()
	info, e := validateOriginal([]byte(good), a)
	if e != nil || info.Rights != "https://creativecommons.org/licenses/by/4.0/" {
		t.Fatal("valid synthetic grant", e)
	}
	for name, body := range map[string]string{
		"unreviewed scope":          strings.Replace(good, `license-type="OpenAccess"`, `license-type="OpenAccess" specific-use="non-commercial"`, 1),
		"unreviewed namespace":      strings.ReplaceAll(good, "https://jats.nlm.nih.gov/ns/archiving/1.4/", "https://example.invalid/rights"),
		"prohibited commercial":     strings.Replace(good, "© The Author(s) 2026", "Commercial use is prohibited", 1),
		"prohibited redistribution": strings.Replace(good, "© The Author(s) 2026", "Redistribution is prohibited", 1),
		"unknown wording":           strings.Replace(good, "which permits unrestricted use", "which permits limited use", 1),
		"commercial restriction":    strings.Replace(good, "© The Author(s) 2026", "No commercial re-use.", 1),
		"sibling restriction":       strings.Replace(good, "© The Author(s) 2026", "All rights reserved; this article may not be redistributed.", 1),
		"duplicate body":            strings.Replace(good, "</body>", "</body><body><p>Other body</p></body>", 1),
		"missing body":              strings.Replace(good, "<body>", "<absent>", 1),
		"wrong identifier":          strings.Replace(good, "<article-id pub-id-type=\"pmid\">990000001", "<article-id pub-id-type=\"pmid\">990000099", 1),
		"unknown rights":            strings.ReplaceAll(good, "https://creativecommons.org/licenses/by/4.0/", "https://example.invalid/unknown"),
		"restricted license":        strings.ReplaceAll(good, "/licenses/by/4.0/", "/licenses/by-nc/4.0/"),
		"wrong format":              strings.Replace(good, "metadataPrefix=\"pmc\"", "metadataPrefix=\"pmc_fm\"", 1),
		"nested article":            strings.Replace(good, "</body>", "<article/></body>", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, e := validateOriginal([]byte(body), a); e == nil {
				t.Fatal("unsafe original accepted")
			}
		})
	}
	cc0 := strings.ReplaceAll(good, "/licenses/by/4.0/", "/publicdomain/zero/1.0/")
	if _, e := validateOriginal([]byte(cc0), a); e == nil {
		t.Fatal("Unreviewed CC0 wording accepted")
	}
	b, _ := os.ReadFile("testdata/synthetic-pubmed.xml")
	for _, date := range []string{"<Year><x>1900</x></Year>", "<Year>1900</Year><Year>2026</Year>"} {
		if _, e := parsePubMed([]byte(strings.Replace(string(b), "<Year>2026</Year>", date, 1))); e == nil {
			t.Fatal("ambiguous date accepted")
		}
	}
	if got := csvSafe(" =HYPERLINK(\"unsafe\")"); !strings.HasPrefix(got, "'") {
		t.Fatal("formula escaped incorrectly")
	}
	h, e := nativeHash("SYNTHETIC-password-中文")
	if e != nil || !verifyPassword(h, "SYNTHETIC-password-中文") || verifyPassword(h, "wrong") {
		t.Fatal("native password primitive")
	}
}

type nativeTransport func(*http.Request) (*http.Response, error)

func (f nativeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestNativeActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Dedicated native disposable PostgreSQL not configured")
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
		t.Fatal("dedicated test target required")
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
	if db.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables) != nil {
		t.Fatal("schema inspect")
	}
	if tables == 0 {
		must(nativeSchema)
	}
	account, other := newUUID(), newUUID()
	h, e := nativeHash("SYNTHETIC-native-password")
	if e != nil {
		t.Fatal(e)
	}
	must("INSERT INTO ld_accounts VALUES($1,$2,$3,true),($4,$5,$3,true)", account, "synthetic-"+account, h, other, "synthetic-"+other)
	defer func() {
		c, done := context.WithTimeout(context.Background(), 15*time.Second)
		defer done()
		tx, e := db.Begin(c)
		if e != nil {
			t.Error(e)
			return
		}
		defer tx.Rollback(context.Background())
		for _, table := range []string{"native_originals", "native_items", "native_batches", "ld_results", "ld_jobs", "ld_runs", "ld_identifiers", "ld_records"} {
			if _, e = tx.Exec(c, "DELETE FROM "+table+" WHERE library_id IN(SELECT library_id FROM ld_libraries WHERE owner_id=ANY($1::uuid[]))", []string{account, other}); e != nil {
				t.Error(e)
				return
			}
		}
		for _, q := range []string{"DELETE FROM ld_sessions WHERE account_id=ANY($1::uuid[])", "DELETE FROM ld_libraries WHERE owner_id=ANY($1::uuid[])", "DELETE FROM ld_accounts WHERE account_id=ANY($1::uuid[])"} {
			if _, e = tx.Exec(c, q, []string{account, other}); e != nil {
				t.Error(e)
				return
			}
		}
		if e = tx.Commit(c); e != nil {
			t.Error(e)
		}
	}()
	cfg.Origin = "http://127.0.0.1:18090"
	cfg.LocalTest = true
	cfg.Expires = time.Now().Add(time.Hour)
	cfg.AcquisitionEnabled = true
	calls := 0
	status := 200
	body := syntheticOAI()
	s := &server{native: true, db: db, cfg: cfg, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: nativeTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/xml"}, "Retry-After": {"60"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	library, e := s.createLibrary(ctx, account, "SYNTHETIC-NATIVE002")
	if e != nil {
		t.Fatal(e)
	}
	a := syntheticArticle()
	id := a["SearchId"].(string)
	data, _ := json.Marshal(a)
	must("INSERT INTO ld_records VALUES($1,$2,$3,$4)", library, id, string(data), a["Title"])
	tokenA, sess, e := s.login(ctx, "synthetic-"+account, "SYNTHETIC-native-password")
	if e != nil || sess == nil {
		t.Fatal("native login", e)
	}
	tokenA2, _, e := s.login(ctx, "synthetic-"+account, "SYNTHETIC-native-password")
	if e != nil || tokenA2 == tokenA {
		t.Fatal("second session")
	}
	tokenB, _, e := s.login(ctx, "synthetic-"+other, "SYNTHETIC-native-password")
	if e != nil {
		t.Fatal(e)
	}
	request := func(method, path, token, csrf, body string) int {
		r := httptest.NewRequest(method, cfg.Origin+path, strings.NewReader(body))
		r.Header.Set("Origin", cfg.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF", csrf)
		r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: token})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	if request("GET", "/api/libraries/"+library, tokenB, "", "") != 404 || request("POST", "/api/libraries/"+library+"/batches", tokenA, "", `{}`) != 403 {
		t.Fatal("tenant/CSRF")
	}
	s.cfg.SearchEnabled = false
	if request("POST", "/api/libraries/"+library+"/search", tokenA, sess.CSRF, `{"query":"synthetic","limit":1}`) != 409 {
		t.Fatal("disabled search admission")
	}
	var deniedRuns int
	if db.QueryRow(ctx, "SELECT count(*) FROM ld_runs WHERE library_id=$1", library).Scan(&deniedRuns) != nil || deniedRuns != 0 {
		t.Fatal("disabled search mutated history")
	}
	req := newUUID()
	batch, e := s.queueBatch(ctx, library, req, []string{id})
	if e != nil {
		t.Fatal(e)
	}
	again, e := s.queueBatch(ctx, library, req, []string{id})
	if e != nil || again != batch {
		t.Fatal("idempotency")
	}
	if _, e = s.queueBatch(ctx, library, newUUID(), []string{id, id}); e == nil {
		t.Fatal("duplicates")
	}
	if e = s.controlBatch(ctx, library, batch, "pause"); e != nil {
		t.Fatal(e)
	}
	s.batchOne(ctx)
	if calls != 0 {
		t.Fatal("paused source request")
	}
	if e = s.controlBatch(ctx, library, batch, "resume"); e != nil {
		t.Fatal(e)
	}
	s.batchOne(ctx)
	var state, hash string
	if db.QueryRow(ctx, "SELECT state,original_hash FROM native_items WHERE library_id=$1 AND batch_id=$2", library, batch).Scan(&state, &hash) != nil || state != "acquired" {
		t.Fatal("batch result", state)
	}
	got, info, e := s.original(ctx, library, id, hash)
	if e != nil || string(got) != body || info.Hash != hash {
		t.Fatal("original fidelity", e)
	}
	csvBytes, e := s.exportCSV(ctx, library, "", batch)
	if e != nil {
		t.Fatal(e)
	}
	rows, e := csv.NewReader(strings.NewReader(string(csvBytes))).ReadAll()
	if e != nil || len(rows) != 2 || rows[1][4] != "990000001" || rows[1][13] != hash {
		t.Fatal("export")
	}
	bundle, e := s.exportBundle(ctx, library, batch)
	if e != nil {
		t.Fatal(e)
	}
	z, e := zip.NewReader(bytes.NewReader(bundle), int64(len(bundle)))
	if e != nil || len(z.File) != 3 {
		t.Fatal("bundle members", e)
	}
	found := false
	for _, file := range z.File {
		if strings.HasSuffix(file.Name, ".xml") {
			r, e := file.Open()
			if e != nil {
				t.Fatal(e)
			}
			b, e := io.ReadAll(r)
			r.Close()
			if e != nil || string(b) != body {
				t.Fatal("bundle original bytes")
			}
			found = true
		}
	}
	if !found {
		t.Fatal("bundle original absent")
	}
	again, e = s.queueBatch(ctx, library, newUUID(), []string{id})
	if e != nil {
		t.Fatal(e)
	}
	s.batchOne(ctx)
	if calls != 1 {
		t.Fatal("valid existing original unnecessarily refetched")
	}
	s.cfg.AcquisitionEnabled = false
	if _, _, e = s.original(ctx, library, id, hash); e == nil {
		t.Fatal("policy downgrade download")
	}
	bundle, e = s.exportBundle(ctx, library, batch)
	if e != nil {
		t.Fatal(e)
	}
	z, e = zip.NewReader(bytes.NewReader(bundle), int64(len(bundle)))
	if e != nil || len(z.File) != 2 {
		t.Fatal("held ZIP members", e)
	}
	for _, file := range z.File {
		if strings.HasSuffix(file.Name, ".xml") {
			t.Fatal("held original leaked into ZIP")
		}
		r, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(r)
		r.Close()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(b, []byte("unavailable")) || !bytes.Contains(b, []byte("current policy")) {
			t.Fatal("held ZIP lacks truthful unresolved status")
		}
	}
	s.cfg.AcquisitionEnabled = true
	// Cancellation during response consumption must fence publication. A new identity prevents reuse.
	a2 := syntheticArticle()
	id2 := "LD-00000000000000000000000000000002"
	a2["SearchId"] = id2
	b2, _ := json.Marshal(a2)
	must("INSERT INTO ld_records VALUES($1,$2,$3,'SYNTHETIC cancellation')", library, id2, string(b2))
	cancelBatch, e := s.queueBatch(ctx, library, newUUID(), []string{id2})
	if e != nil {
		t.Fatal(e)
	}
	s.provider.Transport = nativeTransport(func(r *http.Request) (*http.Response, error) {
		if e := s.controlBatch(ctx, library, cancelBatch, "cancel"); e != nil {
			t.Error(e)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/xml"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	s.batchOne(ctx)
	var n int
	if db.QueryRow(ctx, "SELECT count(*) FROM native_originals WHERE library_id=$1 AND search_id=$2", library, id2).Scan(&n) != nil || n != 0 {
		t.Fatal("cancelled response published")
	}
	// Stale lease after process loss is resumable; publication remains single and preserves bytes.
	resume, e := s.queueBatch(ctx, library, newUUID(), []string{id})
	if e != nil {
		t.Fatal(e)
	}
	must("UPDATE native_items SET state='running',lease=$3,lease_until=now()-interval '1 second' WHERE library_id=$1 AND batch_id=$2", library, resume, newUUID())
	s.batchOne(ctx)
	var restoredHash string
	if err := db.QueryRow(ctx, "SELECT state,original_hash FROM native_items WHERE library_id=$1 AND batch_id=$2", library, resume).Scan(&state, &restoredHash); err != nil || state != "acquired" || restoredHash != hash {
		t.Fatal("expired lease did not recover exact original", err, state)
	}
	if calls != 1 {
		t.Fatal("lease recovery refetched valid original")
	}
	must("UPDATE native_items SET state='running',attempts=3,lease=$3,lease_until=now()-interval '1 second' WHERE library_id=$1 AND batch_id=$2", library, resume, newUUID())
	s.batchOne(ctx)
	if err := db.QueryRow(ctx, "SELECT state FROM native_items WHERE library_id=$1 AND batch_id=$2", library, resume).Scan(&state); err != nil || state != "failed" {
		t.Fatal("interrupted attempt bound", err, state)
	}
	// Disposable PG only: native item transitions for explicit provider fault fixtures.
	var oldBudget time.Time
	if db.QueryRow(ctx, "SELECT next_at FROM ld_source_budget WHERE name='ncbi'").Scan(&oldBudget) != nil {
		t.Fatal("fixture budget")
	}
	defer func() {
		_, _ = db.Exec(context.Background(), "UPDATE ld_source_budget SET next_at=$1 WHERE name='ncbi'", oldBudget)
	}()
	for _, fault := range []struct {
		status            int
		contentType, want string
	}{{403, "text/plain", "unavailable"}, {401, "text/plain", "unavailable"}, {302, "text/plain", "unsupported"}, {200, "text/html", "failed"}, {429, "application/xml", "rate_wait"}} {
		must("UPDATE ld_source_budget SET next_at=now() WHERE name='ncbi'")
		faultCalls := 0
		s.provider.Transport = nativeTransport(func(r *http.Request) (*http.Response, error) {
			faultCalls++
			return &http.Response{StatusCode: fault.status, Header: http.Header{"Content-Type": {fault.contentType}, "Retry-After": {"60"}, "Location": {"http://127.0.0.1/unsafe"}}, Body: io.NopCloser(strings.NewReader("SYNTHETIC provider fault"))}, nil
		})
		bid, err := s.queueBatch(ctx, library, newUUID(), []string{id2})
		if err != nil {
			t.Fatal(err)
		}
		s.batchOne(ctx)
		if err = db.QueryRow(ctx, "SELECT state FROM native_items WHERE library_id=$1 AND batch_id=$2", library, bid).Scan(&state); err != nil || state != fault.want || faultCalls != 1 {
			t.Fatal("provider fault state", fault.status, state, err)
		}
		if fault.status == 429 {
			if err = s.controlBatch(ctx, library, bid, "retry"); err != nil {
				t.Fatal(err)
			}
			s.batchOne(ctx)
			if faultCalls != 1 {
				t.Fatal("cooldown bypass")
			}
		}
	}
	if db.QueryRow(ctx, "SELECT count(*) FROM native_originals WHERE library_id=$1 AND search_id=$2", library, id2).Scan(&n) != nil || n != 0 {
		t.Fatal("provider fault published bytes")
	}
	// Large saved input exercises real DB counts/admission without a source call or fake demo record.
	run := newID("RUN-")
	must("INSERT INTO ld_runs(library_id,run_id,input,requested_limit,state,total,fetched) VALUES($1,$2,'SYNTHETIC-RV016-20000',100,'partial',20000,20000)", library, run)
	must("INSERT INTO ld_records SELECT $1,'LD-'||lpad(g::text,32,'0'),'{}','SYNTHETIC-RV016' FROM generate_series(100,20099) g", library)
	must("INSERT INTO ld_results SELECT $1,$2,'LD-'||lpad(g::text,32,'0'),g FROM generate_series(100,20099) g", library, run)
	if _, e = s.exportCSV(ctx, library, run, ""); e == nil {
		t.Fatal("large export silently truncated")
	}
	if request("GET", "/api/libraries/"+library+"/runs/"+run, tokenB, "", "") != 404 {
		t.Fatal("large run isolation")
	}
	t.Log("Actual native PostgreSQL: bootstrap, credentials/two sessions/B isolation, CSRF, batch idempotency/pause/reuse, exact bytes/rights/CSV, policy downgrade, cancellation publication fence, expired lease recovery and20000-row explicit export cap passed; all source responses SYNTHETIC")
}

func TestPrivateNativeOriginalReplay(t *testing.T) {
	path := os.Getenv("LITRADOCK_NATIVE_ORIGINAL_REPLAY")
	if path == "" {
		t.Skip("Private captured original envelopes absent; no provider calls")
	}
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var rows []struct {
		Path     string
		Article  map[string]any
		Expected string
	}
	if json.Unmarshal(b, &rows) != nil || len(rows) != 2 {
		t.Fatal("private replay contract")
	}
	for _, r := range rows {
		bytes, e := os.ReadFile(r.Path)
		if e != nil {
			t.Fatal("private original absent")
		}
		_, e = validateOriginal(bytes, r.Article)
		if (e == nil) != (r.Expected == "permitted") {
			t.Fatal("private captured rights/shape mismatch", articleString(r.Article, "Pmcid"), e)
		}
	}
	t.Log("Two genuine captured OAI responses replayed; one permitted and one explicit commercial-reuse conflict denied; no provider calls")
}
