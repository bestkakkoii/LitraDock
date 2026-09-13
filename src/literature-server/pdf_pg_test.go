package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPDFActualPostgres(t *testing.T) {
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
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
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
	account, library, foreign, run := newUUID(), newUUID(), newUUID(), newID("RUN-")
	must("INSERT INTO ld_accounts VALUES($1,$2,'synthetic-unused',true)", account, "synthetic-pdf-"+account)
	must("INSERT INTO ld_libraries VALUES($1,$2,'SYNTHETIC PDF A',true),($3,$2,'SYNTHETIC PDF B',true)", library, account, foreign)
	defer func() {
		for _, table := range []string{"native_plan_commands", "native_plan_items", "native_items", "native_batches", "native_plans", "native_originals", "ld_results", "ld_jobs", "ld_runs", "ld_identifiers", "ld_records"} {
			must("DELETE FROM "+table+" WHERE library_id=$1", library)
		}
		must("DELETE FROM ld_libraries WHERE owner_id=$1", account)
		must("DELETE FROM ld_accounts WHERE account_id=$1", account)
	}()
	must("INSERT INTO ld_runs(library_id,run_id,input,total,fetched,requested_limit,state) VALUES($1,$2,'SYNTHETIC ONLY',25001,12,12,'complete')", library, run)
	ids := []string{}
	for n := 0; n < 12; n++ {
		a := syntheticArticle()
		id := newID("LD-")
		ids = append(ids, id)
		a["SearchId"] = id
		if n > 1 {
			a["Pmcid"] = ""
		}
		if n == 1 {
			a["Pmid"] = "990000002"
			a["Pmcid"] = "PMC990000002"
			a["Doi"] = "10.0000/synthetic-two"
		}
		b, _ := json.Marshal(a)
		must("INSERT INTO ld_records VALUES($1,$2,$3,'SYNTHETIC ONLY')", library, id, string(b))
		must("INSERT INTO ld_results VALUES($1,$2,$3,$4)", library, run, id, n+1)
	}
	cfg.PDFEnabled = true
	cfg.PlanEnabled = true
	cfg.AcquisitionEnabled = true
	s := &server{db: db, cfg: cfg, native: true}
	var calls atomic.Int32
	var block atomic.Bool
	entered, release := make(chan struct{}, 1), make(chan struct{})
	transport := nativeTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if block.Load() {
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		}
		a := syntheticArticle()
		label := "one"
		if strings.Contains(r.URL.String(), "990000002") {
			a["Pmid"] = "990000002"
			a["Pmcid"] = "PMC990000002"
			a["Doi"] = "10.0000/synthetic-two"
			label = "two"
		}
		b := syntheticPDF(label)
		p := syntheticPDFProof(t, b, a)
		var data []byte
		switch {
		case r.URL.Path == "/":
			data = p.Listing
		case strings.HasSuffix(r.URL.Path, ".json"):
			data = p.Metadata
		case strings.HasSuffix(r.URL.Path, ".xml"):
			data = p.JATS
		case strings.HasSuffix(r.URL.Path, ".pdf"):
			data = b
		default:
			t.Error("unexpected endpoint", r.URL.Path)
		}
		// Avoid wall-clock sleep in isolated transport; production request still performs all budget writes.
		must("UPDATE ld_source_budget SET next_at=now() WHERE name='ncbi'")
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"binary/octet-stream"}}, ContentLength: int64(len(data)), Body: io.NopCloser(bytes.NewReader(data))}, nil
	})
	s.provider = &http.Client{Transport: nativeTransport(func(r *http.Request) (*http.Response, error) {
		resp, e := transport.RoundTrip(r)
		if resp != nil && r.URL.Path == "/" {
			resp.Header.Set("Content-Type", "application/xml")
		}
		return resp, e
	})}
	t.Run("empty-format-migration-preserves-data", func(t *testing.T) {
		tx, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx)
		if e = migratePDF(ctx, tx, true); e != nil {
			t.Fatal(e)
		}
		if e = migratePDF(ctx, tx, false); e != nil {
			t.Fatal(e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
	})
	t.Run("admission-format-idempotency-concurrency", func(t *testing.T) {
		req := newUUID()
		var wg sync.WaitGroup
		got := make(chan string, 2)
		for n := 0; n < 2; n++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				id, e := s.queueBatch(ctx, library, req, ids[:3], "pdf")
				if e != nil {
					t.Error(e)
				}
				got <- id
			}()
		}
		wg.Wait()
		close(got)
		first := ""
		for id := range got {
			if first != "" && first != id {
				t.Fatal("duplicate batch")
			}
			first = id
		}
		if _, e = s.queueBatch(ctx, library, req, ids[:3], "xml"); e == nil {
			t.Fatal("altered format replay")
		}
		if _, e = s.queueBatch(ctx, foreign, newUUID(), ids[:3], "pdf"); e == nil {
			t.Fatal("foreign selection")
		}
		for _, f := range []string{"PDF", "../pdf", "html"} {
			if _, e = s.queueBatch(ctx, library, newUUID(), ids[:1], f); e == nil {
				t.Fatal("malformed format")
			}
		}
		for n := 0; n < 3; n++ {
			s.batchOne(ctx)
		}
		d, e := s.batchDetail(ctx, library, first)
		if e != nil {
			t.Fatal(e)
		}
		detail := d.(map[string]any)
		if detail["requestedFormat"] != "pdf" {
			t.Fatal("format receipt")
		}
		counts := detail["counts"].(map[string]int)
		if counts["acquired"] != 2 || counts["unavailable"] != 1 {
			t.Fatal("mixed progress", counts)
		}
		if calls.Load() != 8 {
			t.Fatal("bounded cold transport calls", calls.Load())
		}
		zipBytes, e := s.exportBundle(ctx, library, first)
		if e != nil {
			t.Fatal(e)
		}
		z, e := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
		if e != nil {
			t.Fatal(e)
		}
		distinct := map[string]bool{}
		for _, f := range z.File {
			if f.Name == "manifest.json" {
				r, _ := f.Open()
				b, _ := io.ReadAll(r)
				r.Close()
				var manifest map[string]any
				if json.Unmarshal(b, &manifest) != nil || manifest["policy"] != pdfPolicy {
					t.Fatal("incorrect PDF source policy envelope")
				}
			}
			if strings.HasSuffix(f.Name, ".pdf") {
				r, _ := f.Open()
				b, e := io.ReadAll(r)
				r.Close()
				if e != nil {
					t.Fatal(e)
				}
				distinct[string(b)] = true
			}
		}
		if len(distinct) != 2 || !distinct[string(syntheticPDF("one"))] || !distinct[string(syntheticPDF("two"))] {
			t.Fatal("ZIP changed or duplicated original bytes")
		}
		rows := detail["items"].([]map[string]any)
		for _, row := range rows {
			if row["downloadAvailable"] == true {
				hash := row["original_hash"].(string)
				if _, _, e = s.original(ctx, foreign, row["search_id"].(string), hash); e == nil {
					t.Fatal("foreign original")
				}
			}
		}
		before := calls.Load()
		if _, e = s.exportCSV(ctx, library, "", first); e != nil {
			t.Fatal(e)
		}
		if _, e = s.exportXLSX(ctx, library, "", first); e != nil {
			t.Fatal(e)
		}
		if calls.Load() != before {
			t.Fatal("hidden export acquisition")
		}
	})
	t.Run("XML-PDF-coexistence-and-cached-plan", func(t *testing.T) {
		a := syntheticArticle()
		xml := []byte(syntheticOAI())
		info, e := validateOriginal(xml, a)
		if e != nil {
			t.Fatal(e)
		}
		must("INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", library, ids[0], info.Hash, xml, info.Source, info.Rights, info.Stamp, acquisitionPolicy)
		req := newUUID()
		p, e := s.queuePlan(ctx, library, req, run, ids, "pdf")
		if e != nil {
			t.Fatal(e)
		}
		if _, e = s.queuePlan(ctx, library, req, run, ids, "xml"); e == nil {
			t.Fatal("plan altered format")
		}
		before := calls.Load()
		for n := 0; n < 12; n++ {
			s.batchOne(ctx)
		}
		if calls.Load() != before {
			t.Fatal("cached or no-PMC plan made hidden source requests")
		}
		d, e := s.planDetail(ctx, library, p.PlanID, 0, 100)
		if e != nil {
			t.Fatal(e)
		}
		plan := d.(map[string]any)["plan"].(planSummary)
		if plan.RequestedFormat != "pdf" || plan.Counts["completed"] != 2 || plan.Counts["held"] != 10 || plan.SelectedCount != 12 {
			t.Fatal("plan counts", plan)
		}
		b, i, e := s.original(ctx, library, ids[0], info.Hash)
		if e != nil || !bytes.Equal(b, xml) || i.Format != "XML" {
			t.Fatal("existing XML changed", e)
		}
		tx, _ := db.Begin(ctx)
		if e = migratePDF(ctx, tx, true); e == nil {
			t.Fatal("occupied schema downgrade")
		}
		tx.Rollback(ctx)
	})
	t.Run("cancel-fences-inflight-and-disabled-policy", func(t *testing.T) {
		// Remove only test PDF cache to force a new leased request; retained XML remains untouched.
		must("DELETE FROM native_originals WHERE library_id=$1 AND format='pdf'", library)
		id, e := s.queueBatch(ctx, library, newUUID(), ids[:1], "pdf")
		if e != nil {
			t.Fatal(e)
		}
		block.Store(true)
		done := make(chan struct{})
		go func() { s.batchOne(ctx); close(done) }()
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("no in-flight source")
		}
		if e = s.controlBatch(ctx, library, id, "cancel"); e != nil {
			t.Fatal(e)
		}
		block.Store(false)
		close(release)
		<-done
		var n int
		db.QueryRow(ctx, "SELECT count(*) FROM native_originals WHERE library_id=$1 AND format='pdf'", library).Scan(&n)
		if n != 0 {
			t.Fatal("cancelled bytes committed")
		}
		s.cfg.PDFEnabled = false
		if _, e = s.queueBatch(ctx, library, newUUID(), ids[:1], "pdf"); e == nil {
			t.Fatal("disabled PDF admission")
		}
	})
	t.Run("proof-inclusive-near-capacity-no-partial-save", func(t *testing.T) {
		s.cfg.PDFEnabled = true
		var retained int64
		if e := db.QueryRow(ctx, "SELECT COALESCE(sum(octet_length(content)+octet_length(proof)),0) FROM native_originals").Scan(&retained); e != nil {
			t.Fatal(e)
		}
		// Labeled synthetic compressed filler only in the disposable database. PDF bytes fit,
		// but their retained rights proof does not; ignoring proof would wrongly admit them.
		missing := int64(256*1024*1024-1024) - retained
		if missing <= 0 {
			t.Fatal("unexpected test storage")
		}
		must(`INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy,proof)
   SELECT $1,$2,'SYNTHETIC-FILLER-'||n,''::bytea,'','','','synthetic capacity only',convert_to(repeat('x',LEAST(1048576,$3::bigint-(n-1)*1048576)::int),'UTF8') FROM generate_series(1,($3::bigint+1048575)/1048576) n`, library, ids[0], missing)
		defer must("DELETE FROM native_originals WHERE library_id=$1 AND hash LIKE 'SYNTHETIC-FILLER-%'", library)
		batch, e := s.queueBatch(ctx, library, newUUID(), ids[:1], "pdf")
		if e != nil {
			t.Fatal(e)
		}
		s.batchOne(ctx)
		var state, reason string
		var originals int
		if e = db.QueryRow(ctx, "SELECT state,reason FROM native_items WHERE library_id=$1 AND batch_id=$2", library, batch).Scan(&state, &reason); e != nil {
			t.Fatal(e)
		}
		db.QueryRow(ctx, "SELECT count(*) FROM native_originals WHERE library_id=$1 AND format='pdf'", library).Scan(&originals)
		if state != "failed" || !strings.Contains(reason, "storage capacity") || originals != 0 {
			t.Fatal("proof storage gate failed", state, reason, originals)
		}
	})

}
