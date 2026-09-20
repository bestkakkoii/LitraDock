package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The explicit native test authority targets only a fresh schema in a dedicated
// fixture database. Provider traffic is blocked both in-process and by the runner.
func TestQueryCaptureActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Dedicated isolated PostgreSQL configuration absent")
	}
	raw, err := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if err != nil {
		t.Fatal("private test config unavailable")
	}
	var cfg config
	if json.Unmarshal(raw, &cfg) != nil {
		t.Fatal("invalid test config")
	}
	pc, err := pgxpool.ParseConfig(cfg.Database)
	if err != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_test_") {
		t.Fatal("isolated native test database required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	admin, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		t.Fatal(err)
	}
	schema := "native_capture_test_" + strings.ReplaceAll(newUUID(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	admin.Close()
	pc.ConnConfig.RuntimeParams["search_path"] = schema
	pc.ConnConfig.RuntimeParams["statement_timeout"] = "60000"
	pc.MaxConns = 8
	db, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	t.Log("Retained SYNTHETIC ONLY schema", schema)
	must := func(q string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	for _, sql := range []string{nativeSchema, multirunSchema, continuationSchema, bundleSchema, savedSnapshotSchema, runSelectionSchema, userRouteSchema} {
		must(sql)
	}
	account, foreignAccount, library, foreign := newUUID(), newUUID(), newUUID(), newUUID()
	must("INSERT INTO ld_accounts VALUES($1,$2,'unused',true),($3,$4,'unused',true)", account, "synthetic-capture-"+account, foreignAccount, "synthetic-foreign-"+foreignAccount)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC CAPTURE',true),($3,$4,'SYNTHETIC FOREIGN',true)", library, account, foreign, foreignAccount)
	token := randomToken()
	sess := &session{Account: account, CSRF: newUUID(), Hash: digest(token)}
	other := &session{Account: account, CSRF: newUUID(), Hash: digest(randomToken())}
	for _, v := range []*session{sess, other} {
		must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", v.Hash, v.Account, v.CSRF)
	}
	ctx = context.WithValue(ctx, snapshotSessionKey{}, sess)
	var sourceCalls atomic.Int32
	s := &server{native: true, continuation: true, runSelection: true, savedSnapshots: true, bundles: true, userRoute: true, db: db,
		cfg:   config{LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour), SearchEnabled: true, SearchContinuationEnabled: true, SelectionWriteEnabled: true, UserRouteEnabled: true, StagedQueryEnabled: true, PlanEnabled: true, PDFEnabled: true, AcquisitionEnabled: true},
		slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{Transport: nativeTransport(func(*http.Request) (*http.Response, error) {
			sourceCalls.Add(1)
			return nil, errors.New("real provider traffic forbidden")
		})}}
	query := `("SYNTHETIC ONLY"[Title] OR fixture[MeSH Terms]) NOT review[pt] AND 2020:2026[dp]`
	status := func(run string) *continuationView {
		t.Helper()
		v, e := s.continuationStatus(ctx, library, run)
		if e != nil || v == nil {
			t.Fatal("status", e)
		}
		return v
	}
	claim := func(run string) userRouteDescriptor {
		t.Helper()
		must("UPDATE native_user_route_budget SET next_at=now(),cooldown_until=now() WHERE session_hash=$1", sess.Hash)
		v := status(run)
		d, e := s.claimUserRoute(ctx, library, run, userRouteClaim{newUUID(), v.Revision}, sess)
		if e != nil {
			t.Fatal("claim", v, e)
		}
		return d
	}
	upload := func(run string, d userRouteDescriptor, body []byte) continuationReceipt {
		t.Helper()
		v, e := s.submitUserRoute(ctx, library, run, userRouteUpload{AttemptID: d.AttemptID, Body: body}, sess)
		if e != nil {
			t.Fatal("upload", e)
		}
		return v
	}
	action := func(run, verb string) continuationReceipt {
		t.Helper()
		v, e := s.controlContinuation(ctx, library, run, continuationAction{RequestID: newUUID(), Revision: status(run).Revision, Action: verb})
		if e != nil {
			t.Fatal("action", verb, e)
		}
		return v
	}
	queue := func(total int) string {
		t.Helper()
		run, e := s.queueUserSearch(ctx, library, query, 100, newUUID(), "unkeyed")
		if e != nil {
			t.Fatal(e)
		}
		upload(run, claim(run), syntheticCaptureXML(total, 900000001, min(total, 1000)))
		return run
	}
	metadata := func(ids []string, omit string) []byte {
		var b strings.Builder
		b.WriteString("<PubmedArticleSet>")
		for _, id := range ids {
			if id != omit {
				b.WriteString(syntheticCitation(id))
			}
		}
		b.WriteString("</PubmedArticleSet>")
		return []byte(b.String())
	}
	// Preserve accepted schema10 records and selection across the new migration.
	run := queue(10001)
	first := claim(run)
	upload(run, first, metadata(strings.Split(first.Parameters["id"], ","), "900000002"))
	selection, err := s.readRunSelection(ctx, library, run)
	if err != nil || selection.SavedCount != 99 {
		t.Fatal("baseline selection", selection, err)
	}
	excluded := selection.SelectedIDs[0]
	no := false
	if _, err = s.changeRunSelection(ctx, library, run, runSelectionAction{RequestID: newUUID(), Revision: selection.Revision, Action: "set", IDs: []string{excluded}, Selected: &no}); err != nil {
		t.Fatal(err)
	}
	plan, err := s.queuePlan(ctx, library, newUUID(), run, selection.SelectedIDs[:2], "pdf")
	if err != nil {
		t.Fatal("immutable PDF plan", err)
	}
	var before string
	if err = db.QueryRow(ctx, "SELECT md5(string_agg(metadata,',' ORDER BY search_id)) FROM ld_records WHERE library_id=$1", library).Scan(&before); err != nil {
		t.Fatal(err)
	}
	migrate := func(back bool) error {
		tx, e := db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(context.Background())
		if e = migrateQueryCapture(ctx, tx, back); e != nil {
			return e
		}
		return tx.Commit(ctx)
	}
	if err = migrate(false); err != nil {
		t.Fatal(err)
	}
	if err = migrate(true); err != nil {
		t.Fatal("empty rollback", err)
	}
	if err = migrate(false); err != nil {
		t.Fatal(err)
	}
	s.stagedQuery = true
	var after string
	if err = db.QueryRow(ctx, "SELECT md5(string_agg(metadata,',' ORDER BY search_id)) FROM ld_records WHERE library_id=$1", library).Scan(&after); err != nil || after != before {
		t.Fatal("migration changed metadata", err)
	}
	// Concurrent duplicate action has one intent; competing revisions cannot erase it.
	v := status(run)
	intent := continuationAction{RequestID: newUUID(), Revision: v.Revision, Action: "capture"}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := s.controlContinuation(ctx, library, run, intent); e != nil {
				t.Error("duplicate capture action", e)
			}
		}()
	}
	wg.Wait()
	if _, err = s.controlContinuation(ctx, library, run, continuationAction{RequestID: newUUID(), Revision: v.Revision, Action: "capture"}); err == nil {
		t.Fatal("stale revision won")
	}
	d := claim(run)
	if d.CaptureSegment != 1 || d.Parameters["retmax"] != "9999" || d.Parameters["term"] != query || d.Parameters["retstart"] != "0" || d.Parameters["sort"] != "relevance" {
		t.Fatal("capture changed meaning", d)
	}
	if _, err = s.submitUserRoute(ctx, library, run, userRouteUpload{AttemptID: d.AttemptID, Body: syntheticCaptureXML(10001, 900000001, 9999)}, other); err == nil {
		t.Fatal("foreign session upload accepted")
	}
	action(run, "cancel")
	if _, err = s.submitUserRoute(ctx, library, run, userRouteUpload{AttemptID: d.AttemptID, Body: syntheticCaptureXML(10001, 900000001, 9999)}, sess); err == nil {
		t.Fatal("late cancelled capture accepted")
	}
	action(run, "capture")
	d = claim(run)
	for _, invalid := range [][]byte{
		syntheticCaptureXML(10001, 900000001, 9998),
		bytes.Replace(syntheticCaptureXML(10001, 900000001, 9999), []byte("</eSearchResult>"), []byte("<WarningList><PhraseNotFound>SYNTHETIC</PhraseNotFound></WarningList></eSearchResult>"), 1),
		bytes.Replace(syntheticCaptureXML(10001, 900000001, 9999), []byte("</eSearchResult>"), []byte("<ErrorList><FieldNotFound>SYNTHETIC</FieldNotFound></ErrorList></eSearchResult>"), 1),
		bytes.Replace(syntheticCaptureXML(10001, 900000001, 9999), []byte("</eSearchResult>"), []byte("<WarningList>SYNTHETIC query terms were ignored.<OutputMessage>Restrictions achieved. start and count adjusted to 0, 9999</OutputMessage></WarningList></eSearchResult>"), 1),
		bytes.Replace(syntheticCaptureXML(10001, 900000001, 9999), []byte("<IdList>"), []byte("<IdList>SYNTHETIC omitted identities."), 1),
	} {
		if _, e := s.submitUserRoute(ctx, library, run, userRouteUpload{AttemptID: d.AttemptID, Body: invalid}, sess); e == nil {
			t.Fatal("invalid capture committed")
		}
		if got := status(run); got.WindowCount != 1000 || got.Revision != d.Revision || got.Capture.PendingSegments != 1 {
			t.Fatal("refused capture changed membership, revision or frontier", got)
		}
		if chosen, e := s.readRunSelection(ctx, library, run); e != nil || chosen.SelectedCount != 98 || slices.Contains(chosen.SelectedIDs, excluded) {
			t.Fatal("refused capture changed the saved exact exclusion", e)
		}
	}
	rootReceipt := upload(run, d, syntheticCaptureXML(10001, 900000001, 9999))
	if again := upload(run, d, syntheticCaptureXML(10001, 900000001, 9999)); again != rootReceipt {
		t.Fatal("upload replay changed progress")
	}
	if status(run).WindowCount != 1000 || status(run).Capture.PendingSegments != 2 {
		t.Fatal("oversized root was silently truncated or appended")
	}
	// Complete date partitions can cover >10000; retained initial IDs are deduped.
	action(run, "capture")
	d = claim(run)
	upload(run, d, syntheticCaptureXML(9999, 900000001, 9999))
	action(run, "capture")
	d = claim(run)
	if !strings.Contains(d.Parameters["term"], " NOT (1800/01/01:") {
		t.Fatal("outside-range residual omitted")
	}
	upload(run, d, syntheticCaptureXML(2, 900010000, 2))
	v = status(run)
	if v.WindowCount != 10001 || v.Saved != 99 || v.Missing != 1 || v.Capture.State != "complete" || v.Capture.CanCapture {
		t.Fatal("beyond-boundary capture counts", v)
	}
	selection, err = s.readRunSelection(ctx, library, run)
	if err != nil || selection.SelectedCount != 98 || slices.Contains(selection.SelectedIDs, excluded) {
		t.Fatal("capture altered choices", err)
	}
	if err = migrate(true); err == nil {
		t.Fatal("used rollback discarded capture state")
	}
	// Resume metadata under the old selection policy, while preserving prior PDF membership.
	action(run, "continue")
	d = claim(run)
	upload(run, d, metadata(strings.Split(d.Parameters["id"], ","), ""))
	selection, err = s.readRunSelection(ctx, library, run)
	if err != nil || selection.SelectedCount != 198 || slices.Contains(selection.SelectedIDs, excluded) {
		t.Fatal("new metadata lost default or exception", err)
	}
	var planCount int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM native_plan_items WHERE library_id=$1 AND plan_id=$2", library, plan.PlanID).Scan(&planCount); err != nil || planCount != 2 {
		t.Fatal("existing PDF plan changed", err)
	}
	// Cross-account/library/run controls, then a genuine HTTP authenticated positive control.
	if _, _, err = s.captureExportSnapshot(ctx, foreign, run, "all", selection.Revision, status(run).Revision, 0, 100, false); err == nil {
		t.Fatal("foreign library export")
	}
	badContext := context.WithValue(ctx, snapshotSessionKey{}, &session{Account: foreignAccount, Hash: sess.Hash, CSRF: sess.CSRF})
	if _, _, err = s.captureExportSnapshot(badContext, library, run, "all", selection.Revision, status(run).Revision, 0, 100, false); err == nil {
		t.Fatal("foreign account export")
	}
	if _, _, err = s.captureExportSnapshot(ctx, library, newID("RUN-"), "all", selection.Revision, status(run).Revision, 0, 100, false); err == nil {
		t.Fatal("foreign run export")
	}
	manifest, _, err := s.captureExportSnapshot(ctx, library, run, "", 0, 0, 0, 100, true)
	if err != nil || len(manifest.Members) != 10001 || manifest.Members[1].State != "missing" || manifest.Members[1].URL != "https://pubmed.ncbi.nlm.nih.gov/900000002/" {
		t.Fatal("missing membership export", err)
	}
	for _, format := range []string{"csv", "xlsx", "json", "jsonl"} {
		part, rows, e := s.captureExportSnapshot(ctx, library, run, "selected", selection.Revision, status(run).Revision, 100, 100, false)
		if e != nil || part.Count != 98 || part.Remaining != 0 || part.Complete {
			t.Fatal("exact partial selection scope", format, e)
		}
		data, _, e := encodeCapturePart(ctx, part, rows, format)
		if e != nil || len(data) == 0 {
			t.Fatal("part encode", format, e)
		}
		archive, info, e := s.captureArchive(ctx, library, run, "selected", format, selection.Revision, status(run).Revision, 100)
		if e != nil || info.Count != 198 || len(info.Members) != 198 || len(info.Files) != 2 {
			t.Fatal("whole archive", format, e)
		}
		zr, e := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if e != nil {
			t.Fatal(e)
		}
		for _, file := range info.Files {
			found := false
			for _, member := range zr.File {
				if member.Name == file.Name {
					reader, e := member.Open()
					if e != nil {
						t.Fatal(e)
					}
					content, e := io.ReadAll(reader)
					reader.Close()
					if e != nil {
						t.Fatal(e)
					}
					hash := sha256.Sum256(content)
					if hex.EncodeToString(hash[:]) != file.SHA256 {
						t.Fatal("archive member hash")
					}
					found = true
				}
			}
			if !found {
				t.Fatal("archive member missing")
			}
		}
	}
	request := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/libraries/%s/runs/%s/capture-export?format=manifest", library, run), nil)
	request.Host = "127.0.0.1:18089"
	request.AddCookie(&http.Cookie{Name: s.cookieName(), Value: token})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, request)
	if w.Code != http.StatusOK {
		t.Fatal("authenticated manifest HTTP", w.Code, w.Body.String())
	}
	request = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/libraries/%s/runs/%s/capture-export?format=manifest", foreign, run), nil)
	request.Host = "127.0.0.1:18089"
	request.AddCookie(&http.Cookie{Name: s.cookieName(), Value: token})
	w = httptest.NewRecorder()
	s.ServeHTTP(w, request)
	if w.Code == http.StatusOK {
		t.Fatal("foreign library HTTP")
	}
	// Saved observations can exceed a later source total: old IDs must survive.
	for _, count := range []int{100, 1000, 9999, 10000, 10001, 20001} {
		r := queue(count)
		action(r, "cancel")
		action(r, "capture")
		desc := claim(r)
		upload(r, desc, syntheticCaptureXML(count, 900000001, min(count, 9999)))
		got := status(r)
		if count <= 9999 && (got.WindowCount != count || got.Capture.State != "complete") {
			t.Fatal("boundary membership", count, got)
		}
		if count > 9999 && (got.WindowCount != 1000 || got.Capture.State != "ready") {
			t.Fatal("oversized capture silently complete", count, got)
		}
		if count == 20001 {
			action(r, "capture")
			upload(r, claim(r), syntheticCaptureXML(9999, 900001001, 9999))
			action(r, "capture")
			upload(r, claim(r), syntheticCaptureXML(9999, 900011000, 9999))
			got = status(r)
			if got.WindowCount != 10999 || got.Capture.State != "limited" || !strings.Contains(got.Capture.Reason, "20,000") {
				t.Fatal("local capacity silently dropped part of a leaf", got)
			}
		}
	}
	interrupted := queue(10)
	action(interrupted, "cancel")
	action(interrupted, "capture")
	pending := claim(interrupted)
	if _, e := s.recoverUserRoute(ctx, library, interrupted, pending.AttemptID); e == nil {
		t.Fatal("valid source lease was interrupted")
	}
	must("UPDATE ld_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE library_id=$1 AND run_id=$2", library, interrupted)
	if _, e := s.recoverUserRoute(ctx, library, interrupted, pending.AttemptID); e != nil {
		t.Fatal("expired capture recovery", e)
	}
	// 模擬舊版保留的 metadata-only 說明；新讀取投影辨識 capture，原列仍保留。
	legacyReason := "Browser attempt ended without a saved response. Explicitly retry only the frozen metadata page."
	must("UPDATE ld_runs SET reason=$3 WHERE library_id=$1 AND run_id=$2", library, interrupted, legacyReason)
	if recovered := status(interrupted); !strings.Contains(recovered.Reason, "ID capture is unfinished") || !recovered.Capture.CanCapture || recovered.CanRetry {
		t.Fatal("interrupted capture was mislabeled as a metadata retry", recovered)
	}
	var retainedReason string
	if e := db.QueryRow(ctx, "SELECT reason FROM ld_runs WHERE library_id=$1 AND run_id=$2", library, interrupted).Scan(&retainedReason); e != nil || retainedReason != legacyReason {
		t.Fatal("reading recovery rewrote the retained historical reason", e)
	}
	if _, e := s.submitUserRoute(ctx, library, interrupted, userRouteUpload{AttemptID: pending.AttemptID, Body: syntheticCaptureXML(10, 900000001, 10)}, sess); e == nil {
		t.Fatal("late interrupted capture committed")
	}
	for i := 0; i < 2; i++ {
		action(interrupted, "capture")
		pending = claim(interrupted)
		if _, e := s.submitUserRoute(ctx, library, interrupted, userRouteUpload{AttemptID: pending.AttemptID, Failure: "network_unavailable"}, sess); e != nil {
			t.Fatal("capture failure receipt", e)
		}
	}
	if v := status(interrupted); v.Capture.State != "limited" || v.Capture.CanCapture || !v.CanContinue || v.WindowCount != 10 {
		t.Fatal("capture ceiling stranded previous IDs", v)
	}
	action(interrupted, "continue")
	pending = claim(interrupted)
	if pending.CaptureSegment != 0 || pending.Stage != "efetch" {
		t.Fatal("metadata after capture limit used source search")
	}
	upload(interrupted, pending, metadata(strings.Split(pending.Parameters["id"], ","), ""))
	// Fixture-only large saved membership qualifies pagination/selection/export
	// capacity separately from the actual provider/metadata transport tests above.
	large := queue(20000)
	action(large, "cancel")
	action(large, "capture")
	upload(large, claim(large), syntheticCaptureXML(20000, 900000001, 9999))
	action(large, "capture")
	upload(large, claim(large), syntheticCaptureXML(19998, 900000001, 9999))
	action(large, "capture")
	upload(large, claim(large), syntheticCaptureXML(9999, 900000001, 9999))
	action(large, "capture")
	upload(large, claim(large), syntheticCaptureXML(9999, 900010000, 9999))
	action(large, "capture")
	upload(large, claim(large), syntheticCaptureXML(2, 900019999, 2))
	if status(large).WindowCount != 20000 || status(large).Capture.State != "complete" {
		t.Fatal("20000-ID complete bounded fixture")
	}
	// Seed independently labeled tiny metadata via SQL for the full selection-size
	// test, retaining any previously genuine fixture-transport canonical records.
	must(`INSERT INTO ld_records(library_id,search_id,metadata,title)
SELECT $1,'SYNTHETIC-CAPTURE-'||n,jsonb_build_object('SearchId','SYNTHETIC-CAPTURE-'||n,'Pmid',(900000000+n)::text,'Title','SYNTHETIC ONLY record '||n,'Authors','王; Fixture','Year','2026','Doi','10.1234/synthetic-'||n,'Pmcid','PMC'||(900000000+n))::text,'SYNTHETIC ONLY record '||n FROM generate_series(1,20000) n
WHERE NOT EXISTS(SELECT 1 FROM ld_records WHERE library_id=$1 AND metadata::jsonb->>'Pmid'=(900000000+n)::text)`, library)
	must("UPDATE native_search_windows SET next_offset=20000,missing='[]',state='exhausted',revision=revision+1 WHERE library_id=$1 AND run_id=$2", library, large)
	must(`INSERT INTO ld_identifiers(library_id,kind,value,search_id) SELECT library_id,'pmid',metadata::jsonb->>'Pmid',search_id FROM ld_records WHERE library_id=$1 AND search_id LIKE 'SYNTHETIC-CAPTURE-%'`, library)
	// 大量一次注入是測試資料準備；提供準確統計，避免全新空表的
	// 舊估計主導 fixture 連接，而非量測已準備資料上的應用程式行為。
	must("ANALYZE ld_identifiers; ANALYZE native_query_capture_members; ANALYZE ld_records")
	must(`INSERT INTO ld_results SELECT $1,$2,i.search_id,m.ordinal FROM native_query_capture_members m JOIN ld_identifiers i ON i.library_id=m.library_id AND i.kind='pmid' AND i.value=m.pmid WHERE m.library_id=$1 AND m.run_id=$2`, library, large)
	must("ANALYZE ld_results")
	must("UPDATE ld_runs SET fetched=20000,state='complete' WHERE library_id=$1 AND run_id=$2", library, large)
	largeSelection, e := s.readRunSelection(ctx, library, large)
	if e != nil || largeSelection.SelectedCount != 20000 || largeSelection.RecordsComplete {
		t.Fatal("large exact selection", e)
	}
	page, e := s.savedRunPage(ctx, library, large, 19975, 25)
	if e != nil {
		t.Fatal("last metadata page", e)
	}
	pageBytes, _ := json.Marshal(page)
	if len(pageBytes) > 100000 {
		t.Fatal("last page response unbounded")
	}
	start := time.Now()
	runtime.GC()
	var beforeMemory, afterMemory runtime.MemStats
	runtime.ReadMemStats(&beforeMemory)
	archive, info, e := s.captureArchive(ctx, library, large, "all", "csv", largeSelection.Revision, status(large).Revision, 1000)
	runtime.ReadMemStats(&afterMemory)
	if e != nil || info.Count != 20000 || len(info.Files) != 20 || len(archive) > captureArchiveBytes || time.Since(start) >= 60*time.Second {
		t.Fatal("large bounded archive", e)
	}
	t.Logf("SYNTHETIC ONLY 20000 saved IDs; CSV ZIP bytes=%d, parts=%d, elapsed=%s, heap_after=%d, total_alloc_delta=%d, last_page_bytes=%d", len(archive), len(info.Files), time.Since(start), afterMemory.HeapAlloc, afterMemory.TotalAlloc-beforeMemory.TotalAlloc, len(pageBytes))
	// Scope fences and disabled admission do not erase saved export data.
	if _, _, e = s.captureExportSnapshot(ctx, library, large, "all", largeSelection.Revision-1, status(large).Revision, 0, 1000, false); e == nil {
		t.Fatal("stale selection export")
	}
	if _, _, e = s.captureExportSnapshot(ctx, library, large, "all", largeSelection.Revision, status(large).Revision-1, 0, 1000, false); e == nil {
		t.Fatal("stale capture export")
	}
	s.cfg.StagedQueryEnabled = false
	if _, e = s.controlContinuation(ctx, library, large, continuationAction{RequestID: newUUID(), Revision: status(large).Revision, Action: "capture"}); e == nil {
		t.Fatal("disabled capture admission")
	}
	if _, _, e = s.captureExportSnapshot(ctx, library, large, "all", largeSelection.Revision, status(large).Revision, 0, 1000, false); e != nil {
		t.Fatal("containment removed saved export", e)
	}
	// A4-NATIVE023B-FINDING-001：確認已保存的同一批 ID 不得把完整
	// run 永久標為 partial；同時保留缺失 metadata 的反例。
	s.cfg.StagedQueryEnabled = true
	for i, missing := range []bool{false, true} {
		t.Run(fmt.Sprintf("already_saved_missing_%v", missing), func(t *testing.T) {
			id := fmt.Sprint(940000001 + i)
			completeRun, e := s.queueUserSearch(ctx, library, query, 100, newUUID(), "unkeyed")
			if e != nil {
				t.Fatal(e)
			}
			upload(completeRun, claim(completeRun), syntheticCaptureXML(1, 940000001+i, 1))
			omit := ""
			if missing {
				omit = id
			}
			upload(completeRun, claim(completeRun), metadata([]string{id}, omit))
			choice, e := s.readRunSelection(ctx, library, completeRun)
			if e != nil {
				t.Fatal(e)
			}
			action(completeRun, "capture")
			upload(completeRun, claim(completeRun), syntheticCaptureXML(1, 940000001+i, 1))
			var runState string
			if e = db.QueryRow(ctx, "SELECT state FROM ld_runs WHERE library_id=$1 AND run_id=$2", library, completeRun).Scan(&runState); e != nil {
				t.Fatal(e)
			}
			want := "complete"
			if missing {
				want = "partial"
			}
			v := status(completeRun)
			after, e := s.readRunSelection(ctx, library, completeRun)
			if runState != want || v.State != "exhausted" || v.Capture.State != "complete" || e != nil || after.Revision != choice.Revision || !slices.Equal(after.SelectedIDs, choice.SelectedIDs) {
				t.Fatal("capture changed honest completion or exact choices", runState, want, e)
			}
		})
	}
	if sourceCalls.Load() != 0 {
		t.Fatal("test used provider network")
	}
}
