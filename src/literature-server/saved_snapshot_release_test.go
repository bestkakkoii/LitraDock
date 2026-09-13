package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// These additional schedules operate only inside the dedicated synthetic PG
// test established by TestSavedSnapshotActualPostgres; never a live library.
func testSnapshotReleaseGates(t *testing.T, ctx context.Context, s *server, library, account string, members []savedSetMember, saved planReceipt) {
	t.Helper()
	must := func(q string, args ...any) {
		t.Helper()
		if _, e := s.db.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if e := s.db.QueryRow(ctx, q, args...).Scan(&n); e != nil {
			t.Fatal(e)
		}
		return n
	}
	conflict := func(e error) bool { var p *planError; return errors.As(e, &p) && p.Status == 409 }
	// Two different intents racing with one UUID must produce one whole winner.
	id := newUUID()
	done := make(chan error, 2)
	for _, scope := range [][]savedSetMember{members[:1], members[:2]} {
		go func(m []savedSetMember) { _, e := s.saveResearchSnapshot(ctx, library, id, "pdf", m); done <- e }(scope)
	}
	a, b := <-done, <-done
	if !((a == nil && conflict(b)) || (b == nil && conflict(a))) {
		t.Fatal("competing intent not one winner", a, b)
	}
	if count("SELECT count(*) FROM native_plans WHERE library_id=$1 AND request_id=$2", library, id) != 1 {
		t.Fatal("duplicate intent header")
	}
	missing := newUUID()
	scope := []savedSetMember{members[0], {SearchID: newID("LD-"), RunIDs: members[0].RunIDs}}
	_, e := s.saveResearchSnapshot(ctx, library, missing, "pdf", scope)
	var pe *planError
	if !errors.As(e, &pe) || pe.Status != 404 || count("SELECT count(*) FROM native_plans WHERE library_id=$1 AND request_id=$2", library, missing) != 0 {
		t.Fatal("mixed missing pair partially committed", e)
	}
	// Cross the actual 100/library admission boundary with two concurrent saves.
	for count("SELECT count(*) FROM native_research_snapshots WHERE library_id=$1", library) < 99 {
		if _, e = s.saveResearchSnapshot(ctx, library, newUUID(), "pdf", members[:1]); e != nil {
			t.Fatal(e)
		}
	}
	for range 2 {
		go func() { _, e := s.saveResearchSnapshot(ctx, library, newUUID(), "pdf", members[:1]); done <- e }()
	}
	a, b = <-done, <-done
	if !((a == nil && conflict(b)) || (b == nil && conflict(a))) || count("SELECT count(*) FROM native_research_snapshots WHERE library_id=$1", library) != 100 {
		t.Fatal("quota race overshot or lost both", a, b)
	}
	// Full quota cannot block replay of the already committed, exact intent.
	var originalRequest string
	if e = s.db.QueryRow(ctx, "SELECT request_id::text FROM native_plans WHERE library_id=$1 AND plan_id=$2", library, saved.PlanID).Scan(&originalRequest); e != nil {
		t.Fatal(e)
	}
	r, e := s.saveResearchSnapshot(ctx, library, originalRequest, "pdf", members)
	if e != nil || r.PlanID != saved.PlanID {
		t.Fatal("full quota broke replay", e)
	}
	// The occupied snapshot membership itself must not consume acquisition slots.
	tx, e := s.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	e = acquisitionCapacity(ctx, tx, 1)
	tx.Rollback(ctx)
	if e != nil {
		t.Fatal("snapshots consumed acquisition capacity", e)
	}
	token, csrf := strings.Repeat("b", 64), "SYNTHETIC-release-csrf"
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", digest(token), account, csrf)
	request := func() *http.Request {
		r := httptest.NewRequest("POST", s.cfg.Origin+"/api/libraries/"+library+"/plans/"+saved.PlanID+"/exports", strings.NewReader(`{"format":"zip"}`))
		r.Header.Set("Origin", s.cfg.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF", csrf)
		r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: token})
		return r
	}
	waitLock := func(q string) {
		t.Helper()
		for until := time.Now().Add(3 * time.Second); time.Now().Before(until); {
			var yes bool
			if e = s.db.QueryRow(ctx, q).Scan(&yes); e != nil {
				t.Fatal(e)
			}
			if yes {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("required lock schedule not established")
	}
	// ZIP reads before account disable: the attachment must be denied at handoff.
	for _, disable := range []bool{false, true} {
		block, e := s.db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = block.Exec(ctx, "LOCK native_research_snapshots IN ACCESS EXCLUSIVE MODE"); e != nil {
			t.Fatal(e)
		}
		responses := make(chan *httptest.ResponseRecorder, 1)
		go func() { w := httptest.NewRecorder(); s.ServeHTTP(w, request()); responses <- w }()
		waitLock("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='native_research_snapshots'::regclass AND NOT granted)")
		if disable {
			must("UPDATE ld_accounts SET enabled=false WHERE account_id=$1", account)
		}
		if e = block.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		w := <-responses
		if disable {
			if w.Code != 401 || w.Header().Get("Content-Disposition") != "" {
				t.Fatal("late disabled ZIP escaped", w.Code)
			}
		} else if w.Code != 200 || w.Header().Get("Content-Disposition") == "" {
			t.Fatal("positive ZIP failed", w.Code)
		}
		must("UPDATE ld_accounts SET enabled=true WHERE account_id=$1", account)
	}
	// A response already holding admission share locks orders before a later
	// revocation; controlled slow Write and a real blocked DELETE establish this.
	w := &snapshotHeldWriter{ResponseRecorder: httptest.NewRecorder(), entered: make(chan struct{}), release: make(chan struct{})}
	finished := make(chan struct{})
	go func() { s.ServeHTTP(w, request()); close(finished) }()
	select {
	case <-w.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("slow body not reached")
	}
	deleted := make(chan error, 1)
	go func() {
		_, e := s.db.Exec(ctx, "DELETE FROM ld_sessions WHERE token_hash=$1", digest(token))
		deleted <- e
	}()
	waitLock("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='transactionid' AND NOT granted)")
	select {
	case e := <-deleted:
		t.Fatal("revocation passed body lock", e)
	default:
	}
	close(w.release)
	<-finished
	if e = <-deleted; e != nil {
		t.Fatal(e)
	}
	if w.Code != 200 || w.Body.Len() == 0 {
		t.Fatal("ordered positive transfer failed")
	}
	denied := httptest.NewRecorder()
	s.ServeHTTP(denied, request())
	if denied.Code != 401 {
		t.Fatal("post-transfer revoked request accepted")
	}
	t.Log("SYNTHETIC release schedules: conflicting concurrent intents; mixed missing pair atomic rejection; 99-to-100 concurrent quota boundary and full-capacity replay; snapshot/acquisition capacity separation; late account-disable ZIP denial plus positive; slow body orders before real session deletion")
}

type snapshotHeldWriter struct {
	*httptest.ResponseRecorder
	entered, release chan struct{}
}

func (w *snapshotHeldWriter) Write(b []byte) (int, error) {
	close(w.entered)
	<-w.release
	return w.ResponseRecorder.Write(b)
}
