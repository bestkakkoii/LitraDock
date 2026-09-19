package main

import (
	"context"
	"testing"
)

// 僅供獨立測試執行檔：用真實狀態轉移建立大型 PMID 集合，再明確以
// SQL 注入標記的 metadata fixture。這不代表 20,000 筆來源下載能力。
func seedQueryCaptureBrowser(t *testing.T, ctx context.Context, s *server, login string) map[string]any {
	t.Helper()
	must := func(q string, args ...any) {
		t.Helper()
		if _, err := s.db.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	var owner string
	if err := s.db.QueryRow(ctx, "SELECT account_id::text FROM ld_accounts WHERE login=$1", login).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	library := newUUID()
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC large capture fixture',true)", library, owner)
	fixtureSession := &session{Account: owner, Hash: digest(randomToken()), CSRF: newUUID()}
	must("INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '1 hour')", fixtureSession.Hash, owner, fixtureSession.CSRF)
	ctx = context.WithValue(ctx, snapshotSessionKey{}, fixtureSession)
	run, err := s.queueUserSearch(ctx, library, "SYNTHETIC LARGE CAPTURE FIXTURE", 100, newUUID(), "unkeyed")
	if err != nil {
		t.Fatal(err)
	}
	status := func() *continuationView {
		t.Helper()
		v, err := s.continuationStatus(ctx, library, run)
		if err != nil || v == nil {
			t.Fatal("seed status", err)
		}
		return v
	}
	action := func(value string) {
		t.Helper()
		_, err := s.controlContinuation(ctx, library, run, continuationAction{RequestID: newUUID(), Revision: status().Revision, Action: value})
		if err != nil {
			t.Fatal("seed action", err)
		}
	}
	upload := func(total, start, count int) {
		t.Helper()
		must("UPDATE native_user_route_budget SET next_at=now(),cooldown_until=now() WHERE session_hash=$1", fixtureSession.Hash)
		d, err := s.claimUserRoute(ctx, library, run, userRouteClaim{newUUID(), status().Revision}, fixtureSession)
		if err != nil {
			t.Fatal("seed claim", err)
		}
		_, err = s.submitUserRoute(ctx, library, run, userRouteUpload{AttemptID: d.AttemptID, Body: syntheticCaptureXML(total, start, count)}, fixtureSession)
		if err != nil {
			t.Fatal("seed upload", err)
		}
	}
	upload(20000, 920000001, 1000)
	t.Log("SYNTHETIC large fixture initial membership saved")
	action("cancel")
	action("capture")
	upload(20000, 920000001, 10000)
	action("capture")
	upload(10000, 920000001, 10000)
	action("capture")
	upload(10000, 920010001, 10000)
	if v := status(); v.WindowCount != 20000 || v.Capture.State != "complete" {
		t.Fatal("large fixture membership incomplete")
	}
	t.Log("SYNTHETIC large fixture captured 20000 IDs; seeding independent metadata")
	must(`INSERT INTO ld_records(library_id,search_id,metadata,title)
SELECT $1,'LD-'||md5('SYNTHETIC-CAPTURE-'||n),jsonb_build_object('SearchId','LD-'||md5('SYNTHETIC-CAPTURE-'||n),'Pmid',(920000000+n)::text,'Title','SYNTHETIC ONLY 中文 record '||n,'Authors','王; Fixture','Year','2026','Doi','10.0000/synthetic-'||n,'Pmcid','PMC'||(920000000+n))::text,'SYNTHETIC ONLY record '||n
FROM generate_series(1,20000) n`, library)
	must(`INSERT INTO ld_identifiers(library_id,kind,value,search_id) SELECT library_id,'pmid',metadata::jsonb->>'Pmid',search_id FROM ld_records WHERE library_id=$1`, library)
	// 此 fixture 的識別碼規則固定；直接建立關聯，避免全新資料表在
	// 尚未收集統計時以龐大的迴圈連接準備資料。實際匯出仍核對 PMID/排序。
	must(`INSERT INTO ld_results SELECT $1,$2,'LD-'||md5('SYNTHETIC-CAPTURE-'||n),n FROM generate_series(1,20000) n`, library, run)
	must("ANALYZE ld_records; ANALYZE ld_identifiers; ANALYZE ld_results; ANALYZE native_query_capture_members")
	must("UPDATE native_search_windows SET next_offset=20000,missing='[]',state='exhausted',revision=revision+1 WHERE library_id=$1 AND run_id=$2", library, run)
	must("UPDATE ld_runs SET fetched=20000,state='complete' WHERE library_id=$1 AND run_id=$2", library, run)
	return map[string]any{"library": library, "run": run, "count": 20000, "scope": "SYNTHETIC ONLY seeded metadata; real capture transitions; zero source network"}
}
