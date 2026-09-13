package main

import (
	"context"
	"encoding/json"
	"errors"
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

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPlanPhaseContract(t *testing.T) {
	for _, c := range []struct {
		parent, child string
		cancelled     bool
		want          string
	}{
		{"active", "", false, "waiting"}, {"paused", "", false, "paused"}, {"cancelled", "", false, "cancelled"}, {"active", "", true, "cancelled"},
		{"paused", "acquired", false, "completed"}, {"cancelled", "unavailable", false, "held"}, {"active", "rate_wait", false, "retry"}, {"active", "unsupported", false, "held"},
	} {
		var child *string
		if c.child != "" {
			child = &c.child
		}
		got, e := planPhase(c.parent, child, c.cancelled)
		if e != nil || got != c.want {
			t.Fatalf("%+v -> %s %v", c, got, e)
		}
	}
	unknown := "future_state"
	if _, e := planPhase("active", &unknown, false); e == nil {
		t.Fatal("unknown state became completion")
	}
}

func TestPlanActualPostgres(t *testing.T) {
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
	if db.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables) != nil {
		t.Fatal("schema")
	}
	if tables == 0 {
		must(nativeSchema)
	}
	account, other, library, foreign, run := newUUID(), newUUID(), newUUID(), newUUID(), newID("RUN-")
	must("INSERT INTO ld_accounts VALUES($1,$2,'synthetic-unused',true),($3,$4,'synthetic-unused',true)", account, "synthetic-plan-"+account, other, "synthetic-plan-"+other)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC PLAN A',true),($3,$4,'SYNTHETIC PLAN B',true)", library, account, foreign, other)
	must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state) VALUES($1,$2,'SYNTHETIC ONLY',25001,100,100,'complete')", library, run)
	cleanPlans := func() {
		t.Helper()
		for _, table := range []string{"native_plan_commands", "native_plan_items", "native_items", "native_batches", "native_plans"} {
			must("DELETE FROM "+table+" WHERE library_id=$1", library)
		}
	}
	defer func() {
		cleanPlans()
		for _, table := range []string{"native_originals", "ld_results", "ld_jobs", "ld_runs", "ld_identifiers", "ld_records"} {
			must("DELETE FROM "+table+" WHERE library_id=$1", library)
		}
		must("DELETE FROM ld_sessions WHERE account_id=ANY($1::uuid[])", []string{account, other})
		must("DELETE FROM ld_libraries WHERE library_id=ANY($1::uuid[])", []string{library, foreign})
		must("DELETE FROM ld_accounts WHERE account_id=ANY($1::uuid[])", []string{account, other})
	}()
	ids := []string{}
	originalHashes := []string{}
	for n := 0; n < 100; n++ {
		a := syntheticArticle()
		id := newID("LD-")
		ids = append(ids, id)
		a["SearchId"] = id
		a["Pmid"] = fmt.Sprint(990000001 + n)
		a["Pmcid"] = ""
		a["Doi"] = ""
		if n < 2 {
			a["Pmcid"] = fmt.Sprintf("PMC%d", 990000001+n)
			a["Doi"] = fmt.Sprintf("10.0000/synthetic%d", n)
		}
		b, _ := json.Marshal(a)
		must("INSERT INTO ld_records VALUES($1,$2,$3,$4)", library, id, string(b), "SYNTHETIC PLAN RECORD")
		must("INSERT INTO ld_results VALUES($1,$2,$3,$4)", library, run, id, n+1)
		if n < 2 {
			body := strings.ReplaceAll(syntheticOAI(), "990000001", fmt.Sprint(990000001+n))
			body = strings.ReplaceAll(body, "10.0000/synthetic", fmt.Sprintf("10.0000/synthetic%d", n))
			info, e := validateOriginal([]byte(body), a)
			if e != nil {
				t.Fatal(e)
			}
			originalHashes = append(originalHashes, info.Hash)
			must("INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", library, id, info.Hash, []byte(body), info.Source, info.Rights, info.Stamp, acquisitionPolicy)
		}
	}
	cfg.LocalTest = true
	cfg.Origin = "http://127.0.0.1:18090"
	cfg.Expires = time.Now().Add(time.Hour)
	cfg.AcquisitionEnabled = true
	cfg.PlanEnabled = true
	var calls atomic.Int32
	s := &server{native: true, db: db, cfg: cfg, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{Transport: nativeTransport(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("Unexpected provider call in isolated cached/unsupported plan workload")
	})}}
	get := func(id string) planSummary {
		t.Helper()
		tx, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(context.Background())
		p, _, e := s.loadPlan(ctx, tx, library, id)
		if e != nil {
			t.Fatal(e)
		}
		sum := 0
		for _, n := range p.Counts {
			sum += n
		}
		if sum != p.SelectedCount {
			t.Fatal("non-conserving counts", p)
		}
		return p
	}
	control := func(id, action string) planReceipt {
		t.Helper()
		p := get(id)
		v, e := s.controlPlan(ctx, library, id, newUUID(), action, p.Revision)
		if e != nil {
			t.Fatal(action, e)
		}
		return v
	}
	queue := func(selected []string) planReceipt {
		t.Helper()
		v, e := s.queuePlan(ctx, library, newUUID(), run, selected)
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	noPlans := func() {
		var n int
		if db.QueryRow(ctx, "SELECT count(*) FROM native_plans WHERE library_id=$1", library).Scan(&n) != nil || n != 0 {
			t.Fatal("invalid admission mutated state", n)
		}
	}
	t.Run("schema-empty-rollback-and-migration", func(t *testing.T) {
		tx, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(context.Background())
		if e = capacityLock(ctx, tx); e != nil {
			t.Fatal(e)
		}
		if e = migratePlans(ctx, tx, true); e != nil {
			t.Fatal(e)
		}
		var v int
		if tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&v) != nil || v != 1 {
			t.Fatal("rollback version")
		}
		if e = migratePlans(ctx, tx, false); e != nil {
			t.Fatal(e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
	})
	t.Run("all-inputs-validated-before-mutation", func(t *testing.T) {
		for _, input := range [][]string{nil, append(append([]string{}, ids...), newID("LD-")), {ids[0], ids[0]}, {"LD-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}, {newID("LD-")}} {
			if _, e := s.queuePlan(ctx, library, newUUID(), run, input); e == nil {
				t.Fatal("invalid selection accepted")
			}
			noPlans()
		}
		if _, e := s.queuePlan(ctx, library, "bad", run, ids[:1]); e == nil {
			t.Fatal("request")
		}
		if _, e := s.queuePlan(ctx, foreign, newUUID(), run, ids[:1]); e == nil {
			t.Fatal("foreign selection")
		}
		noPlans()
	})
	t.Run("atomic-rollback-and-connection-termination", func(t *testing.T) {
		must("CREATE FUNCTION plan_test_fail() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic rollback''; END'")
		must("CREATE TRIGGER plan_test_fail BEFORE INSERT ON native_plan_items FOR EACH ROW EXECUTE FUNCTION plan_test_fail()")
		if _, e := s.queuePlan(ctx, library, newUUID(), run, ids[:37]); e == nil {
			t.Fatal("forced rollback ignored")
		}
		noPlans()
		must("DROP TRIGGER plan_test_fail ON native_plan_items; DROP FUNCTION plan_test_fail()")
		conn, e := db.Acquire(ctx)
		if e != nil {
			t.Fatal(e)
		}
		tx, e := conn.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		pid := conn.Conn().PgConn().PID()
		mustSQL := `INSERT INTO native_plans(library_id,plan_id,run_id,request_id,selection,receipt) VALUES($1,$2,$3,$4,'synthetic','{}')`
		if _, e = tx.Exec(ctx, mustSQL, library, newID("PLN-"), run, newUUID()); e != nil {
			t.Fatal(e)
		}
		var killed bool
		if db.QueryRow(ctx, "SELECT pg_terminate_backend($1)", pid).Scan(&killed) != nil || !killed {
			t.Fatal("termination")
		}
		_ = conn.Conn().Close(ctx)
		conn.Release()
		noPlans()
	})
	t.Run("concurrent-idempotency-membership-and-control-replay", func(t *testing.T) {
		request := newUUID()
		var wg sync.WaitGroup
		results := make(chan planReceipt, 8)
		errs := make(chan error, 8)
		for n := 0; n < 8; n++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				v, e := s.queuePlan(ctx, library, request, run, ids[:37])
				results <- v
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
		id := ""
		for v := range results {
			if id == "" {
				id = v.PlanID
			}
			if id != v.PlanID {
				t.Fatal("duplicate plan")
			}
		}
		if _, e := s.queuePlan(ctx, library, request, run, ids[:36]); e == nil {
			t.Fatal("altered request accepted")
		}
		p := get(id)
		if p.SelectedCount != 37 || p.Counts["waiting"] != 37 {
			t.Fatal(p)
		}
		command := newUUID()
		first, e := s.controlPlan(ctx, library, id, command, "pause", p.Revision)
		if e != nil {
			t.Fatal(e)
		}
		second, e := s.controlPlan(ctx, library, id, command, "pause", p.Revision)
		if e != nil || first != second {
			t.Fatal("lost-response replay", e)
		}
		if _, e = s.controlPlan(ctx, library, id, command, "cancel", p.Revision); e == nil {
			t.Fatal("altered control accepted")
		}
		if _, e = s.controlPlan(ctx, library, id, newUUID(), "cancel", p.Revision); e == nil {
			t.Fatal("stale revision accepted")
		}
		p = get(id)
		if p.Counts["paused"] != 37 || p.Admission.WaitingCount != 37 {
			t.Fatal("pause conservation", p)
		}
		tx, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if e = migratePlans(ctx, tx, true); e == nil {
			t.Fatal("rollback discarded plan")
		}
		_ = tx.Rollback(ctx)
		cleanPlans()
	})
	t.Run("shared-capacity-reservation-and-transfer", func(t *testing.T) {
		for n := 0; n < 10; n++ {
			queue(ids)
		}
		if _, e := s.queueBatch(ctx, library, newUUID(), ids[:1]); e == nil {
			t.Fatal("batch bypassed plan reservations")
		}
		if _, e := s.queuePlan(ctx, library, newUUID(), run, ids[:1]); e == nil {
			t.Fatal("plan over capacity")
		}
		if e := s.admitPlan(ctx); e != nil {
			t.Fatal(e)
		}
		var count int
		if db.QueryRow(ctx, "SELECT (SELECT count(*) FROM native_items)+(SELECT count(*) FROM native_plan_items WHERE child_batch_id IS NULL)").Scan(&count) != nil || count != 1000 {
			t.Fatal("double counted transfer", count)
		}
		cleanPlans()
		for n := 0; n < 100; n++ {
			if _, e := s.queueBatch(ctx, library, newUUID(), ids[:10]); e != nil {
				t.Fatal(e)
			}
		}
		if _, e := s.queuePlan(ctx, library, newUUID(), run, ids[:1]); e == nil {
			t.Fatal("plan bypassed standalone capacity")
		}
		cleanPlans()
	})
	t.Run("concurrent-scheduler-and-restart-37-mixed-records", func(t *testing.T) {
		v := queue(ids[:37])
		var wg sync.WaitGroup
		errs := make(chan error, 8)
		for n := 0; n < 8; n++ {
			wg.Add(1)
			go func() { defer wg.Done(); errs <- s.admitPlan(ctx) }()
		}
		wg.Wait()
		close(errs)
		for e := range errs {
			if e != nil {
				t.Fatal(e)
			}
		}
		var children int
		if db.QueryRow(ctx, "SELECT count(*) FROM native_batches WHERE library_id=$1 AND plan_id=$2", library, v.PlanID).Scan(&children) != nil || children != 1 {
			t.Fatal("duplicate children", children)
		}
		var child string
		if db.QueryRow(ctx, "SELECT batch_id FROM native_batches WHERE library_id=$1 AND plan_id=$2", library, v.PlanID).Scan(&child) != nil {
			t.Fatal("child")
		}
		if e := s.controlBatch(ctx, library, child, "cancel"); e == nil {
			t.Fatal("child bypassed parent")
		}
		for n := 0; n < 37; n++ {
			s.batchOne(ctx)
			if n == 12 {
				s = &server{native: true, db: db, cfg: cfg, provider: s.provider, slots: s.slots, loginGate: s.loginGate}
			}
		}
		p := get(v.PlanID)
		if p.State != "partial" || p.Counts["completed"] != 2 || p.Counts["held"] != 35 || p.Admission.AdmittedCount != 37 {
			t.Fatal("mixed plan", p)
		}
		if db.QueryRow(ctx, "SELECT count(*) FROM native_batches WHERE library_id=$1 AND plan_id=$2", library, v.PlanID).Scan(&children) != nil || children != 4 {
			t.Fatal("groups", children)
		}
		detail, e := s.planDetail(ctx, library, v.PlanID, 0, 25)
		if e != nil {
			t.Fatal(e)
		}
		items := detail.(map[string]any)["items"].([]planItem)
		if len(items) != 25 || !items[0].DownloadAvailable || !items[1].DownloadAvailable || items[0].OriginalHash == items[1].OriginalHash {
			t.Fatal("distinct originals")
		}
		s.cfg.BlockedPMCIDs = []string{"PMC990000001"}
		detail, e = s.planDetail(ctx, library, v.PlanID, 0, 5)
		if e != nil {
			t.Fatal(e)
		}
		if detail.(map[string]any)["items"].([]planItem)[0].DownloadAvailable || get(v.PlanID).Counts["completed"] != 2 {
			t.Fatal("availability conflated with history")
		}
		s.cfg.BlockedPMCIDs = nil
		if _, e = s.exportXLSX(ctx, library, "", child); e != nil {
			t.Fatal(e)
		}
		if calls.Load() != 0 {
			t.Fatal("cache/held workload sent provider traffic")
		}
		cleanPlans()
	})
	t.Run("cooldown-and-cancel-never-admitted", func(t *testing.T) {
		v := queue(ids[:37])
		must("UPDATE ld_source_budget SET next_at=now()+interval '1 hour' WHERE name='ncbi'")
		if e := s.admitPlan(ctx); e != nil {
			t.Fatal(e)
		}
		p := get(v.PlanID)
		if p.Admission.AdmittedCount != 0 {
			t.Fatal("cooldown admission")
		}
		detail, e := s.planDetail(ctx, library, v.PlanID, 0, 5)
		if e != nil || detail.(map[string]any)["plan"].(planSummary).Admission.BlockedReasonCode != "source_cooldown" {
			t.Fatal("cooldown missing", e)
		}
		control(v.PlanID, "cancel")
		if get(v.PlanID).Counts["cancelled"] != 37 {
			t.Fatal("cancel waiting")
		}
		must("UPDATE ld_source_budget SET next_at=now() WHERE name='ncbi'")
		cleanPlans()
	})
	t.Run("lease-fenced-cancel-pause-and-retry-ceiling", func(t *testing.T) {
		v := queue(ids[2:14])
		if e := s.admitPlan(ctx); e != nil {
			t.Fatal(e)
		}
		lease := newUUID()
		l, b, id, e := s.claimBatch(ctx, lease)
		if e != nil {
			t.Fatal(e)
		}
		control(v.PlanID, "pause")
		var token string
		if db.QueryRow(ctx, "SELECT COALESCE(lease::text,'') FROM native_items WHERE library_id=$1 AND batch_id=$2 AND search_id=$3", l, b, id).Scan(&token) != nil || token != "" {
			t.Fatal("pause left lease")
		}
		control(v.PlanID, "resume")
		must("UPDATE native_items SET state='running',attempts=3,lease=$4,lease_until=now()-interval '1 second' WHERE library_id=$1 AND batch_id=$2 AND search_id=$3", l, b, id, newUUID())
		if e = s.recoverBatchLeases(ctx); e != nil {
			t.Fatal(e)
		}
		var attempts int
		var state string
		if db.QueryRow(ctx, "SELECT state,attempts FROM native_items WHERE library_id=$1 AND batch_id=$2 AND search_id=$3", l, b, id).Scan(&state, &attempts) != nil || state != "failed" || attempts != 3 {
			t.Fatal("lease ceiling")
		}
		must("UPDATE native_items SET state='transient',attempts=2 WHERE library_id=$1 AND batch_id=$2 AND search_id<>$3", l, b, id)
		control(v.PlanID, "retry")
		if get(v.PlanID).Counts["retry"] != 1 {
			t.Fatal("exhausted retried")
		}
		control(v.PlanID, "cancel")
		if get(v.PlanID).State != "cancelled" {
			t.Fatal("cancel")
		}
		cleanPlans()
	})
	t.Run("actual-in-flight-cancel-fences-original-publication", func(t *testing.T) {
		v := queue(ids[2:3])
		a := syntheticArticle()
		a["SearchId"] = ids[2]
		raw, _ := json.Marshal(a)
		must("UPDATE ld_records SET metadata=$3 WHERE library_id=$1 AND search_id=$2", library, ids[2], string(raw))
		entered, release := make(chan struct{}), make(chan struct{})
		s.provider = &http.Client{Transport: nativeTransport(func(*http.Request) (*http.Response, error) {
			close(entered)
			<-release
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/xml"}}, Body: io.NopCloser(strings.NewReader(syntheticOAI()))}, nil
		})}
		done := make(chan struct{})
		go func() { s.batchOne(ctx); close(done) }()
		select {
		case <-entered:
		case <-time.After(10 * time.Second):
			t.Fatal("worker did not start")
		}
		control(v.PlanID, "cancel")
		close(release)
		<-done
		var n int
		if db.QueryRow(ctx, "SELECT count(*) FROM native_originals WHERE library_id=$1 AND search_id=$2", library, ids[2]).Scan(&n) != nil || n != 0 {
			t.Fatal("late publication")
		}
		if get(v.PlanID).Counts["cancelled"] != 1 {
			t.Fatal("cancel lost")
		}
		must("UPDATE ld_source_budget SET next_at=now() WHERE name='ncbi'")
		cleanPlans()
	})
	t.Run("actual-http-owner-csrf-and-get-only-reopen", func(t *testing.T) {
		v := queue(ids[:12])
		tokenA, tokenB := randomToken(), randomToken()
		csrf := randomToken()
		must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour'),($4,$5,$3,now()+interval '1 hour')", digest(tokenA), account, csrf, digest(tokenB), other)
		request := func(method, path, body, token, csrfValue string) int {
			r := httptest.NewRequest(method, cfg.Origin+path, strings.NewReader(body))
			r.Header.Set("Origin", cfg.Origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF", csrfValue)
			r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: token})
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			return w.Code
		}
		path := "/api/libraries/" + library + "/plans/" + v.PlanID
		for n := 0; n < 3; n++ {
			if request("GET", path, "", tokenA, csrf) != 200 {
				t.Fatal("reopen")
			}
		}
		if request("GET", path, "", tokenB, csrf) != 404 {
			t.Fatal("foreign GET")
		}
		body := fmt.Sprintf(`{"requestID":%q,"expectedRevision":1,"value":"cancel"}`, newUUID())
		if request("POST", path+"/control", body, tokenB, csrf) != 404 || request("POST", path+"/control", body, tokenA, "") != 403 {
			t.Fatal("foreign/control CSRF")
		}
		if get(v.PlanID).Revision != 1 || get(v.PlanID).Admission.AdmittedCount != 0 {
			t.Fatal("GET/denial scheduled work")
		}
		cleanPlans()
	})
	var hashes []string
	rows, e := db.Query(ctx, "SELECT hash FROM native_originals WHERE library_id=$1 ORDER BY hash", library)
	if e != nil {
		t.Fatal(e)
	}
	hashes, e = pgx.CollectRows(rows, pgx.RowTo[string])
	if e != nil || len(hashes) != 2 || hashes[0] == hashes[1] {
		t.Fatal("original preservation", e)
	}
	t.Log("SYNTHETIC actual PG: 37 mixed records, 4 groups, two distinct cached originals, shared 1000-item reservations, race/rollback/termination/lease/ownership controls; no genuine provider proof")
}
