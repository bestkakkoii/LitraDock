package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xuri/excelize/v2"
)

// 所有來源內容都是明確標示的合成資料；測試程序另由 localhost 網路限制隔離。
func TestUserRouteActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Dedicated isolated PostgreSQL configuration absent")
	}
	raw, err := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if err != nil {
		t.Fatal("protected test configuration unavailable")
	}
	var cfg config
	if json.Unmarshal(raw, &cfg) != nil {
		t.Fatal("invalid test configuration")
	}
	pc, err := pgxpool.ParseConfig(cfg.Database)
	if err != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_test_") {
		t.Fatal("dedicated test target required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	admin, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		t.Fatal(err)
	}
	schema := "native_user_route_test_" + strings.ReplaceAll(newUUID(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	admin.Close()
	pc.ConnConfig.RuntimeParams["search_path"] = schema
	pc.MaxConns = 8
	db, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	t.Log("Retained SYNTHETIC ONLY schema", schema)
	must := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	must(nativeSchema)
	must(multirunSchema)
	must(continuationSchema)
	must(bundleSchema)
	must(savedSnapshotSchema)
	must(runSelectionSchema)
	migrate := func(back, commit bool) error {
		tx, e := db.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(context.Background())
		if e = migrateUserRoute(ctx, tx, back); e != nil {
			return e
		}
		if commit {
			return tx.Commit(ctx)
		}
		return nil
	}
	if err = migrate(false, false); err != nil {
		t.Fatal(err)
	}
	var version int
	if err = db.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); err != nil || version != 9 {
		t.Fatal("uncommitted migration escaped", version, err)
	}
	for _, back := range []bool{false, false, true, false} {
		if err = migrate(back, true); err != nil {
			t.Fatal(err)
		}
	}
	account, foreignAccount, library, foreign := newUUID(), newUUID(), newUUID(), newUUID()
	must("INSERT INTO ld_accounts VALUES($1,$2,'synthetic-unused',true),($3,$4,'synthetic-unused',true)", account, "synthetic-browser-"+account, foreignAccount, "synthetic-foreign-"+foreignAccount)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC BROWSER',true),($3,$4,'SYNTHETIC FOREIGN',true)", library, account, foreign, foreignAccount)
	token, csrf := randomToken(), newUUID()
	sess := &session{Account: account, CSRF: csrf, Hash: digest(token)}
	other := &session{Account: account, CSRF: newUUID(), Hash: digest(randomToken())}
	for _, v := range []*session{sess, other} {
		must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", v.Hash, v.Account, v.CSRF)
	}
	var calls atomic.Int32
	s := &server{native: true, continuation: true, runSelection: true, savedSnapshots: true, bundles: true, userRoute: true, db: db,
		cfg:   config{LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour), SearchEnabled: true, SearchContinuationEnabled: true, SelectionWriteEnabled: true, UserRouteEnabled: true, AcquisitionEnabled: true, PDFEnabled: true, PlanEnabled: true},
		slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1),
		provider: &http.Client{Transport: nativeTransport(func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			return nil, errors.New("all real provider traffic forbidden")
		})}}
	queue := func(mode string) string {
		t.Helper()
		run, e := s.queueUserSearch(ctx, library, "SYNTHETIC ONLY[Title] AND 2020:2026[dp]", 1, newUUID(), mode)
		if e != nil {
			t.Fatal(e)
		}
		return run
	}
	ready := func(v *session) {
		must("UPDATE native_user_route_budget SET next_at=now(),cooldown_until=now() WHERE session_hash=$1", v.Hash)
	}
	claimNext := func(run string, v *session) userRouteDescriptor {
		t.Helper()
		ready(v)
		status, e := s.continuationStatus(ctx, library, run)
		if e != nil {
			t.Fatal(e)
		}
		d, e := s.claimUserRoute(ctx, library, run, userRouteClaim{newUUID(), status.Revision}, v)
		if e != nil {
			t.Fatal(e)
		}
		return d
	}
	upload := func(run string, d userRouteDescriptor, b []byte) continuationReceipt {
		t.Helper()
		r, e := s.submitUserRoute(ctx, library, run, userRouteUpload{AttemptID: d.AttemptID, Body: b}, sess)
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	membership := []byte(`<eSearchResult><Count>2</Count><IdList><Id>990000001</Id><Id>990000002</Id></IdList><QueryTranslation>SYNTHETIC ONLY[Title] AND 2020:2026[dp]</QueryTranslation></eSearchResult>`)
	metadata := syntheticUserRouteMetadata(t)
	run := queue("unkeyed")
	s.workOne(ctx)
	status, e := s.continuationStatus(ctx, library, run)
	if e != nil || !status.CanStart || status.Execution != userRouteExecution || calls.Load() != 0 {
		t.Fatal("server worker consumed browser job", status, e)
	}
	d := claimNext(run, sess)
	if d.Parameters["term"] != "SYNTHETIC ONLY[Title] AND 2020:2026[dp]" || d.Parameters["retmax"] != "1000" || d.Parameters["sort"] != "relevance" || !d.Fresh {
		t.Fatal("query/filter/sort/capture changed")
	}
	var wg sync.WaitGroup
	for n := 0; n < 2; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			replay, e := s.claimUserRoute(ctx, library, run, userRouteClaim{d.AttemptID, d.Revision - 1}, sess)
			if e != nil || replay.Fresh || replay.AttemptID != d.AttemptID {
				t.Error("duplicate admission", e)
			}
		}()
	}
	wg.Wait()
	if _, e = s.claimUserRoute(ctx, library, run, userRouteClaim{d.AttemptID, d.Revision - 1}, other); e == nil {
		t.Fatal("other session received attempt")
	}
	if _, e = s.submitUserRoute(ctx, library, run, userRouteUpload{AttemptID: d.AttemptID, Body: membership}, other); e == nil {
		t.Fatal("foreign session upload")
	}
	initial := upload(run, d, membership)
	if replay := upload(run, d, membership); replay != initial {
		t.Fatal("membership replay changed revision")
	}
	if _, e = s.submitUserRoute(ctx, library, run, userRouteUpload{AttemptID: d.AttemptID, Body: append(append([]byte{}, membership...), byte(' '))}, sess); e == nil {
		t.Fatal("altered receipt accepted")
	}
	f := claimNext(run, sess)
	if f.Stage != "efetch" || f.Parameters["id"] != "990000001" {
		t.Fatal("metadata slice mismatch")
	}
	upload(run, f, metadata)
	selection, e := s.readRunSelection(ctx, library, run)
	if e != nil || selection.SavedCount != 1 || selection.SelectedCount != 1 {
		t.Fatal("saved selection", e)
	}
	firstID := selection.SelectedIDs[0]
	no := false
	if _, e = s.changeRunSelection(ctx, library, run, runSelectionAction{RequestID: newUUID(), Revision: selection.Revision, Action: "set", IDs: []string{firstID}, Selected: &no}); e != nil {
		t.Fatal(e)
	}
	status, _ = s.continuationStatus(ctx, library, run)
	if _, e = s.controlContinuation(ctx, library, run, continuationAction{RequestID: newUUID(), Revision: status.Revision, Action: "continue"}); e != nil {
		t.Fatal(e)
	}
	second := claimNext(run, sess)
	secondBody := bytes.ReplaceAll(metadata, []byte("990000001"), []byte("990000002"))
	// 第二篇使用不同 DOI，避免把合法版本與識別碼衝突混為一談。
	secondBody = bytes.ReplaceAll(secondBody, []byte("10.0000/SYNTHETIC"), []byte("10.0000/SYNTHETIC-TWO"))
	upload(run, second, secondBody)
	selection, e = s.readRunSelection(ctx, library, run)
	if e != nil || selection.SavedCount != 2 || selection.SelectedCount != 1 || selection.SelectedIDs[0] == firstID {
		t.Fatal("continuation lost explicit selection", selection, e)
	}
	rows, _, e := s.runMetadataRows(ctx, library, run, selection.Revision)
	if e != nil || len(rows) != 1 {
		t.Fatal("selected rows", e)
	}
	csv, e := encodeRecordCSV(ctx, rows)
	if e != nil || !bytes.Contains(csv, []byte(userRouteVerification)) {
		t.Fatal("CSV trust missing", e)
	}
	xlsx, e := encodeWorkbook(ctx, rows, run, "")
	if e != nil {
		t.Fatal(e)
	}
	book, e := excelize.OpenReader(bytes.NewReader(xlsx))
	if e != nil {
		t.Fatal(e)
	}
	sheetRows, e := book.GetRows("Literature")
	book.Close()
	if e != nil || !strings.Contains(strings.Join(sheetRows[len(sheetRows)-1], "|"), userRouteVerification) {
		t.Fatal("XLSX trust missing", e)
	}
	doc, _, e := s.selectedStructuredResearch(ctx, library, run, selection.Revision)
	if e != nil {
		t.Fatal(e)
	}
	for _, format := range []string{"json", "jsonl"} {
		data, e := encodeStructured(ctx, doc, format)
		if e != nil || !bytes.Contains(data, []byte(userRouteVerification)) || !bytes.Contains(data, []byte("SYNTHETIC ONLY[Title]")) {
			t.Fatal("structured provenance/query", format, e)
		}
	}
	sum := sha256.Sum256(metadata)
	var body []byte
	var hash string
	if e = db.QueryRow(ctx, "SELECT body,body_sha256 FROM native_user_route_attempts WHERE library_id=$1 AND request_id=$2", library, f.AttemptID).Scan(&body, &hash); e != nil || !bytes.Equal(body, metadata) || hash != hex.EncodeToString(sum[:]) {
		t.Fatal("raw response evidence lost", e)
	}
	if e = migrate(true, true); e == nil {
		t.Fatal("used rollback removed research")
	}

	t.Run("per-session-failure-domain-and-recovery", func(t *testing.T) {
		failed := queue("personal_key")
		a := claimNext(failed, sess)
		r, e := s.submitUserRoute(ctx, library, failed, userRouteUpload{AttemptID: a.AttemptID, Failure: "rate_limited"}, sess)
		if e != nil || r.State != "expired" {
			t.Fatal("initial refusal not explicit", e)
		}
		next := queue("unkeyed")
		if _, e = s.claimUserRoute(ctx, library, next, userRouteClaim{newUUID(), 1}, sess); e == nil {
			t.Fatal("cooldown bypass")
		}
		b, e := s.claimUserRoute(ctx, library, next, userRouteClaim{newUUID(), 1}, other)
		if e != nil || b.CredentialMode != "unkeyed" {
			t.Fatal("one session blocked another", e)
		}
		if _, e = s.recoverUserRoute(ctx, library, next, b.AttemptID); e == nil {
			t.Fatal("active request prematurely recovered")
		}
		must("UPDATE ld_jobs SET lease_until=now()-interval '1 second' WHERE library_id=$1 AND run_id=$2", library, next)
		r, e = s.recoverUserRoute(ctx, library, next, b.AttemptID)
		if e != nil || r.State != "expired" {
			t.Fatal("unknown initial repeated", e)
		}
		s.workOne(ctx)
		if calls.Load() != 0 {
			t.Fatal("recovery called VPS provider")
		}
		cancelled := queue("unkeyed")
		c := claimNext(cancelled, sess)
		if _, e = s.controlContinuation(ctx, library, cancelled, continuationAction{RequestID: newUUID(), Revision: c.Revision, Action: "cancel"}); e != nil {
			t.Fatal(e)
		}
		if _, e = s.submitUserRoute(ctx, library, cancelled, userRouteUpload{AttemptID: c.AttemptID, Body: membership}, sess); e == nil {
			t.Fatal("late cancellation upload")
		}
	})

	t.Run("higher-trust-record-preserved", func(t *testing.T) {
		var original string
		if e = db.QueryRow(ctx, "SELECT metadata FROM ld_records WHERE library_id=$1 AND search_id=$2", library, firstID).Scan(&original); e != nil {
			t.Fatal(e)
		}
		var a map[string]any
		json.Unmarshal([]byte(original), &a)
		for k := range a {
			if strings.HasPrefix(k, "Metadata") {
				delete(a, k)
			}
		}
		a["Title"] = "SYNTHETIC higher trust title"
		trusted, _ := json.Marshal(a)
		must("UPDATE ld_records SET metadata=$3 WHERE library_id=$1 AND search_id=$2", library, firstID, string(trusted))
		duplicate := queue("unkeyed")
		start := claimNext(duplicate, sess)
		upload(duplicate, start, bytes.ReplaceAll(membership, []byte("<Count>2</Count><IdList><Id>990000001</Id><Id>990000002</Id>"), []byte("<Count>1</Count><IdList><Id>990000001</Id>")))
		finish := claimNext(duplicate, sess)
		upload(duplicate, finish, metadata)
		var saved string
		db.QueryRow(ctx, "SELECT metadata FROM ld_records WHERE library_id=$1 AND search_id=$2", library, firstID).Scan(&saved)
		if saved != string(trusted) {
			t.Fatal("client overwrote canonical record")
		}
		batch, e := s.queueBatch(ctx, library, newUUID(), []string{firstID, selection.SelectedIDs[0]}, "pdf")
		if e != nil {
			t.Fatal("mixed trust batch admission", e)
		}
		if e = s.controlBatch(ctx, library, batch, "cancel"); e != nil {
			t.Fatal(e)
		}
		batchRows, e := s.exportRows(ctx, library, "", batch)
		if e != nil || len(batchRows) != 2 {
			t.Fatal("mixed batch export", e)
		}
		for _, row := range batchRows {
			values, err := routeExportValues(row)
			if err != nil || len(values) != len(routeProvenanceColumns) {
				t.Fatal("batch source distinction missing", err)
			}
			var associations []routeQueryAssociation
			if json.Unmarshal([]byte(values[7]), &associations) != nil {
				t.Fatal("batch query provenance not structured")
			}
			if row["search_id"] == firstID {
				if values[1] != "prior_saved_record" || len(associations) != 2 {
					t.Fatal("canonical metadata and browser membership conflated", values)
				}
				seen := map[string]bool{}
				for _, q := range associations {
					seen[q.RunID] = true
					if q.Provenance == nil || q.Provenance.Verification != userRouteVerification || len(q.Provenance.ResponseSHA256) != 64 || q.Provenance.SubmittedQuery != "SYNTHETIC ONLY[Title] AND 2020:2026[dp]" {
						t.Fatal("batch per-run membership evidence lost", q)
					}
				}
				if !seen[run] || !seen[duplicate] {
					t.Fatal("batch query identities lost")
				}
			} else if values[1] != userRouteVerification || len(associations) != 1 || associations[0].RunID != run {
				t.Fatal("new metadata positive control lost", values)
			}
		}
		batchCSV, e := s.exportCSV(ctx, library, "", batch)
		if e != nil || !bytes.Contains(batchCSV, []byte("prior_saved_record")) || !bytes.Contains(batchCSV, []byte(duplicate)) {
			t.Fatal("batch CSV query provenance lost", e)
		}
		batchXLSX, e := encodeWorkbook(ctx, batchRows, "", batch)
		if e != nil {
			t.Fatal(e)
		}
		batchBook, e := excelize.OpenReader(bytes.NewReader(batchXLSX))
		if e != nil {
			t.Fatal(e)
		}
		batchSheet, e := batchBook.GetRows("Literature")
		batchBook.Close()
		encodedSheet, _ := json.Marshal(batchSheet)
		if e != nil || !bytes.Contains(encodedSheet, []byte("prior_saved_record")) || !bytes.Contains(encodedSheet, []byte(duplicate)) {
			t.Fatal("batch XLSX query provenance lost", e)
		}
		conflictRun := queue("unkeyed")
		start = claimNext(conflictRun, sess)
		upload(conflictRun, start, []byte(`<eSearchResult><Count>1</Count><IdList><Id>990000001</Id></IdList><QueryTranslation>SYNTHETIC conflict</QueryTranslation></eSearchResult>`))
		finish = claimNext(conflictRun, sess)
		conflictBody := bytes.ReplaceAll(metadata, []byte("10.0000/SYNTHETIC"), []byte("10.0000/CONFLICT"))
		if receipt := upload(conflictRun, finish, conflictBody); receipt.State != "failed" {
			t.Fatal("identifier conflict not explicit")
		}
		var retained []byte
		var count int
		if e = db.QueryRow(ctx, "SELECT body FROM native_user_route_attempts WHERE library_id=$1 AND request_id=$2", library, finish.AttemptID).Scan(&retained); e != nil || !bytes.Equal(retained, conflictBody) {
			t.Fatal("conflict evidence lost", e)
		}
		db.QueryRow(ctx, "SELECT count(*) FROM ld_results WHERE library_id=$1 AND run_id=$2", library, conflictRun).Scan(&count)
		if count != 0 {
			t.Fatal("conflicting page partly saved")
		}
	})

	t.Run("concurrent-upload-expiry", func(t *testing.T) {
		// 以 PostgreSQL 實際鎖等待證明重疊，不能把 goroutine 啟動當成已發生競爭。
		// 三個有限排程共用合成資料；不使用來源網路或負載測試。
		pool := func(label string) (*pgxpool.Pool, uint32) {
			t.Helper()
			c := pc.Copy()
			c.MaxConns = 1
			c.ConnConfig.RuntimeParams["application_name"] = "route059-" + label
			p, err := pgxpool.NewWithConfig(ctx, c)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(p.Close)
			var pid uint32
			if err = p.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
				t.Fatal(err)
			}
			return p, pid
		}
		uploadDB, uploadPID := pool("upload")
		retireDB, retirePID := pool("retirement")
		uploader := &server{native: true, continuation: true, userRoute: true, runSelection: true, savedSnapshots: true, bundles: true, db: uploadDB, cfg: s.cfg, provider: s.provider}
		blocked := func(waiting, holding uint32) {
			t.Helper()
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				var observed bool
				if err := db.QueryRow(ctx, "SELECT $2::int=ANY(pg_blocking_pids($1::int))", waiting, holding).Scan(&observed); err != nil {
					t.Fatal(err)
				}
				if observed {
					t.Logf("Observed PostgreSQL overlap: waiting_pid=%d blocker_pid=%d", waiting, holding)
					return
				}
				time.Sleep(5 * time.Millisecond)
			}
			t.Fatalf("Actual lock overlap not observed: waiting=%d holding=%d", waiting, holding)
		}
		retire := func() error {
			tx, err := retireDB.Begin(ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(context.Background())
			if err = capacityLock(ctx, tx); err == nil {
				err = retireExpiredUserRouteWork(ctx, tx)
			}
			if err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
		for _, order := range []string{"expired-retirement-first", "expired-upload-first", "valid-lease-upload"} {
			t.Run(order, func(t *testing.T) {
				id := queue("unkeyed")
				initialAttempt := claimNext(id, sess)
				initialReceipt := upload(id, initialAttempt, membership)
				attempt := claimNext(id, sess)
				var beforeSnapshot, beforeMetadata, beforeIdentifiers string
				if err := db.QueryRow(ctx, "SELECT snapshot FROM ld_runs WHERE library_id=$1 AND run_id=$2", library, id).Scan(&beforeSnapshot); err != nil {
					t.Fatal(err)
				}
				if err := db.QueryRow(ctx, "SELECT md5(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text)) FROM ld_records t").Scan(&beforeMetadata); err != nil {
					t.Fatal(err)
				}
				if err := db.QueryRow(ctx, "SELECT md5(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text)) FROM ld_identifiers t").Scan(&beforeIdentifiers); err != nil {
					t.Fatal(err)
				}
				expired := order != "valid-lease-upload"
				if expired {
					must("UPDATE ld_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE library_id=$1 AND run_id=$2", library, id)
					must("UPDATE native_user_route_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE library_id=$1 AND request_id=$2", library, attempt.AttemptID)
				}
				type result struct {
					receipt continuationReceipt
					err     error
				}
				uploadResult := make(chan result, 1)
				startUpload := func() {
					go func() {
						r, err := uploader.submitUserRoute(ctx, library, id, userRouteUpload{AttemptID: attempt.AttemptID, Body: metadata}, sess)
						uploadResult <- result{r, err}
					}()
				}
				if order == "expired-retirement-first" {
					tx, err := retireDB.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer tx.Rollback(context.Background())
					if err = capacityLock(ctx, tx); err != nil {
						t.Fatal(err)
					}
					if err = retireExpiredUserRouteWork(ctx, tx); err != nil {
						t.Fatal(err)
					}
					startUpload()
					blocked(uploadPID, retirePID)
					if err = tx.Commit(ctx); err != nil {
						t.Fatal(err)
					}
				} else {
					// 暫持 attempt 鎖，讓實際 upload 先取得 job 鎖，再啟動到期回收。
					gate, err := db.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer gate.Rollback(context.Background())
					var gatePID uint32
					if err = gate.QueryRow(ctx, "SELECT pg_backend_pid() FROM native_user_route_attempts WHERE library_id=$1 AND request_id=$2 FOR UPDATE", library, attempt.AttemptID).Scan(&gatePID); err != nil {
						t.Fatal(err)
					}
					startUpload()
					blocked(uploadPID, gatePID)
					retired := make(chan error, 1)
					go func() { retired <- retire() }()
					if expired {
						blocked(retirePID, uploadPID)
					} else if err = <-retired; err != nil {
						t.Fatal(err)
					}
					if err = gate.Commit(ctx); err != nil {
						t.Fatal(err)
					}
					if expired {
						if err = <-retired; err != nil {
							t.Fatal(err)
						}
					}
				}
				actual := <-uploadResult
				if expired {
					var refused *planError
					if !errors.As(actual.err, &refused) || refused.Status != 409 {
						t.Fatal("expired overlapping upload not explicitly refused", actual.err)
					}
				} else if actual.err != nil || actual.receipt.State != "ready" {
					t.Fatal("valid lease positive control failed", actual.receipt, actual.err)
				}
				var snapshot, retainedMetadata, retainedIdentifiers, attemptState, rawReceipt, rawIDs string
				var saved, bodyBytes int
				if err := db.QueryRow(ctx, "SELECT r.snapshot,w.ids,r.fetched,a.state,COALESCE(octet_length(a.body),0),a.receipt FROM ld_runs r JOIN native_search_windows w USING(library_id,run_id) JOIN native_user_route_attempts a USING(library_id,run_id) WHERE r.library_id=$1 AND r.run_id=$2 AND a.request_id=$3", library, id, attempt.AttemptID).Scan(&snapshot, &rawIDs, &saved, &attemptState, &bodyBytes, &rawReceipt); err != nil {
					t.Fatal(err)
				}
				if err := db.QueryRow(ctx, "SELECT md5(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text)) FROM ld_records t").Scan(&retainedMetadata); err != nil {
					t.Fatal(err)
				}
				if err := db.QueryRow(ctx, "SELECT md5(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text)) FROM ld_identifiers t").Scan(&retainedIdentifiers); err != nil {
					t.Fatal(err)
				}
				if snapshot != beforeSnapshot || rawIDs != `["990000001","990000002"]` || retainedMetadata != beforeMetadata || retainedIdentifiers != beforeIdentifiers || calls.Load() != 0 {
					t.Fatal("concurrent reconciliation changed frozen/canonical data or used provider")
				}
				if expired && (saved != 0 || attemptState != "interrupted" || bodyBytes != 0 || rawReceipt != "") || !expired && (saved != 1 || attemptState != "completed" || bodyBytes != len(metadata) || rawReceipt == "") {
					t.Fatal("overlap result persistence mismatch", saved, attemptState, bodyBytes)
				}
				if replay := upload(id, initialAttempt, membership); replay != initialReceipt {
					t.Fatal("completed initial receipt changed during overlap")
				}
				if !expired {
					if replay := upload(id, attempt, metadata); replay != actual.receipt {
						t.Fatal("accepted-before-expiry receipt changed")
					}
				}
				t.Logf("Committed overlap outcome: order=%s run=%s attempt=%s expired=%t saved=%d state=%s provider_calls=%d", order, id, attempt.AttemptID, expired, saved, attemptState, calls.Load())
			})
		}
	})

	t.Run("abandoned-admission-expiry-other-user-and-restart", func(t *testing.T) {
		var retainedBefore, retainedAfter string
		if e = db.QueryRow(ctx, "SELECT md5(string_agg(metadata,E'\\n' ORDER BY search_id)) FROM ld_records").Scan(&retainedBefore); e != nil {
			t.Fatal(e)
		}
		closed := []string{}
		var late userRouteDescriptor
		for n := 0; n < 13; n++ {
			id := queue("unkeyed")
			late = claimNext(id, sess)
			closed = append(closed, id)
		}
		frozenRun := queue("unkeyed")
		initialAttempt := claimNext(frozenRun, sess)
		upload(frozenRun, initialAttempt, membership)
		frozenAttempt := claimNext(frozenRun, sess)
		closed = append(closed, frozenRun)
		liveRun := queue("unkeyed")
		live := claimNext(liveRun, sess)
		for n := 0; n < 5; n++ {
			closed = append(closed, queue("unkeyed"))
		}
		if _, e = s.queueUserSearch(ctx, foreign, "SYNTHETIC other user", 1, newUUID(), "unkeyed"); e == nil {
			t.Fatal("valid live capacity control did not refuse")
		}
		// Simulate closed tabs by expiring only their durable database deadlines.
		must("UPDATE ld_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=ANY($1)", closed)
		must("UPDATE native_user_route_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=ANY($1) AND state='running'", closed)
		foreignSession := &session{Account: foreignAccount, CSRF: newUUID(), Hash: digest(randomToken())}
		must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", foreignSession.Hash, foreignSession.Account, foreignSession.CSRF)
		foreignRun, e := s.queueUserSearch(ctx, foreign, "SYNTHETIC other user", 1, newUUID(), "unkeyed")
		if e != nil {
			t.Fatal("abandoned work permanently blocked another library", e)
		}
		foreignAttempt, e := s.claimUserRoute(ctx, foreign, foreignRun, userRouteClaim{newUUID(), 1}, foreignSession)
		if e != nil || !foreignAttempt.Fresh {
			t.Fatal("expired reservations blocked unrelated source admission", e)
		}
		for _, id := range closed {
			v, err := s.continuationStatus(ctx, library, id)
			if err != nil || id != frozenRun && v.State != "expired" || id == frozenRun && (v.State != "failed" || !v.CanRetry || v.WindowCount != 2) {
				t.Fatal("initial and frozen interruption semantics changed", id, v, err)
			}
		}
		if _, e = s.submitUserRoute(ctx, library, late.RunID, userRouteUpload{AttemptID: late.AttemptID, Body: membership}, sess); e == nil {
			t.Fatal("late response revived an expired reservation")
		}
		if _, e = s.submitUserRoute(ctx, library, frozenRun, userRouteUpload{AttemptID: frozenAttempt.AttemptID, Body: metadata}, sess); e == nil {
			t.Fatal("late metadata revived an expired reservation")
		}
		// Reconstruct the application object, then exercise the normal worker's
		// retirement with admission disabled: neither path may call a provider.
		must("UPDATE ld_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE library_id=$1 AND run_id=$2", foreign, foreignRun)
		restarted := &server{native: true, continuation: true, userRoute: true, db: db, cfg: s.cfg, provider: s.provider}
		restarted.cfg.UserRouteEnabled = false
		restarted.workOne(ctx)
		v, e := s.continuationStatus(ctx, foreign, foreignRun)
		if e != nil || v.State != "expired" || calls.Load() != 0 {
			t.Fatal("restart did not retire source-free", v, e)
		}
		v, e = s.continuationStatus(ctx, library, liveRun)
		if e != nil || v.State != "running" || v.AttemptID != live.AttemptID {
			t.Fatal("active lease was disturbed", v, e)
		}
		v, _ = s.continuationStatus(ctx, library, frozenRun)
		if _, e = s.controlContinuation(ctx, library, frozenRun, continuationAction{RequestID: newUUID(), Revision: v.Revision, Action: "retry"}); e != nil {
			t.Fatal("explicit frozen retry unavailable", e)
		}
		retry := claimNext(frozenRun, sess)
		if retry.Stage != "efetch" || retry.Parameters["id"] != frozenAttempt.Parameters["id"] {
			t.Fatal("retry changed the frozen metadata page")
		}
		if e = db.QueryRow(ctx, "SELECT md5(string_agg(metadata,E'\\n' ORDER BY search_id)) FROM ld_records").Scan(&retainedAfter); e != nil || retainedAfter != retainedBefore {
			t.Fatal("retirement changed retained metadata", e)
		}
		if replay := upload(run, d, membership); replay != initial {
			t.Fatal("retirement lost completed receipts")
		}
		for _, id := range []string{liveRun, frozenRun} {
			v, _ := s.continuationStatus(ctx, library, id)
			if _, e = s.controlContinuation(ctx, library, id, continuationAction{RequestID: newUUID(), Revision: v.Revision, Action: "cancel"}); e != nil {
				t.Fatal(e)
			}
		}
	})

	t.Run("HTTP-ownership-CSRF-credential-rejection-disabled-receipts", func(t *testing.T) {
		request := func(lib, body, csrfHeader string) *httptest.ResponseRecorder {
			r := httptest.NewRequest("POST", s.cfg.Origin+"/api/libraries/"+lib+"/runs/"+run+"/user-route/claim", strings.NewReader(body))
			r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: token})
			r.Header.Set("Origin", s.cfg.Origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF", csrfHeader)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			return w
		}
		if request(foreign, `{}`, csrf).Code != 404 || request(library, `{}`, "").Code != 403 {
			t.Fatal("ownership/CSRF boundary")
		}
		if request(library, `{"requestID":"`+newUUID()+`","revision":1,"api_key":"SYNTHETIC_SECRET"}`, csrf).Code != 400 {
			t.Fatal("server accepted credential field")
		}
		s.cfg.UserRouteEnabled = false
		if _, e = s.queueUserSearch(ctx, library, "SYNTHETIC", 1, newUUID(), "unkeyed"); e == nil {
			t.Fatal("disabled admission")
		}
		if replay := upload(run, d, membership); replay != initial {
			t.Fatal("disabled feature lost receipt")
		}
		if _, _, e = s.selectedStructuredResearch(ctx, library, run, selection.Revision); e != nil {
			t.Fatal("disabled feature lost exports", e)
		}
		s.cfg.UserRouteEnabled = true
		must("DELETE FROM ld_sessions WHERE token_hash=$1", sess.Hash)
		if request(library, `{}`, csrf).Code != 401 {
			t.Fatal("revoked session accepted")
		}
	})
	if calls.Load() != 0 {
		t.Fatal("browser workflow used server provider")
	}

	t.Run("uncached-PDF-requires-independent-repository-proof", func(t *testing.T) {
		proofArticle := syntheticArticle()
		pdf := syntheticPDF("USER ROUTE SOURCE PROOF")
		proof := syntheticPDFProof(t, pdf, proofArticle)
		for _, name := range []string{"permitted", "forged-pmid", "forged-doi", "forged-rights", "altered-jats"} {
			t.Run(name, func(t *testing.T) {
				candidate := syntheticArticle()
				candidate["MetadataVerification"] = userRouteVerification
				candidate["MetadataExecution"] = userRouteExecution
				candidate["License"] = "CC BY"
				candidate["FullTextUrl"] = "https://attacker.invalid/forged.pdf"
				p := proof
				switch name {
				case "forged-pmid":
					candidate["Pmid"] = "990009999"
				case "forged-doi":
					candidate["Doi"] = "10.0000/forged"
				case "forged-rights":
					p.Metadata = bytes.ReplaceAll(p.Metadata, []byte("CC BY"), []byte("UNKNOWN"))
				case "altered-jats":
					p.JATS = bytes.ReplaceAll(p.JATS, []byte("SYNTHETIC ONLY"), []byte("ALTERED"))
				}
				var pdfCalls int
				s.provider = &http.Client{Transport: nativeTransport(func(r *http.Request) (*http.Response, error) {
					if r.URL.Host != cloudHost {
						t.Fatal("untrusted client URL or PubMed used", r.URL.Host)
					}
					var data []byte
					contentType := "binary/octet-stream"
					switch {
					case r.URL.Path == "/":
						data = p.Listing
						contentType = "application/xml"
					case strings.HasSuffix(r.URL.Path, ".json"):
						data = p.Metadata
					case strings.HasSuffix(r.URL.Path, ".xml"):
						data = p.JATS
					case strings.HasSuffix(r.URL.Path, ".pdf"):
						pdfCalls++
						data = pdf
					default:
						t.Fatal("unexpected source path")
					}
					must("UPDATE ld_source_budget SET next_at=now() WHERE name='ncbi'")
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {contentType}}, ContentLength: int64(len(data)), Body: io.NopCloser(bytes.NewReader(data))}, nil
				})}
				b, info, e := s.acquirePDF(ctx, candidate)
				if name == "permitted" {
					if e != nil || !bytes.Equal(b, pdf) || pdfCalls != 1 || info.Rights != "https://creativecommons.org/licenses/by/4.0/" {
						t.Fatal("legitimate original refused", e, pdfCalls)
					}
					// 真正經過新搜尋儲存、使用者選取、排入未快取批次與正式 worker。
					must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", sess.Hash, sess.Account, sess.CSRF)
					originalLibrary := library
					library = newUUID()
					must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC browser PDF journey',true)", library, account)
					newRun := queue("unkeyed")
					start := claimNext(newRun, sess)
					upload(newRun, start, []byte(`<eSearchResult><Count>1</Count><IdList><Id>990000001</Id></IdList><QueryTranslation>SYNTHETIC original journey</QueryTranslation></eSearchResult>`))
					finish := claimNext(newRun, sess)
					upload(newRun, finish, metadata)
					selected, e := s.readRunSelection(ctx, library, newRun)
					if e != nil || selected.SelectedCount != 1 {
						t.Fatal("new client record selection", e)
					}
					batch, e := s.queueBatch(ctx, library, newUUID(), selected.SelectedIDs, "pdf")
					if e != nil {
						t.Fatal("uncached client batch admission", e)
					}
					s.batchOne(ctx)
					var state, hash, stored string
					if e = db.QueryRow(ctx, "SELECT state,COALESCE(original_hash,'') FROM native_items WHERE library_id=$1 AND batch_id=$2", library, batch).Scan(&state, &hash); e != nil || state != "acquired" || len(hash) != 64 || pdfCalls != 2 {
						t.Fatal("client batch worker did not verify original", state, e, pdfCalls)
					}
					b, info, e = s.original(ctx, library, selected.SelectedIDs[0], hash)
					if e != nil || !bytes.Equal(b, pdf) || info.Rights != "https://creativecommons.org/licenses/by/4.0/" {
						t.Fatal("original delivery proof", e)
					}
					db.QueryRow(ctx, "SELECT metadata FROM ld_records WHERE library_id=$1 AND search_id=$2", library, selected.SelectedIDs[0]).Scan(&stored)
					if !strings.Contains(stored, userRouteVerification) {
						t.Fatal("repository proof incorrectly promoted metadata")
					}
					library = originalLibrary
				} else if e == nil || pdfCalls != 0 {
					t.Fatal("client assertions authorized PDF bytes", name, e, pdfCalls)
				}
			})
		}
	})
}
