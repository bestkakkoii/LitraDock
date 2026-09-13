package main

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"strings"
	"testing"
	"time"
)

func TestSharedTrialPasswordBoundary(t *testing.T) {
	// Explicitly synthetic values; actual operator secrets are never test inputs.
	for _, value := range []string{"", "abc", string([]byte{0xff}), strings.Repeat("x", 257)} {
		if _, err := sharedTrialHash(value, "transition-reviewed-shared-trial"); err == nil {
			t.Fatal("invalid secret admitted")
		}
	}
	if _, err := sharedTrialHash("test", ""); err == nil {
		t.Fatal("missing confirmation accepted")
	}
	if _, err := nativeHash("test"); err == nil {
		t.Fatal("normal account policy weakened")
	}
	hash, err := sharedTrialHash("test", "transition-reviewed-shared-trial")
	if err != nil || !verifyPassword(hash, "test") || verifyPassword(hash, "other") {
		t.Fatal("shared trial verifier contract")
	}
	other, err := sharedTrialHash("test", "transition-reviewed-shared-trial")
	if err != nil || hash == other {
		t.Fatal("salt not independently random")
	}
}

func TestSharedTrialActualPostgres(t *testing.T) {
	if os.Getenv("LITRADOCK_NATIVE_TEST") != "yes" {
		t.Skip("Dedicated actual PostgreSQL required")
	}
	raw, e := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if e != nil {
		t.Fatal("config")
	}
	var cfg config
	if json.Unmarshal(raw, &cfg) != nil {
		t.Fatal("config")
	}
	pc, e := pgxpool.ParseConfig(cfg.Database)
	if e != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_test_") {
		t.Fatal("isolated target required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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
		t.Fatal("inspect")
	}
	if tables == 0 {
		must(nativeSchema)
	}
	a, b, lib := newUUID(), newUUID(), newUUID()
	old, _ := nativeHash("SYNTHETIC-original-password")
	loginA, loginB := "synthetic-"+a, "synthetic-"+b
	must("INSERT INTO ld_accounts VALUES($1,$2,$3,true),($4,$5,$3,true)", a, loginA, old, b, loginB)
	defer func() {
		must("DELETE FROM ld_sessions WHERE account_id=ANY($1::uuid[])", []string{a, b})
		must("DELETE FROM ld_libraries WHERE owner_id=$1", a)
		must("DELETE FROM ld_accounts WHERE account_id=ANY($1::uuid[])", []string{a, b})
	}()
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC reviewed demonstration',true)", lib, a)
	s := &server{native: true, db: db}
	tok1, _, e := s.login(ctx, loginA, "SYNTHETIC-original-password")
	if e != nil {
		t.Fatal(e)
	}
	tok2, _, e := s.login(ctx, loginA, "SYNTHETIC-original-password")
	if e != nil {
		t.Fatal(e)
	}
	tokB, _, e := s.login(ctx, loginB, "SYNTHETIC-original-password")
	if e != nil {
		t.Fatal(e)
	}
	invoke := func(account, login, password, confirm string) error {
		t.Setenv("LITRADOCK_OPERATOR_ACCOUNT", account)
		t.Setenv("LITRADOCK_OPERATOR_LOGIN", login)
		t.Setenv("LITRADOCK_OPERATOR_PASSWORD", password)
		t.Setenv("LITRADOCK_OPERATOR_SHARED_TRIAL", confirm)
		return nativeOperator(ctx, "transition-shared-trial")
	}
	target := "trial-" + a
	assertOriginal := func() {
		t.Helper()
		var got string
		var n int
		if db.QueryRow(ctx, "SELECT password_hash FROM ld_accounts WHERE account_id=$1 AND login=$2", a, loginA).Scan(&got) != nil || got != old {
			t.Fatal("mutation on rejected/rolled back transition")
		}
		if db.QueryRow(ctx, "SELECT count(*) FROM ld_sessions WHERE account_id=$1", a).Scan(&n) != nil || n != 2 {
			t.Fatal("sessions changed on rejection")
		}
	}
	for _, x := range [][4]string{{"malformed", target, "test", "transition-reviewed-shared-trial"}, {newUUID(), target, "test", "transition-reviewed-shared-trial"}, {a, target, "abc", "transition-reviewed-shared-trial"}, {a, target, "test", ""}, {a, loginB, "test", "transition-reviewed-shared-trial"}} {
		if invoke(x[0], x[1], x[2], x[3]) == nil {
			t.Fatal("invalid/conflicting transition accepted")
		}
		assertOriginal()
	}
	// Forced rollback after both credential update and session deletion.
	hash, _ := sharedTrialHash("test", "transition-reviewed-shared-trial")
	tx, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if transitionSharedTrial(ctx, tx, a, target, hash) != nil {
		t.Fatal("transition")
	}
	tx.Rollback(ctx)
	assertOriginal()
	// The actual operator must honor the request-admission fence and fail without mutation.
	conn, e := db.Acquire(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = conn.Exec(ctx, "SELECT pg_advisory_lock_shared(724913010)"); e != nil {
		t.Fatal(e)
	}
	if invoke(a, target, "test", "transition-reviewed-shared-trial") == nil {
		t.Fatal("contention accepted")
	}
	conn.Exec(ctx, "SELECT pg_advisory_unlock_all()")
	conn.Release()
	assertOriginal()
	if invoke(a, target, "test", "transition-reviewed-shared-trial") != nil {
		t.Fatal("authorized transition")
	}
	for _, token := range []string{tok1, tok2} {
		sess, e := s.authenticate(ctx, token)
		if e != nil || sess != nil {
			t.Fatal("old session accepted")
		}
	}
	if sess, e := s.authenticate(ctx, tokB); e != nil || sess == nil || sess.Account != b {
		t.Fatal("other account changed")
	}
	if token, _, e := s.login(ctx, loginA, "SYNTHETIC-original-password"); e != nil || token != "" {
		t.Fatal("retired login accepted")
	}
	fresh, sess, e := s.login(ctx, target, "test")
	if e != nil || fresh == "" || sess.Account != a {
		t.Fatal("new login failed or identity changed")
	}
	var owner string
	if db.QueryRow(ctx, "SELECT owner_id::text FROM ld_libraries WHERE library_id=$1", lib).Scan(&owner) != nil || owner != a {
		t.Fatal("library changed")
	}
	must("UPDATE ld_accounts SET enabled=false WHERE account_id=$1", a)
	if invoke(a, target, "test", "transition-reviewed-shared-trial") != nil {
		t.Fatal("repeated transition")
	}
	if token, _, e := s.login(ctx, target, "test"); e != nil || token != "" {
		t.Fatal("disabled account enabled")
	}
	var enabled bool
	if db.QueryRow(ctx, "SELECT enabled FROM ld_accounts WHERE account_id=$1", a).Scan(&enabled) != nil || enabled {
		t.Fatal("enabled flag changed")
	}
}
