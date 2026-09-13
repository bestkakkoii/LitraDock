package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// A separate test-only fixture seeds already acquired originals. No provider
// replay is advertised as fresh source integration, and it cannot enter a build.
func seedBundleBrowser(t *testing.T, ctx context.Context, db *pgxpool.Pool, login string) map[string]any {
	t.Helper()
	must := func(q string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	var owner string
	if e := db.QueryRow(ctx, "SELECT account_id::text FROM ld_accounts WHERE login=$1", login).Scan(&owner); e != nil {
		t.Fatal(e)
	}
	lib, run, plan, child := newUUID(), newID("RUN-"), newID("PLN-"), newID("BAT-")
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC bundle browser',true)", lib, owner)
	must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state,reason) VALUES($1,$2,'SYNTHETIC saved PDF bundle metadata',25001,3,3,'partial','Only three saved synthetic records')", lib, run)
	must("INSERT INTO native_plans(library_id,plan_id,run_id,request_id,selection,receipt,requested_format) VALUES($1,$2,$3,$4,'synthetic','{}','pdf')", lib, plan, run, newUUID())
	must("INSERT INTO native_batches(library_id,batch_id,request_id,selection,state,requested_format,plan_id) VALUES($1,$2,$3,'synthetic','complete','pdf',$4)", lib, child, newUUID(), plan)
	ids := []string{}
	hashes := []string{}
	for n := 0; n < 3; n++ {
		id := newID("LD-")
		ids = append(ids, id)
		a := syntheticArticle()
		a["SearchId"] = id
		a["Title"] = fmt.Sprintf("SYNTHETIC ONLY bundle paper %d 中文", n+1)
		metadata, _ := json.Marshal(a)
		must("INSERT INTO ld_records VALUES($1,$2,$3,'SYNTHETIC')", lib, id, string(metadata))
		must("INSERT INTO ld_results VALUES($1,$2,$3,$4)", lib, run, id, n+1)
		state, reason, hash := "unavailable", "Unknown rights; open the direct source links", ""
		if n < 2 {
			b := syntheticPDF(strings.Repeat("x", 5*1024*1024) + fmt.Sprint(n))
			proof := syntheticPDFProof(t, b, a)
			info, e := validatePDF(b, proofBytes(proof), a)
			if e != nil {
				t.Fatal(e)
			}
			hash = info.Hash
			state = "acquired"
			reason = ""
			hashes = append(hashes, hash)
			must("INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy,format,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pdf',$9)", lib, id, hash, b, info.Source, info.Rights, info.Stamp, pdfPolicy, proofBytes(proof))
		}
		must("INSERT INTO native_items(library_id,batch_id,search_id,rank,state,reason,original_hash) VALUES($1,$2,$3,$4,$5,$6,$7)", lib, child, id, n+1, state, reason, hash)
		must("INSERT INTO native_plan_items(library_id,plan_id,search_id,rank,child_batch_id) VALUES($1,$2,$3,$4,$5)", lib, plan, id, n+1, child)
	}
	return map[string]any{"library": lib, "run": run, "plan": plan, "searchIDs": ids, "originalSHA256": hashes, "scope": "SYNTHETIC already-acquired originals; zero provider requests"}
}
