package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xuri/excelize/v2"
)

func TestRunSelectionActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Dedicated isolated PostgreSQL authority/configuration absent")
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
		t.Fatal("dedicated native test database required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	admin, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		t.Fatal("isolated database connection failed")
	}
	var actualDatabase string
	if err = admin.QueryRow(ctx, "SELECT current_database()").Scan(&actualDatabase); err != nil || actualDatabase != pc.ConnConfig.Database {
		t.Fatal("isolated database identity mismatch")
	}
	schema := "native_selection_test_" + strings.ReplaceAll(newUUID(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	admin.Close()
	// A fresh schema prevents this consequential migration test from touching
	// other test suites or retained evidence in the same dedicated database.
	// Keep the schema and its labeled fixtures for post-failure inspection.
	pc.ConnConfig.RuntimeParams["search_path"] = schema
	pc.MaxConns = 8
	db, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	t.Log("Retained isolated SYNTHETIC ONLY schema", schema)
	must := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	must(nativeSchema)
	must(multirunSchema)
	must(continuationSchema)
	must(bundleSchema)
	must(savedSnapshotSchema)
	migrate := func(rollback, commit bool) error {
		tx, err := db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(context.Background())
		if err = migrateRunSelection(ctx, tx, rollback); err != nil {
			return err
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
	if err = db.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); err != nil || version != 8 {
		t.Fatal("uncommitted migration escaped", err, version)
	}
	for _, step := range []bool{false, false, true, false} {
		if err = migrate(step, true); err != nil {
			t.Fatal("empty migration/rollback", step, err)
		}
	}
	account, foreignAccount, library, foreignLibrary := newUUID(), newUUID(), newUUID(), newUUID()
	must("INSERT INTO ld_accounts VALUES($1,$2,'unused',true),($3,$4,'unused',true)", account, "SYNTHETIC-"+account, foreignAccount, "SYNTHETIC-"+foreignAccount)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC ONLY',true),($3,$4,'SYNTHETIC FOREIGN',true)", library, account, foreignLibrary, foreignAccount)
	must(`INSERT INTO ld_records(library_id,search_id,metadata,title)
 SELECT $1,'LD-'||lpad(n::text,32,'0'),jsonb_build_object(
 'SearchId','LD-'||lpad(n::text,32,'0'),'Title','SYNTHETIC ONLY α 中文 record '||n::text,
 'Authors','Synthetic author','Pmid',(990000000+n)::text,'Pmcid','PMC'||(990000000+n)::text,
	 'Doi','10.0000/synthetic.'||n::text,'Year','2026','RawXml','SYNTHETIC PRIVATE RAW')::text,
	 'SYNTHETIC ONLY α 中文 record '||n::text
 FROM generate_series(1,1001) n`, library)
	newRun := func(count int) string {
		t.Helper()
		run := newID("RUN-")
		must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state) VALUES($1,$2,'SYNTHETIC ONLY query',10000,$3,100,'partial')", library, run, count)
		must("INSERT INTO ld_results SELECT $1,$2,search_id,row_number() OVER(ORDER BY search_id)::integer FROM ld_records WHERE library_id=$1 ORDER BY search_id LIMIT $3", library, run, count)
		return run
	}
	service := &server{native: true, runSelection: true, continuation: true, bundles: true, savedSnapshots: true, db: db,
		cfg:   config{SelectionWriteEnabled: true, LocalTest: true, Origin: "http://127.0.0.1:18089", Expires: time.Now().Add(time.Hour), PlanEnabled: true, PDFEnabled: true, AcquisitionEnabled: true},
		slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1),
		provider: &http.Client{Transport: nativeTransport(func(*http.Request) (*http.Response, error) {
			t.Error("SYNTHETIC selection unexpectedly called a provider")
			return nil, errors.New("all provider traffic forbidden in selection test")
		})}}
	read := func(run string) runSelectionView {
		t.Helper()
		v, err := service.readRunSelection(ctx, library, run)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	change := func(run string, action runSelectionAction) runSelectionReceipt {
		t.Helper()
		v, err := service.changeRunSelection(ctx, library, run, action)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, count := range []int{0, 1, 99, 100, 101, 999, 1000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			run := newRun(count)
			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			began := time.Now()
			v := read(run)
			runtime.ReadMemStats(&after)
			data, _ := json.Marshal(v)
			if v.SavedCount != count || v.SelectedCount != count || len(v.SelectedIDs) != count || v.RecordsComplete != (count <= 100) || count > 100 && len(v.SelectedRecords) != 0 || count <= 100 && len(v.SelectedRecords) != count || strings.Contains(string(data), "SYNTHETIC PRIVATE RAW") {
				t.Fatal("default selection count/detail/privacy bound", count)
			}
			if len(data) > 512*1024 {
				t.Fatal("compact fixture selection response grew beyond its bounded workload")
			}
			t.Logf("SYNTHETIC count=%d response=%d allocated=%d elapsed=%s", count, len(data), after.TotalAlloc-before.TotalAlloc, time.Since(began))
			a := runSelectionAction{RequestID: newUUID(), Revision: v.Revision, Action: "none"}
			first := change(run, a)
			second := change(run, a)
			if first != second || read(run).SelectedCount != 0 {
				t.Fatal("lost-response retry duplicated a selection action")
			}
			// A different service instance and fresh transaction recover the choice.
			restarted := &server{native: true, runSelection: true, db: db, cfg: service.cfg}
			got, err := restarted.readRunSelection(ctx, library, run)
			if err != nil || got.SelectedCount != 0 || got.Revision != first.Revision {
				t.Fatal("restart lost explicit deselection", err)
			}
			if _, err = service.changeRunSelection(ctx, library, run, runSelectionAction{RequestID: newUUID(), Revision: v.Revision, Action: "all"}); err == nil {
				t.Fatal("stale revision erased a newer choice")
			}
		})
	}
	if _, err = service.readRunSelection(ctx, library, newRun(1001)); err == nil {
		t.Fatal("oversized saved set was silently truncated")
	}
	run := newRun(3)
	initial := read(run)
	no, yes := false, true
	action := runSelectionAction{RequestID: newUUID(), Revision: initial.Revision, Action: "set", IDs: initial.SelectedIDs[:1], Selected: &no}
	change(run, action)
	beforeGrowth := read(run)
	must("INSERT INTO ld_results VALUES($1,$2,$3,4);", library, run, "LD-"+fmt.Sprintf("%032d", 4))
	must("UPDATE ld_runs SET fetched=4 WHERE library_id=$1 AND run_id=$2", library, run)
	afterGrowth := read(run)
	if afterGrowth.SelectedCount != 3 || slices.Contains(afterGrowth.SelectedIDs, initial.SelectedIDs[0]) || afterGrowth.Revision <= beforeGrowth.Revision {
		t.Fatal("continuation restored an explicit deselection or hid membership growth")
	}
	if _, _, err = service.runMetadataRows(ctx, library, run, beforeGrowth.Revision); err == nil {
		t.Fatal("stale export silently included newly appended members")
	}
	change(run, runSelectionAction{RequestID: newUUID(), Revision: afterGrowth.Revision, Action: "none"})
	must("INSERT INTO ld_results VALUES($1,$2,$3,5)", library, run, "LD-"+fmt.Sprintf("%032d", 5))
	must("UPDATE ld_runs SET fetched=5 WHERE library_id=$1 AND run_id=$2", library, run)
	if read(run).SelectedCount != 0 {
		t.Fatal("none policy failed on continuation")
	}
	current := read(run)
	change(run, runSelectionAction{RequestID: newUUID(), Revision: current.Revision, Action: "set", IDs: initial.SelectedIDs[:2], Selected: &yes})
	current = read(run)
	change(run, runSelectionAction{RequestID: newUUID(), Revision: current.Revision, Action: "set", IDs: initial.SelectedIDs[2:3], Selected: &yes})
	current = read(run)
	if current.SelectedCount != 3 {
		t.Fatal("page selection replaced previous-page choices")
	}
	badMember := runSelectionAction{RequestID: newUUID(), Revision: current.Revision, Action: "set", IDs: []string{initial.SelectedIDs[0], "LD-" + fmt.Sprintf("%032d", 999)}, Selected: &no}
	if _, err = service.changeRunSelection(ctx, library, run, badMember); err == nil || read(run).Revision != current.Revision {
		t.Fatal("mixed foreign-run member was not atomic")
	}
	if _, err = service.changeRunSelection(ctx, foreignLibrary, run, runSelectionAction{RequestID: newUUID(), Revision: current.Revision, Action: "none"}); err == nil {
		t.Fatal("foreign library mutation admitted")
	}
	if _, err = service.changeRunSelection(ctx, library, newRun(1), action); err == nil {
		t.Fatal("request UUID replay accepted a different run")
	}
	// Inject a failure after choice updates but before their durable action receipt.
	fault := runSelectionAction{RequestID: newUUID(), Revision: current.Revision, Action: "none"}
	must(`CREATE FUNCTION synthetic_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'SYNTHETIC ONLY receipt failure'; END $$;
 CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON native_run_selection_actions FOR EACH ROW EXECUTE FUNCTION synthetic_receipt_failure()`)
	if _, err = service.changeRunSelection(ctx, library, run, fault); err == nil {
		t.Fatal("fault did not interrupt the transaction")
	}
	if got := read(run); got.Revision != current.Revision || !slices.Equal(got.SelectedIDs, current.SelectedIDs) {
		t.Fatal("failed receipt committed partial selection")
	}
	must("DROP TRIGGER synthetic_receipt_failure ON native_run_selection_actions; DROP FUNCTION synthetic_receipt_failure()")
	change(run, fault)
	if read(run).SelectedCount != 0 {
		t.Fatal("same-intent retry failed after transaction rollback")
	}
	current = read(run)
	var wg sync.WaitGroup
	errorsOut := make(chan error, 2)
	for _, state := range []bool{true, false} {
		wg.Add(1)
		go func(selected bool) {
			defer wg.Done()
			_, err := service.changeRunSelection(ctx, library, run, runSelectionAction{RequestID: newUUID(), Revision: current.Revision, Action: "set", IDs: initial.SelectedIDs[:1], Selected: &selected})
			errorsOut <- err
		}(state)
	}
	wg.Wait()
	close(errorsOut)
	passed, conflicted := 0, 0
	for err := range errorsOut {
		var pe *planError
		if err == nil {
			passed++
		} else if errors.As(err, &pe) && pe.Status == 409 {
			conflicted++
		} else {
			t.Fatal("unexpected concurrent result", err)
		}
	}
	if passed != 1 || conflicted != 1 {
		t.Fatal("concurrent tabs overwrote one another", passed, conflicted)
	}
	current = read(run)
	cancelled, stop := context.WithCancel(ctx)
	stop()
	if _, err = service.changeRunSelection(cancelled, library, run, runSelectionAction{RequestID: newUUID(), Revision: current.Revision, Action: "all"}); err == nil || read(run).Revision != current.Revision {
		t.Fatal("cancelled operation changed saved selection")
	}
	change(run, runSelectionAction{RequestID: newUUID(), Revision: current.Revision, Action: "all"})
	current = read(run)
	plan, err := service.queuePlan(ctx, library, newUUID(), run, current.SelectedIDs[:3], "pdf")
	if err != nil {
		t.Fatal("positive immutable PDF plan admission", err)
	}
	var originalPlan string
	if err = db.QueryRow(ctx, "SELECT selection FROM native_plans WHERE library_id=$1 AND plan_id=$2", library, plan.PlanID).Scan(&originalPlan); err != nil {
		t.Fatal(err)
	}
	lastAction := runSelectionAction{RequestID: newUUID(), Revision: current.Revision, Action: "set", IDs: current.SelectedIDs[:1], Selected: &no}
	lastReceipt := change(run, lastAction)
	var retainedPlan string
	var planItems int
	if err = db.QueryRow(ctx, "SELECT selection,(SELECT count(*) FROM native_plan_items WHERE library_id=$1 AND plan_id=$2) FROM native_plans WHERE library_id=$1 AND plan_id=$2", library, plan.PlanID).Scan(&retainedPlan, &planItems); err != nil || retainedPlan != originalPlan || planItems != 3 {
		t.Fatal("selection mutation changed an already submitted PDF plan", err)
	}
	service.cfg.SelectionWriteEnabled = false
	if got := change(run, lastAction); got != lastReceipt {
		t.Fatal("disabled-admission replay lost its original receipt")
	}
	if read(run).CanEdit {
		t.Fatal("disabled writes advertised as available")
	}
	if _, err = service.changeRunSelection(ctx, library, run, runSelectionAction{RequestID: newUUID(), Revision: read(run).Revision, Action: "none"}); err == nil {
		t.Fatal("disabled admission accepted a new mutation")
	}
	service.cfg.SelectionWriteEnabled = true
	if err = migrate(true, true); err == nil {
		t.Fatal("rollback deleted durable selection choices")
	}
	current = read(run)
	token, csrf := strings.ReplaceAll(newUUID()+newUUID(), "-", ""), newUUID()
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", digest(token), account, csrf)
	request := func(method, path string, body any, cookie, header string) *httptest.ResponseRecorder {
		t.Helper()
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, service.cfg.Origin+path, bytes.NewReader(data))
		r.Header.Set("Origin", service.cfg.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF", header)
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: service.cookieName(), Value: cookie})
		}
		w := httptest.NewRecorder()
		service.ServeHTTP(w, r)
		return w
	}
	t.Run("schema9-saved-set-compatibility", func(t *testing.T) {
		service.cfg.SavedSetEnabled = true
		defer func() { service.cfg.SavedSetEnabled = false }()
		firstRun, secondRun := newRun(3), newRun(2)
		selected := read(firstRun)
		members := []savedSetMember{}
		for n, id := range selected.SelectedIDs {
			runs := []string{firstRun}
			if n < 2 {
				runs = append(runs, secondRun)
			}
			members = append(members, savedSetMember{id, runs})
		}
		_, intent, err := canonicalSavedSet(members)
		if err != nil {
			t.Fatal(err)
		}
		if err = db.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); err != nil || version != 9 {
			t.Fatal("selection migration must precede saved-set compatibility", version, err)
		}
		endpoint := "/api/libraries/" + library + "/plans"
		for _, format := range []string{"xml", "pdf"} {
			body := map[string]any{"requestID": newUUID(), "scopeKind": "saved_set", "members": members, "format": format}
			got := request("POST", endpoint, body, token, csrf)
			if got.Code != 200 {
				t.Fatalf("schema9 saved-set %s admission status=%d response=%s", format, got.Code, got.Body.String())
			}
			var admitted planReceipt
			if json.Unmarshal(got.Body.Bytes(), &admitted) != nil || admitted.SelectedCount != 3 {
				t.Fatal("saved-set admission receipt lost its exact three records")
			}
			if format == "xml" {
				change(firstRun, runSelectionAction{RequestID: newUUID(), Revision: selected.Revision, Action: "none"})
			}
			// 已提交籃子是獨立意圖；之後的勾選與停用新計畫都不能改寫或重複原計畫。
			service.cfg.SavedSetEnabled = false
			replayed := request("POST", endpoint, body, token, csrf)
			service.cfg.SavedSetEnabled = true
			if replayed.Code != 200 || !bytes.Equal(got.Body.Bytes(), replayed.Body.Bytes()) {
				t.Fatal("disabled saved-set replay changed the original receipt", replayed.Code)
			}
			var retained, storedFormat string
			var itemCount, associationCount, receiptCount int
			if err = db.QueryRow(ctx, `SELECT selection,requested_format,
 (SELECT count(*) FROM native_plan_items WHERE library_id=$1 AND plan_id=$2),
 (SELECT count(*) FROM native_plan_sources WHERE library_id=$1 AND plan_id=$2),
 (SELECT count(*) FROM native_plans WHERE library_id=$1 AND request_id=$3)
 FROM native_plans WHERE library_id=$1 AND plan_id=$2`, library, admitted.PlanID, body["requestID"]).Scan(&retained, &storedFormat, &itemCount, &associationCount, &receiptCount); err != nil || retained != intent || storedFormat != format || itemCount != 3 || associationCount != 5 || receiptCount != 1 {
				t.Fatal("selection change/replay changed saved-set membership, provenance or receipt", err)
			}
		}
		// 僅接受已知相容版本；未知後續結構仍須拒絕，且不得先寫入計畫。
		must("INSERT INTO native_schema(version) VALUES(11)")
		defer must("DELETE FROM native_schema WHERE version=11")
		requestID := newUUID()
		got := request("POST", endpoint, map[string]any{"requestID": requestID, "scopeKind": "saved_set", "members": members, "format": "xml"}, token, csrf)
		var refusedCount int
		if err = db.QueryRow(ctx, "SELECT count(*) FROM native_plans WHERE library_id=$1 AND request_id=$2", library, requestID).Scan(&refusedCount); err != nil || got.Code != 409 || !strings.Contains(got.Body.String(), "supported operator migration") || refusedCount != 0 {
			t.Fatal("unknown schema was admitted or wrote a partial plan", got.Code, err)
		}
		t.Log("SYNTHETIC schema9 XML/PDF saved sets admitted; three records/five associations and disabled replay preserved; unknown schema11 refused before writes")
	})
	selectionPath := "/api/libraries/" + library + "/runs/" + run + "/selection"
	if got := request("GET", selectionPath, nil, token, csrf); got.Code != 200 {
		t.Fatal("authorized selection read", got.Code, got.Body.String())
	}
	if got := request("POST", selectionPath, runSelectionAction{RequestID: newUUID(), Revision: current.Revision, Action: "none"}, token, "wrong"); got.Code != 403 || read(run).Revision != current.Revision {
		t.Fatal("CSRF boundary changed saved data", got.Code)
	}
	if got := request("GET", "/api/libraries/"+foreignLibrary+"/runs/"+run+"/selection", nil, token, csrf); got.Code != 404 {
		t.Fatal("account/library isolation", got.Code)
	}
	for _, format := range []string{"csv", "xlsx", "json", "jsonl"} {
		body := map[string]any{"RunID": run, "Format": format, "Selection": "selected", "SelectionRevision": current.Revision}
		got := request("POST", "/api/libraries/"+library+"/exports", body, token, csrf)
		if got.Code != 200 || got.Header().Get("X-LitraDock-Export-Scope") != "selected_saved_records" || got.Header().Get("X-LitraDock-Export-Count") != fmt.Sprint(current.SelectedCount) || got.Header().Get("X-LitraDock-Selection-Revision") != fmt.Sprint(current.Revision) {
			t.Fatal("selected export scope", format, got.Code, got.Body.String())
		}
		switch format {
		case "csv":
			table, err := csv.NewReader(bytes.NewReader(got.Body.Bytes())).ReadAll()
			if err != nil || len(table) != current.SelectedCount+1 {
				t.Fatal("selected CSV membership", err)
			}
			for i, row := range table[1:] {
				if row[0] != current.SelectedIDs[i] {
					t.Fatal("CSV selected ordering")
				}
			}
		case "xlsx":
			book, err := excelize.OpenReader(bytes.NewReader(got.Body.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			table, err := book.GetRows(book.GetSheetName(0))
			book.Close()
			if err != nil || len(table) != current.SelectedCount+1 {
				t.Fatal("selected workbook membership", err)
			}
		case "json":
			var document structuredDocument
			if json.Unmarshal(got.Body.Bytes(), &document) != nil || document.Scope.Selection != "selected_saved_records" || document.Scope.SelectionRevision == nil || *document.Scope.SelectionRevision != current.Revision || document.Scope.SavedRecords == nil || *document.Scope.SavedRecords != current.SavedCount || len(document.Records) != current.SelectedCount {
				t.Fatal("selected structured scope")
			}
			for i, record := range document.Records {
				if record.SearchID != current.SelectedIDs[i] || len(record.RunIDs) != 1 || record.RunIDs[0] != run || record.IDs.PMID == nil || record.IDs.PMCID == nil || record.IDs.DOI == nil || record.SourceOutcome == nil {
					t.Fatal("selected structured identity/provenance/outcomes")
				}
			}
		case "jsonl":
			if bytes.Count(bytes.TrimSpace(got.Body.Bytes()), []byte("\n")) != current.SelectedCount {
				t.Fatal("selected JSONL record count")
			}
		}
		if dir := os.Getenv("LITRADOCK_SELECTION_ARTIFACT_DIR"); dir != "" {
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "SYNTHETIC-selected."+format), got.Body.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	allRows, err := service.exportRows(ctx, library, run, "")
	if err != nil || len(allRows) != current.SavedCount {
		t.Fatal("all-saved export accidentally used checkboxes", err)
	}
	if got := request("POST", "/api/libraries/"+library+"/exports", map[string]any{"RunID": run, "Format": "csv", "Selection": "selected", "SelectionRevision": current.Revision - 1}, token, csrf); got.Code != 409 {
		t.Fatal("stale selected export admitted", got.Code)
	}
	if got := request("POST", "/api/libraries/"+library+"/exports", map[string]any{"RunID": run, "Format": "pdf-download", "Selection": "selected", "SelectionRevision": current.Revision}, token, csrf); got.Code != 400 {
		t.Fatal("selected metadata expanded PDF execution", got.Code)
	}
	if got := request("POST", "/api/logout", nil, token, csrf); got.Code != 200 {
		t.Fatal("logout positive control", got.Code)
	}
	if got := request("GET", selectionPath, nil, token, csrf); got.Code != 401 {
		t.Fatal("expired/revoked session read durable choices", got.Code)
	}
	// Independently requested boundary qualification: competing runs must share
	// the final action slot, while retained receipts remain replayable at capacity.
	otherRun := newRun(3)
	otherBefore := read(otherRun)
	must(`INSERT INTO native_run_selection_actions(library_id,request_id,run_id,intent,receipt)
 SELECT $1,gen_random_uuid(),$2,'SYNTHETIC ONLY capacity filler','{}'
 FROM generate_series(1,19999-(SELECT count(*) FROM native_run_selection_actions))`, library, run)
	type capacityResult struct {
		run     string
		action  runSelectionAction
		receipt runSelectionReceipt
		err     error
	}
	capacityResults := make(chan capacityResult, 2)
	startCapacity := make(chan struct{})
	for _, target := range []string{run, otherRun} {
		before := read(target)
		wg.Add(1)
		go func(target string, revision int) {
			defer wg.Done()
			<-startCapacity
			action := runSelectionAction{RequestID: newUUID(), Revision: revision, Action: "none"}
			receipt, err := service.changeRunSelection(ctx, library, target, action)
			capacityResults <- capacityResult{target, action, receipt, err}
		}(target, before.Revision)
	}
	close(startCapacity)
	wg.Wait()
	close(capacityResults)
	var winner capacityResult
	admitted := 0
	for result := range capacityResults {
		if result.err == nil {
			admitted++
			winner = result
		} else {
			var pe *planError
			if !errors.As(result.err, &pe) || pe.Status != 409 || !strings.Contains(pe.Message, "capacity is full") {
				t.Fatal("competing run must lose the final shared capacity slot", result.err)
			}
		}
	}
	var actionCount int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM native_run_selection_actions").Scan(&actionCount); err != nil || admitted != 1 || actionCount != 20000 {
		t.Fatal("action capacity did not admit exactly the final receipt", admitted, actionCount, err)
	}
	mainAtCapacity, otherAtCapacity := read(run), read(otherRun)
	if mainAtCapacity.CanEdit || otherAtCapacity.CanEdit {
		t.Fatal("full capacity falsely advertised new selection admission")
	}
	if winner.run == run && (mainAtCapacity.SelectedCount != 0 || otherAtCapacity.Revision != otherBefore.Revision) || winner.run == otherRun && (otherAtCapacity.SelectedCount != 0 || mainAtCapacity.Revision != current.Revision) {
		t.Fatal("losing capacity request changed another run")
	}
	exportable := mainAtCapacity
	if winner.run == run {
		exportable = otherAtCapacity
	}
	if rows, _, err := service.runMetadataRows(ctx, library, exportable.RunID, exportable.Revision); err != nil || len(rows) != exportable.SelectedCount {
		t.Fatal("capacity disabled an existing selected metadata export", err)
	}
	if doc, _, err := service.selectedStructuredResearch(ctx, library, exportable.RunID, exportable.Revision); err != nil || len(doc.Records) != exportable.SelectedCount {
		t.Fatal("capacity disabled existing structured metadata", err)
	}
	if _, err = service.changeRunSelection(ctx, library, run, runSelectionAction{RequestID: newUUID(), Revision: mainAtCapacity.Revision, Action: "all"}); err == nil {
		t.Fatal("a new request exceeded global action capacity")
	} else {
		var pe *planError
		if !errors.As(err, &pe) || pe.Status != 409 || !strings.Contains(pe.Message, "capacity is full") {
			t.Fatal("new UUID was not explicitly rejected for capacity", err)
		}
	}
	for _, writes := range []bool{true, false} {
		service.cfg.SelectionWriteEnabled = writes
		if got := change(winner.run, winner.action); got != winner.receipt {
			t.Fatal("capacity/write-disabled replay changed the original receipt")
		}
	}
	if got := read(run); got.Revision != mainAtCapacity.Revision || !slices.Equal(got.SelectedIDs, mainAtCapacity.SelectedIDs) {
		t.Fatal("rejected capacity action or replay changed confirmed choices")
	}
	if err = db.QueryRow(ctx, "SELECT count(*) FROM native_run_selection_actions").Scan(&actionCount); err != nil || actionCount != 20000 {
		t.Fatal("capacity refusal/replay created extra receipts", actionCount, err)
	}
	t.Log("SYNTHETIC capacity 19999->20000: one competing run admitted; next UUID rejected; exact replay retained with writes enabled and disabled")
	var sourceCalls, originalBytes int64
	if err = db.QueryRow(ctx, "SELECT (SELECT COALESCE(sum(requests),0) FROM ld_source_usage),(SELECT COALESCE(sum(octet_length(content)),0) FROM native_originals)").Scan(&sourceCalls, &originalBytes); err != nil || sourceCalls != 0 || originalBytes != 0 {
		t.Fatal("selection tests acquired or invented originals", err)
	}
}
