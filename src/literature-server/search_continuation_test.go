package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestContinuationSyntheticCounts(t *testing.T) {
	for input, want := range map[string]string{"transient": "failed", "unsupported": "unavailable", "rate_wait": "rate_wait", "expired": "expired", "unavailable": "unavailable", "unexpected": "failed"} {
		if continuationFailureState(input) != want {
			t.Fatal("error state strands frozen page", input)
		}
	}
	for _, ids := range [][]string{{"1", "1"}, {""}, {"invalid"}, {strings.Repeat("1", 21)}} {
		if validWindowIDs(ids) {
			t.Fatal("invalid frozen membership accepted", ids)
		}
	}
	for _, total := range []int{0, 1, 99, 100, 101, 1000, 10000, 25000} {
		ids := ""
		for i := 1; i <= min(total, searchWindowLimit); i++ {
			ids += fmt.Sprintf("<Id>%d</Id>", i)
		}
		body := fmt.Sprintf("<eSearchResult><Count>%d</Count><IdList>%s</IdList><QueryTranslation>synthetic</QueryTranslation></eSearchResult>", total, ids)
		n, got, _, e := parseSearchMetadata([]byte(body), searchWindowLimit)
		if e != nil || n != total || len(got) != min(total, searchWindowLimit) {
			t.Fatal("count/window distinction", total, e)
		}
	}
	for _, body := range []string{
		"<eSearchResult><Count>2</Count><IdList><Id>1</Id><Id>1</Id></IdList></eSearchResult>",
		"<eSearchResult><Count>1</Count><IdList><Id>1</Id><Id>2</Id></IdList></eSearchResult>",
		"<eSearchResult><ERROR>expired</ERROR></eSearchResult>",
	} {
		if _, _, _, e := parseSearchMetadata([]byte(body), 1000); e == nil {
			t.Fatal("invalid provider membership accepted")
		}
	}
}

type continuationTransport func(*http.Request) (*http.Response, error)

func (f continuationTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func syntheticSearchResponse(body string) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/xml"}}, Body: io.NopCloser(strings.NewReader(body))}
}
func syntheticCitation(id string) string {
	return `<PubmedArticle><MedlineCitation><PMID>` + id + `</PMID><Article><ArticleTitle>SYNTHETIC continuation ` + id + `</ArticleTitle><Abstract><AbstractText>測試 résumé &amp; scope</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`
}

func TestContinuationActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Actual disposable PostgreSQL not configured")
	}
	raw, e := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if e != nil {
		t.Fatal("protected config absent")
	}
	var cfg config
	if json.Unmarshal(raw, &cfg) != nil {
		t.Fatal("config")
	}
	pc, e := pgxpool.ParseConfig(cfg.Database)
	if e != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_test_") {
		t.Fatal("isolated native test DB required")
	}
	pc.MaxConns = 12
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
	if e = db.QueryRow(ctx, "SELECT count(*) FROM pg_tables WHERE schemaname='public'").Scan(&tables); e != nil {
		t.Fatal(e)
	}
	if tables == 0 {
		must(nativeSchema)
	}
	var originalVersion int
	if e = db.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&originalVersion); e != nil {
		t.Fatal(e)
	}
	if originalVersion == 3 {
		must(multirunSchema)
	}
	migrate := func(rollback, commit bool) error {
		tx, e := db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)
		if e = migrateContinuation(ctx, tx, rollback); e != nil {
			return e
		}
		if commit {
			return tx.Commit(ctx)
		}
		return nil
	}
	if originalVersion < 5 {
		if e = migrate(false, false); e != nil {
			t.Fatal(e)
		}
		var version int
		db.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version)
		if version != 4 {
			t.Fatal("uncommitted migration escaped")
		}
		if e = migrate(false, true); e != nil {
			t.Fatal(e)
		}
		if e = migrate(true, true); e != nil {
			t.Fatal("empty rollback", e)
		}
		if e = migrate(false, true); e != nil {
			t.Fatal(e)
		}
	}
	account, other, lib, foreign := newUUID(), newUUID(), newUUID(), newUUID()
	must("INSERT INTO ld_accounts VALUES($1,$2,'unused',true),($3,$4,'unused',true)", account, "synthetic-cont-"+account, other, "synthetic-cont-"+other)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC CONTINUATION',true),($3,$4,'SYNTHETIC FOREIGN',true)", lib, account, foreign, other)
	defer func() {
		for _, table := range []string{"native_search_actions", "native_search_pages", "native_search_windows", "ld_results", "ld_identifiers", "ld_jobs", "ld_runs", "ld_records"} {
			must("DELETE FROM "+table+" WHERE library_id IN ($1,$2)", lib, foreign)
		}
		must("DELETE FROM ld_libraries WHERE library_id IN ($1,$2)", lib, foreign)
		must("DELETE FROM ld_sessions WHERE account_id IN ($1,$2)", account, other)
		must("DELETE FROM ld_accounts WHERE account_id IN ($1,$2)", account, other)
		if originalVersion < 5 {
			if e = migrate(true, true); e != nil {
				t.Error("empty final rollback", e)
			}
		}
		if originalVersion == 3 {
			tx, e := db.Begin(ctx)
			if e == nil {
				e = migrateMultirun(ctx, tx, true)
				if e == nil {
					e = tx.Commit(ctx)
				} else {
					tx.Rollback(ctx)
				}
			}
			if e != nil {
				t.Error(e)
			}
		}
	}()
	s := &server{native: true, continuation: true, db: db, cfg: config{SearchEnabled: true, SearchContinuationEnabled: true, LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour)}, slots: make(chan struct{}, 2)}
	var calls atomic.Int32
	var mode atomic.Int32
	entered, release := make(chan struct{}, 1), make(chan struct{})
	s.provider = &http.Client{Transport: continuationTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if strings.Contains(r.URL.Path, "esearch") {
			ids := ""
			for i := 1; i <= 12; i++ {
				ids += fmt.Sprintf("<Id>%d</Id>", i)
			}
			return syntheticSearchResponse("<eSearchResult><Count>12</Count><IdList>" + ids + "</IdList><QueryTranslation>synthetic translation</QueryTranslation></eSearchResult>"), nil
		}
		switch mode.Load() {
		case 1:
			return &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": []string{"12"}}, Body: io.NopCloser(strings.NewReader("synthetic cooldown"))}, nil
		case 2:
			entered <- struct{}{}
			<-release
		case 3:
			return syntheticSearchResponse("<PubmedArticleSet>" + syntheticCitation("999") + "</PubmedArticleSet>"), nil
		case 4:
			return nil, fmt.Errorf("synthetic network interruption")
		}
		ids := strings.Split(r.URL.Query().Get("id"), ",")
		body := ""
		for i := len(ids) - 1; i >= 0; i-- {
			if ids[i] != "4" {
				body += syntheticCitation(ids[i])
			}
		}
		return syntheticSearchResponse("<PubmedArticleSet>" + body + "</PubmedArticleSet>"), nil
	})}
	// The injected transport is entirely synthetic. Preserve real request-budget rows.
	budgetRows, e := s.rows(ctx, "SELECT provider,day,requests FROM ld_source_usage")
	if e != nil {
		t.Fatal(e)
	}
	var next time.Time
	db.QueryRow(ctx, "SELECT next_at FROM ld_source_budget WHERE name='ncbi'").Scan(&next)
	must("DELETE FROM ld_source_usage")
	must("UPDATE ld_source_budget SET next_at=now() WHERE name='ncbi'")
	defer func() {
		must("DELETE FROM ld_source_usage")
		for _, r := range budgetRows {
			must("INSERT INTO ld_source_usage VALUES($1,$2,$3)", r["provider"], r["day"], r["requests"])
		}
		must("UPDATE ld_source_budget SET next_at=$1 WHERE name='ncbi'", next)
	}()
	request := newUUID()
	run, e := s.queueSearch(ctx, lib, "SYNTHETIC physician query", 5, request)
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, e := s.queueSearch(ctx, lib, "SYNTHETIC physician query", 5, request)
			if e != nil {
				errs <- e
			} else if id != run {
				errs <- fmt.Errorf("duplicate run")
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	if _, e = s.queueSearch(ctx, lib, "altered", 5, request); e == nil {
		t.Fatal("altered UUID accepted")
	}
	s.cfg.SearchContinuationEnabled = false
	s.cfg.SearchEnabled = false
	if id, e := s.queueSearch(ctx, lib, "SYNTHETIC physician query", 5, request); e != nil || id != run {
		t.Fatal("disabled prior receipt", e)
	}
	if _, e := s.queueSearch(ctx, lib, "SYNTHETIC new while disabled", 5, newUUID()); e == nil {
		t.Fatal("disabled unknown request admitted")
	}
	s.cfg.SearchContinuationEnabled = true
	s.cfg.SearchEnabled = true
	if e = migrate(true, false); e == nil {
		t.Fatal("populated rollback accepted")
	}
	work := func() { must("UPDATE ld_source_budget SET next_at=now() WHERE name='ncbi'"); s.workOne(ctx) }
	view := func() *continuationView {
		t.Helper()
		v, e := s.continuationStatus(ctx, lib, run)
		if e != nil || v == nil {
			t.Fatal("view", e)
		}
		return v
	}
	work()
	v := view()
	if v.State != "ready" || v.Processed != 5 || v.Saved != 4 || v.Missing != 1 || v.Provider != 12 || !v.CanContinue || calls.Load() != 2 {
		t.Fatalf("first page %#v calls%d", v, calls.Load())
	}
	// Two concurrent schedulers cannot create a second page without explicit admission.
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); s.workOne(ctx) }()
	}
	wg.Wait()
	if calls.Load() != 2 {
		t.Fatal("poll/scheduler hidden acquisition")
	}
	type admission struct {
		action  continuationAction
		receipt continuationReceipt
		err     error
	}
	admissions := make(chan admission, 2)
	startAdmissions := make(chan struct{})
	for i := 0; i < 2; i++ {
		next := continuationAction{RequestID: newUUID(), Revision: v.Revision, Action: "continue"}
		go func() {
			<-startAdmissions
			r, e := s.controlContinuation(ctx, lib, run, next)
			admissions <- admission{next, r, e}
		}()
	}
	close(startAdmissions)
	var a continuationAction
	var receipt continuationReceipt
	success, conflict := 0, 0
	for i := 0; i < 2; i++ {
		r := <-admissions
		if r.err == nil {
			success++
			a, receipt = r.action, r.receipt
		} else if pe, ok := r.err.(*planError); ok && pe.Status == 409 {
			conflict++
		} else {
			t.Fatal(r.err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("concurrent fresh actions duplicated page admission", success, conflict)
	}
	replay, e := s.controlContinuation(ctx, lib, run, a)
	if e != nil || receipt != replay {
		t.Fatal("lost response replay")
	}
	changed := a
	changed.Action = "cancel"
	if _, e = s.controlContinuation(ctx, lib, run, changed); e == nil {
		t.Fatal("changed action accepted")
	}
	if _, e = s.controlContinuation(ctx, foreign, run, a); e == nil {
		t.Fatal("foreign library accepted")
	}
	// 429 is persisted; polling does not retry. Explicit retry retains the same offset.
	mode.Store(1)
	work()
	v = view()
	if v.State != "rate_wait" || v.Processed != 5 || !v.CanRetry {
		t.Fatalf("cooldown %#v", v)
	}
	before := calls.Load()
	s.workOne(ctx)
	if calls.Load() != before {
		t.Fatal("automatic retry")
	}
	if _, e = s.controlContinuation(ctx, lib, run, continuationAction{RequestID: newUUID(), Revision: v.Revision, Action: "retry"}); e != nil {
		t.Fatal(e)
	}
	mode.Store(2)
	must("UPDATE ld_source_budget SET next_at=now() WHERE name='ncbi'")
	done := make(chan struct{})
	go func() { s.workOne(ctx); close(done) }()
	<-entered
	v = view()
	if !v.CanCancel {
		t.Fatal("running cannot cancel")
	}
	if _, e = s.controlContinuation(ctx, lib, run, continuationAction{RequestID: newUUID(), Revision: v.Revision, Action: "cancel"}); e != nil {
		t.Fatal(e)
	}
	close(release)
	<-done
	v = view()
	if v.State != "cancelled" || v.Processed != 5 || v.Saved != 4 {
		t.Fatalf("late page escaped cancellation %#v", v)
	}
	if _, e = s.controlContinuation(ctx, lib, run, continuationAction{RequestID: newUUID(), Revision: v.Revision, Action: "continue"}); e != nil {
		t.Fatal(e)
	}
	mode.Store(0)
	work()
	v = view()
	if v.Processed != 10 || v.Saved != 9 {
		t.Fatalf("resume %#v", v)
	}
	if _, e = s.controlContinuation(ctx, lib, run, continuationAction{RequestID: newUUID(), Revision: v.Revision, Action: "continue"}); e != nil {
		t.Fatal(e)
	}
	work()
	v = view()
	if v.State != "exhausted" || v.Processed != 12 || v.Saved != 11 || v.CanContinue {
		t.Fatalf("exhausted %#v", v)
	}
	var ranks []int
	rows, e := db.Query(ctx, "SELECT rank FROM ld_results WHERE library_id=$1 AND run_id=$2 ORDER BY rank", lib, run)
	if e != nil {
		t.Fatal(e)
	}
	for rows.Next() {
		var n int
		rows.Scan(&n)
		ranks = append(ranks, n)
	}
	rows.Close()
	if fmt.Sprint(ranks) != "[1 2 3 5 6 7 8 9 10 11 12]" {
		t.Fatal("frozen order", ranks)
	}
	var pages int
	db.QueryRow(ctx, "SELECT count(*) FROM native_search_pages WHERE library_id=$1 AND run_id=$2", lib, run).Scan(&pages)
	if pages != 3 {
		t.Fatal("duplicate page", pages)
	}
	// Actual HTTP ownership, CSRF and projection use real persisted records.
	token := randomToken()
	csrf := newUUID()
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", digest(token), account, csrf)
	requestHTTP := func(method, path, body, csrfHeader string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, s.cfg.Origin+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: token})
		r.Header.Set("Origin", s.cfg.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF", csrfHeader)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	before = calls.Load()
	response := requestHTTP("GET", "/api/libraries/"+lib+"/runs/"+run+"?limit=2", "", "")
	if response.Code != 200 || strings.Contains(response.Body.String(), "RawXml") || strings.Contains(response.Body.String(), "FullTextMetadataXml") {
		t.Fatal("projection", response.Code)
	}
	if requestHTTP("GET", "/api/libraries/"+foreign+"/runs/"+run, "", "").Code != 404 {
		t.Fatal("foreign HTTP")
	}
	if requestHTTP("POST", "/api/libraries/"+lib+"/runs/"+run+"/continuation", `{}`, "").Code != 403 {
		t.Fatal("CSRF")
	}
	must("DELETE FROM ld_sessions WHERE token_hash=$1", digest(token))
	if requestHTTP("GET", "/api/libraries/"+lib+"/runs/"+run, "", "").Code != 401 {
		t.Fatal("session revoke")
	}
	if calls.Load() != before {
		t.Fatal("GET/control validation triggered source")
	}
	// A crashed initial query is terminal for this immutable run, not a new query.
	interrupted, e := s.queueSearch(ctx, lib, "SYNTHETIC interrupted", 5, newUUID())
	if e != nil {
		t.Fatal(e)
	}
	must("UPDATE native_search_windows SET started=true WHERE library_id=$1 AND run_id=$2", lib, interrupted)
	work()
	iv, e := s.continuationStatus(ctx, lib, interrupted)
	if e != nil || iv.State != "expired" || calls.Load() != before {
		t.Fatal("initial query repeated", e)
	}
	// Seed an explicitly synthetic frozen membership; exercise the real worker,
	// transactions and 100-record page boundary through the whole 1000 window.
	large, e := s.queueSearch(ctx, lib, "SYNTHETIC 25000 provider matches", 100, newUUID())
	if e != nil {
		t.Fatal(e)
	}
	ids := []string{}
	for i := 10001; i <= 11000; i++ {
		ids = append(ids, fmt.Sprint(i))
	}
	encoded, _ := json.Marshal(ids)
	must("UPDATE native_search_windows SET ids=$3,frozen=true,started=true,snapshot_at=now() WHERE library_id=$1 AND run_id=$2", lib, large, string(encoded))
	must("UPDATE ld_runs SET total=25000 WHERE library_id=$1 AND run_id=$2", lib, large)
	for page := 0; page < 10; page++ {
		work()
		lv, e := s.continuationStatus(ctx, lib, large)
		if e != nil || lv.Processed != (page+1)*100 || lv.Saved != (page+1)*100 {
			t.Fatal("large persisted page", page, e, lv)
		}
		if page < 9 {
			if _, e = s.controlContinuation(ctx, lib, large, continuationAction{RequestID: newUUID(), Revision: lv.Revision, Action: "continue"}); e != nil {
				t.Fatal(e)
			}
		} else if lv.State != "window_limited" || lv.CanContinue || lv.Provider != 25000 {
			t.Fatal("false full-provider completion", lv)
		}
	}
	// Wrong metadata identity never advances; interrupted attempts share the
	// same finite ceiling, and a stale lease cannot save against its replacement.
	bad, e := s.queueSearch(ctx, lib, "SYNTHETIC wrong response", 5, newUUID())
	if e != nil {
		t.Fatal(e)
	}
	mode.Store(3)
	for attempt := 1; attempt <= 3; attempt++ {
		work()
		bv, e := s.continuationStatus(ctx, lib, bad)
		if e != nil || bv.Saved != 0 || bv.Processed != 0 || bv.Attempts != attempt {
			t.Fatal("wrong identity mutated", attempt, bv, e)
		}
		if attempt < 3 {
			if _, e = s.controlContinuation(ctx, lib, bad, continuationAction{RequestID: newUUID(), Revision: bv.Revision, Action: "retry"}); e != nil {
				t.Fatal(e)
			}
		} else {
			if bv.CanRetry {
				t.Fatal("retry ceiling")
			}
			if _, e = s.controlContinuation(ctx, lib, bad, continuationAction{RequestID: newUUID(), Revision: bv.Revision, Action: "retry"}); e == nil {
				t.Fatal("ceiling admission")
			}
		}
	}
	transportRun, e := s.queueSearch(ctx, lib, "SYNTHETIC transport retry", 5, newUUID())
	if e != nil {
		t.Fatal(e)
	}
	mode.Store(4)
	work()
	tv, e := s.continuationStatus(ctx, lib, transportRun)
	if e != nil || tv.State != "failed" || !tv.CanRetry || tv.Processed != 0 {
		t.Fatal("transport failure stranded frozen membership", tv, e)
	}
	if _, e = s.controlContinuation(ctx, lib, transportRun, continuationAction{RequestID: newUUID(), Revision: tv.Revision, Action: "retry"}); e != nil {
		t.Fatal(e)
	}
	mode.Store(0)
	work()
	tv, e = s.continuationStatus(ctx, lib, transportRun)
	if e != nil || tv.Saved != 4 || tv.Processed != 5 || tv.State != "ready" {
		t.Fatal("explicit transport retry did not recover", tv, e)
	}
	// Large existing raw provenance is synthesized inside PostgreSQL rather than
	// loaded into the app. A new page over the run budget must roll back entirely.
	budgetRun, e := s.queueSearch(ctx, lib, "SYNTHETIC metadata budget", 1, newUUID())
	if e != nil {
		t.Fatal(e)
	}
	largeID := newID("LD-")
	must("INSERT INTO ld_records VALUES($1,$2,json_build_object('SearchId',$2::text,'Pmid','20000','Title','SYNTHETIC large prior source','RawXml',repeat('x',33*1024*1024))::text,'SYNTHETIC large prior source')", lib, largeID)
	must("INSERT INTO ld_identifiers VALUES($1,'pmid','20000',$2)", lib, largeID)
	must("INSERT INTO ld_results VALUES($1,$2,$3,1)", lib, budgetRun, largeID)
	must(`UPDATE native_search_windows SET ids='["20000","20001"]',frozen=true,started=true,next_offset=1,snapshot_at=now() WHERE library_id=$1 AND run_id=$2`, lib, budgetRun)
	must("UPDATE ld_runs SET total=2,fetched=1 WHERE library_id=$1 AND run_id=$2", lib, budgetRun)
	var hashBefore, hashAfter string
	if e := db.QueryRow(ctx, "SELECT md5(metadata) FROM ld_records WHERE library_id=$1 AND search_id=$2", lib, largeID).Scan(&hashBefore); e != nil || len(hashBefore) != 32 {
		t.Fatal("prior metadata digest", e)
	}
	work()
	bv, e := s.continuationStatus(ctx, lib, budgetRun)
	if e != nil || bv.Saved != 1 || bv.Processed != 1 || bv.State != "failed" || !strings.Contains(bv.Reason, "32 MiB") {
		t.Fatal("metadata budget truncation", bv, e)
	}
	var leaked int
	if e := db.QueryRow(ctx, "SELECT count(*) FROM ld_identifiers WHERE library_id=$1 AND kind='pmid' AND value='20001'", lib).Scan(&leaked); e != nil {
		t.Fatal(e)
	}
	if leaked != 0 {
		t.Fatal("overbudget page record escaped rollback")
	}
	if e := db.QueryRow(ctx, "SELECT md5(metadata) FROM ld_records WHERE library_id=$1 AND search_id=$2", lib, largeID).Scan(&hashAfter); e != nil {
		t.Fatal(e)
	}
	if hashAfter != hashBefore {
		t.Fatal("prior raw provenance changed")
	}
	// Actual transactional write failure is operational503, not a definitive409.
	// The same UUID can be retried after recovery and still admits one run only.
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", digest(token), account, csrf)
	faultRequest := newUUID()
	must(`CREATE FUNCTION native_continuation_admission_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC admission storage failure'; END $$`)
	must(`CREATE TRIGGER native_continuation_admission_fault BEFORE INSERT ON native_search_windows FOR EACH ROW EXECUTE FUNCTION native_continuation_admission_fault()`)
	defer func() {
		must("DROP TRIGGER IF EXISTS native_continuation_admission_fault ON native_search_windows")
		must("DROP FUNCTION IF EXISTS native_continuation_admission_fault()")
	}()
	body, _ := json.Marshal(map[string]any{"query": "SYNTHETIC recovered admission", "limit": 5, "requestID": faultRequest})
	failed := requestHTTP("POST", "/api/libraries/"+lib+"/search", string(body), csrf)
	if failed.Code != 503 {
		t.Fatal("operational admission mislabeled", failed.Code)
	}
	var admitted int
	db.QueryRow(ctx, "SELECT count(*) FROM ld_runs WHERE library_id=$1 AND input='SYNTHETIC recovered admission'", lib).Scan(&admitted)
	if admitted != 0 {
		t.Fatal("partial admission escaped rollback")
	}
	must("DROP TRIGGER native_continuation_admission_fault ON native_search_windows")
	must("DROP FUNCTION native_continuation_admission_fault()")
	recovered := requestHTTP("POST", "/api/libraries/"+lib+"/search", string(body), csrf)
	replayed := requestHTTP("POST", "/api/libraries/"+lib+"/search", string(body), csrf)
	if recovered.Code != 200 || replayed.Code != 200 || recovered.Body.String() != replayed.Body.String() {
		t.Fatal("same UUID recovery", recovered.Code, replayed.Code)
	}
	db.QueryRow(ctx, "SELECT count(*) FROM ld_runs WHERE library_id=$1 AND input='SYNTHETIC recovered admission'", lib).Scan(&admitted)
	if admitted != 1 {
		t.Fatal("duplicate recovered run")
	}
	t.Logf("Actual PostgreSQL:12 frozen positions/11 saved/1 missing/3 pages plus1000 saved/10 pages/25000 synthetic total; concurrent UUID,503 rollback/replay,429,transport recovery,retry ceiling,cancel-late-response,expiry,projection,ownership; synthetic provider calls=%d", calls.Load())
}
