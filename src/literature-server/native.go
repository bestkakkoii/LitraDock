package main

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Native schema v1 has no external migration/runtime dependency. Existing pilot databases are never targets.
const nativeSchema = `
CREATE TABLE native_schema(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ld_accounts(account_id uuid PRIMARY KEY,login text NOT NULL UNIQUE,password_hash text NOT NULL,enabled boolean NOT NULL DEFAULT true);
CREATE TABLE ld_sessions(token_hash text PRIMARY KEY,account_id uuid NOT NULL REFERENCES ld_accounts,csrf text NOT NULL,expires_at timestamptz NOT NULL);
CREATE INDEX session_expiry ON ld_sessions(expires_at);
CREATE TABLE ld_libraries(library_id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES ld_accounts,name text NOT NULL,ready boolean NOT NULL DEFAULT true);
CREATE TABLE ld_records(library_id uuid NOT NULL REFERENCES ld_libraries,search_id text NOT NULL,metadata text NOT NULL,title text NOT NULL,PRIMARY KEY(library_id,search_id));
CREATE TABLE ld_identifiers(library_id uuid NOT NULL,kind text NOT NULL,value text NOT NULL,search_id text NOT NULL,PRIMARY KEY(library_id,kind,value),UNIQUE(library_id,search_id,kind),FOREIGN KEY(library_id,search_id) REFERENCES ld_records);
CREATE TABLE ld_runs(library_id uuid NOT NULL REFERENCES ld_libraries,run_id text NOT NULL,input text NOT NULL,total integer NOT NULL DEFAULT 0,fetched integer NOT NULL DEFAULT 0,requested_limit integer NOT NULL,state text NOT NULL,reason text NOT NULL DEFAULT '',snapshot text NOT NULL DEFAULT '{}',PRIMARY KEY(library_id,run_id));
CREATE TABLE ld_results(library_id uuid NOT NULL,run_id text NOT NULL,search_id text NOT NULL,rank integer NOT NULL,PRIMARY KEY(library_id,run_id,search_id),FOREIGN KEY(library_id,run_id) REFERENCES ld_runs,FOREIGN KEY(library_id,search_id) REFERENCES ld_records);
CREATE TABLE ld_jobs(library_id uuid NOT NULL REFERENCES ld_libraries,job_id text NOT NULL,kind text NOT NULL CHECK(kind='search'),run_id text NOT NULL,state text NOT NULL,reason text NOT NULL DEFAULT '',lease_token uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(library_id,job_id),FOREIGN KEY(library_id,run_id) REFERENCES ld_runs);
CREATE INDEX search_ready ON ld_jobs(state,created_at);
CREATE TABLE ld_recovery_guard(singleton boolean PRIMARY KEY CHECK(singleton),required boolean NOT NULL);
INSERT INTO ld_recovery_guard VALUES(true,false);
CREATE TABLE ld_source_budget(name text PRIMARY KEY,next_at timestamptz NOT NULL);
INSERT INTO ld_source_budget VALUES('ncbi',now());
CREATE TABLE ld_source_usage(provider text NOT NULL,day text NOT NULL,requests integer NOT NULL,PRIMARY KEY(provider,day));
CREATE TABLE native_batches(library_id uuid NOT NULL REFERENCES ld_libraries,batch_id text NOT NULL,request_id uuid NOT NULL,selection text NOT NULL,state text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(library_id,batch_id),UNIQUE(library_id,request_id));
CREATE TABLE native_items(library_id uuid NOT NULL,batch_id text NOT NULL,search_id text NOT NULL,rank integer NOT NULL,state text NOT NULL,reason text NOT NULL DEFAULT '',attempts integer NOT NULL DEFAULT 0,lease uuid,lease_until timestamptz,original_hash text,PRIMARY KEY(library_id,batch_id,search_id),FOREIGN KEY(library_id,batch_id) REFERENCES native_batches,FOREIGN KEY(library_id,search_id) REFERENCES ld_records);
CREATE TABLE native_originals(library_id uuid NOT NULL,search_id text NOT NULL,hash text NOT NULL,content bytea NOT NULL,source_uri text NOT NULL,rights_uri text NOT NULL,repository_stamp text NOT NULL,policy text NOT NULL,acquired_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(library_id,search_id,hash),FOREIGN KEY(library_id,search_id) REFERENCES ld_records,CHECK(octet_length(content)<=8388608));
INSERT INTO native_schema(version) VALUES(1);
`

func nativeHash(password string) (string, error) {
	if !utf8.ValidString(password) || utf8.RuneCountInString(password) < 12 || utf8.RuneCountInString(password) > 256 {
		return "", errors.New("password must contain12–256 valid Unicode code points")
	}
	salt := make([]byte, 32)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	key, e := pbkdf2.Key(sha256.New, password, salt, 600000, 32)
	if e != nil {
		return "", e
	}
	return "pbkdf2-sha256$600000$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key), nil
}
func verifyNative(encoded, password string) bool {
	p := strings.Split(encoded, "$")
	if len(p) != 4 || p[0] != "pbkdf2-sha256" || p[1] != "600000" {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(p[2])
	if e != nil || len(salt) != 32 {
		return false
	}
	want, e := base64.RawStdEncoding.DecodeString(p[3])
	if e != nil || len(want) != 32 {
		return false
	}
	got, e := pbkdf2.Key(sha256.New, password, salt, 600000, 32)
	return e == nil && same(string(got), string(want))
}

// Operator commands take only a verb in argv. Account/login/password/config are protected environment inputs.
func nativeOperator(ctx context.Context, verb string) error {
	b, e := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if e != nil {
		return e
	}
	var c config
	if json.Unmarshal(b, &c) != nil {
		return errors.New("invalid config")
	}
	pc, e := pgxpool.ParseConfig(c.Database)
	if e != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_") {
		return errors.New("native dedicated database required")
	}
	pc.MaxConns = 2
	db, e := pgxpool.NewWithConfig(ctx, pc)
	if e != nil {
		return e
	}
	defer db.Close()
	login := strings.ToLower(strings.TrimSpace(os.Getenv("LITRADOCK_OPERATOR_LOGIN")))
	password := os.Getenv("LITRADOCK_OPERATOR_PASSWORD")
	os.Unsetenv("LITRADOCK_OPERATOR_PASSWORD")
	var hash string
	if verb == "provision" {
		if login == "" || !utf8.ValidString(login) || utf8.RuneCountInString(login) > 120 {
			return errors.New("invalid login")
		}
		hash, e = nativeHash(password)
		if e != nil {
			return e
		}
	}
	if verb != "bootstrap" && verb != "provision" {
		return errors.New("unsupported operator command")
	}
	tx, e := db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(context.Background())
	if _, e = tx.Exec(ctx, "SET LOCAL lock_timeout='3s'; SELECT pg_advisory_xact_lock(724913010)"); e != nil {
		return e
	}
	if verb == "bootstrap" {
		var tables int
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); e != nil {
			return e
		}
		if tables != 0 {
			return errors.New("bootstrap requires empty dedicated database")
		}
		if _, e = tx.Exec(ctx, nativeSchema); e != nil {
			return e
		}
	} else {
		var version int
		if e = tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); e != nil || version != 1 {
			return errors.New("native schema required")
		}
		if _, e = tx.Exec(ctx, "INSERT INTO ld_accounts(account_id,login,password_hash) VALUES($1,$2,$3)", newUUID(), login, hash); e != nil {
			return errors.New("account provisioning failed; existing account not changed")
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	fmt.Println("Native operator transaction committed; no credential values emitted.")
	return nil
}
