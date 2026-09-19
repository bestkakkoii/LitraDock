package main

// This test-only entry compiles the production handlers/worker with a closed
// synthetic transport. It cannot be selected by the shipped server binary.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestBrowserServer(t *testing.T) {
	if os.Getenv("LITRADOCK_BROWSER_TEST") != "yes" {
		t.Skip("Explicit isolated browser server not requested")
	}
	var cfg config
	b, err := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if err != nil || json.Unmarshal(b, &cfg) != nil {
		t.Fatal("browser configuration required")
	}
	pc, err := pgxpool.ParseConfig(cfg.Database)
	if err != nil || !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_test_browser_") {
		t.Fatal("dedicated browser test database required")
	}
	// Match production pool capacity: two HTTP admission connections plus worker and transaction connections.
	pc.MaxConns = 8
	revision := os.Getenv("NATIVE_BROWSER_REVISION")
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(revision) {
		t.Fatal("exact source revision required")
	}
	manifestPath := os.Getenv("NATIVE_BROWSER_MANIFEST")
	var manifest struct {
		Revision string            `json:"source_revision"`
		Files    map[string]string `json:"files"`
	}
	b, err = os.ReadFile(manifestPath)
	if err != nil || json.Unmarshal(b, &manifest) != nil || manifest.Revision != revision || len(manifest.Files) < 3 {
		t.Fatal("matching runtime manifest required")
	}
	assets := 0
	for name, want := range manifest.Files {
		if !strings.HasPrefix(name, "web/") {
			continue
		}
		rel := strings.TrimPrefix(name, "web/")
		if !filepath.IsLocal(rel) {
			t.Fatal("unsafe manifest path")
		}
		b, err = os.ReadFile(filepath.Join(cfg.FrontendDirectory, filepath.FromSlash(rel)))
		sum := sha256.Sum256(b)
		if err != nil || hex.EncodeToString(sum[:]) != want {
			t.Fatal("compiled assets do not match manifest")
		}
		assets++
	}
	if assets < 3 {
		t.Fatal("compiled application assets required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	db, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if db.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&count) != nil || count != 0 {
		t.Fatal("fresh empty test database required; nothing deleted")
	}
	if _, err = db.Exec(ctx, nativeSchema); err != nil {
		t.Fatal(err)
	}
	bundles := os.Getenv("LITRADOCK_BUNDLE_BROWSER_TEST") == "yes"
	continuation := os.Getenv("LITRADOCK_CONTINUATION_BROWSER_TEST") == "yes" || bundles
	multirun := os.Getenv("LITRADOCK_MULTIRUN_BROWSER_TEST") == "yes" || continuation
	// All compiled clients use the current persistence capability. Feature flags
	// still bound each browser workload; migrations do not enable source traffic.
	{
		tx, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err = migrateMultirun(ctx, tx, false); err != nil {
			tx.Rollback(ctx)
			t.Fatal(err)
		}
		for _, migrate := range []func(context.Context, pgx.Tx, bool) error{migrateContinuation, migrateBundles, migrateSavedSnapshots, migrateRunSelection} {
			if err = migrate(ctx, tx, false); err != nil {
				tx.Rollback(ctx)
				t.Fatal(err)
			}
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	accounts := []map[string]string{}
	for _, label := range []string{"a", "b"} {
		password := "SYNTHETIC-" + newUUID()
		hash, err := nativeHash(password)
		if err != nil {
			t.Fatal(err)
		}
		login := "synthetic-browser-" + label
		if _, err = db.Exec(ctx, "INSERT INTO ld_accounts VALUES($1,$2,$3,true)", newUUID(), login, hash); err != nil {
			t.Fatal(err)
		}
		accounts = append(accounts, map[string]string{"login": login, "password": password})
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cfg.Listen = listener.Addr().String()
	cfg.Origin = "http://" + cfg.Listen
	cfg.LocalTest, cfg.SearchEnabled, cfg.AcquisitionEnabled = true, true, true
	cfg.PlanEnabled = os.Getenv("LITRADOCK_PLAN_BROWSER_TEST") == "yes" || multirun
	cfg.SavedSetEnabled = multirun
	cfg.SearchContinuationEnabled = continuation
	cfg.BundleDeliveryEnabled = bundles
	cfg.SelectionWriteEnabled = true
	if bundles {
		cfg.PDFEnabled = true
	}
	if cfg.PlanEnabled {
		for i := 3; i <= 100; i++ {
			cfg.BlockedPMCIDs = append(cfg.BlockedPMCIDs, fmt.Sprintf("PMC990002%03d", i))
		}
	}
	cfg.Revision = "https://github.com/bestkakkoii/LitraDock/tree/" + revision
	cfg.Operator, cfg.Contact, cfg.Retention = "SYNTHETIC isolated browser qualification", "No external contact", "Disposable test data only"
	cfg.Expires = time.Now().Add(time.Hour)
	cfg.BlockedPMCIDs = append(cfg.BlockedPMCIDs, "PMC990000003")
	for i := 1; i <= 12; i++ {
		cfg.BlockedPMCIDs = append(cfg.BlockedPMCIDs, fmt.Sprintf("PMC990001%03d", i))
	}
	originals := []map[string]any{}
	for _, id := range []string{"990000001", "990000002"} {
		body := strings.ReplaceAll(strings.ReplaceAll(syntheticOAI(), "990000001", id), "10.0000/synthetic", "10.0000/synthetic"+id)
		sum := sha256.Sum256([]byte(body))
		originals = append(originals, map[string]any{"pmid": id, "sha256": hex.EncodeToString(sum[:]), "bytes": len([]byte(body))})
	}
	planRateLimited := false
	transport := nativeTransport(func(r *http.Request) (*http.Response, error) {
		if continuation {
			f, e := os.OpenFile(os.Getenv("NATIVE_BROWSER_INPUT")+".source-requests", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if e != nil {
				return nil, e
			}
			entry, _ := json.Marshal(map[string]string{"path": r.URL.Path, "ids": r.URL.Query().Get("id"), "query": r.URL.Query().Get("term")})
			_, e = f.Write(append(entry, '\n'))
			f.Close()
			if e != nil {
				return nil, e
			}
		}
		if continuation && strings.HasSuffix(r.URL.Path, "/efetch.fcgi") && r.URL.Query().Get("id") != "" && strings.Split(r.URL.Query().Get("id"), ",")[0] == "990000101" {
			base := os.Getenv("NATIVE_BROWSER_INPUT")
			if _, e := os.Stat(base + ".metadata-hold"); e == nil {
				if e = os.WriteFile(base+".metadata-entered", []byte("synthetic response held"), 0600); e != nil {
					return nil, e
				}
				for {
					if _, e = os.Stat(base + ".metadata-release"); e == nil {
						break
					}
					select {
					case <-r.Context().Done():
						return nil, r.Context().Err()
					case <-time.After(50 * time.Millisecond):
					}
				}
			}
		}
		if cfg.PlanEnabled && r.URL.Host == "pmc.ncbi.nlm.nih.gov" {
			for {
				if _, err := os.Stat(os.Getenv("NATIVE_BROWSER_INPUT") + ".source-release"); err == nil {
					break
				}
				select {
				case <-r.Context().Done():
					return nil, r.Context().Err()
				case <-time.After(50 * time.Millisecond):
				}
			}
		}

		select {
		case <-time.After(450 * time.Millisecond):
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
		status, body := 200, ""
		switch {
		case r.URL.Host == "eutils.ncbi.nlm.nih.gov" && strings.HasSuffix(r.URL.Path, "/esearch.fcgi"):
			if strings.Contains(r.URL.Query().Get("term"), "SYNTHETIC_ERROR") {
				status = 403
				body = "SYNTHETIC provider access denied"
			} else {
				body = `<eSearchResult><Count>25000</Count><IdList><Id>990000001</Id><Id>990000002</Id><Id>990000003</Id></IdList><QueryTranslation>SYNTHETIC transport only</QueryTranslation></eSearchResult>`
				for _, total := range []string{"1000", "10000", "25001"} {
					if r.URL.Query().Get("term") == "SYNTHETIC_PAGES_"+total {
						body = `<eSearchResult><Count>` + total + `</Count><IdList>`
						for i := 1; i <= 12; i++ {
							body += fmt.Sprintf("<Id>990001%03d</Id>", i)
						}
						body += `</IdList><QueryTranslation>SYNTHETIC pagination only</QueryTranslation></eSearchResult>`
					}
				}
			}
			if cfg.PlanEnabled && r.URL.Query().Get("term") == "SYNTHETIC_PLAN_25001" {
				body = `<eSearchResult><Count>25001</Count><IdList><Id>990000001</Id><Id>990000002</Id>`
				for i := 3; i <= 100; i++ {
					body += fmt.Sprintf("<Id>990002%03d</Id>", i)
				}
				body += `</IdList><QueryTranslation>SYNTHETIC plan transport only</QueryTranslation></eSearchResult>`
			}
			if multirun && r.URL.Query().Get("term") == "SYNTHETIC_SECOND_RUN" {
				body = `<eSearchResult><Count>10001</Count><IdList><Id>990000002</Id><Id>990000003</Id></IdList><QueryTranslation>SYNTHETIC second query</QueryTranslation></eSearchResult>`
			}
			if continuation && r.URL.Query().Get("term") == "SYNTHETIC_CONTINUATION_25000" {
				body = `<eSearchResult><Count>25000</Count><IdList>`
				for i := 1; i <= 1000; i++ {
					body += fmt.Sprintf("<Id>990%06d</Id>", i)
				}
				body += `</IdList><QueryTranslation>SYNTHETIC frozen membership only</QueryTranslation></eSearchResult>`
			}
		case r.URL.Host == "eutils.ncbi.nlm.nih.gov" && strings.HasSuffix(r.URL.Path, "/efetch.fcgi"):
			body = `<PubmedArticleSet>`
			for _, id := range strings.Split(r.URL.Query().Get("id"), ",") {
				if !regexp.MustCompile(`^99000[012][0-9]{3}$`).MatchString(id) {
					return nil, fmt.Errorf("unexpected synthetic metadata ID")
				}
				body += fmt.Sprintf(`<PubmedArticle><MedlineCitation><PMID>%s</PMID><Article><Journal><Title>SYNTHETIC Journal</Title><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal><ArticleTitle>SYNTHETIC ONLY α 中文 %s</ArticleTitle><Abstract><AbstractText>Isolated transport, never a live result.</AbstractText></Abstract></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.0000/synthetic%s</ArticleId><ArticleId IdType="pmc">PMC%s</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`, id, id, id, id)
			}
			body += `</PubmedArticleSet>`
		case r.URL.Host == "pmc.ncbi.nlm.nih.gov" && r.URL.Path == "/api/oai/v1/mh/":
			id := strings.TrimPrefix(r.URL.Query().Get("identifier"), "oai:pubmedcentral.nih.gov:")
			if id != "990000001" && id != "990000002" {
				return nil, fmt.Errorf("unexpected synthetic original target")
			}
			body = strings.ReplaceAll(strings.ReplaceAll(syntheticOAI(), "990000001", id), "10.0000/synthetic", "10.0000/synthetic"+id)
			if cfg.PlanEnabled && !multirun && id == "990000002" && !planRateLimited {
				planRateLimited = true
				return &http.Response{StatusCode: 429, Header: http.Header{"Content-Type": {"application/xml"}, "Retry-After": {"2"}}, Body: io.NopCloser(strings.NewReader("SYNTHETIC cooldown"))}, nil
			}

		default:
			return nil, fmt.Errorf("closed synthetic transport: network forbidden")
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/xml"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	s := &server{native: true, db: db, cfg: cfg, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	s.continuation = continuation
	s.bundles = bundles
	s.savedSnapshots = true
	s.runSelection = true
	service := &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second}
	defer service.Close()
	go s.worker(ctx)
	go service.Serve(listener)
	input := map[string]any{"origin": cfg.Origin, "accounts": accounts, "source_revision": revision, "manifest": manifestPath, "originals": originals, "source_gate": os.Getenv("NATIVE_BROWSER_INPUT") + ".source-release", "scope": "SYNTHETIC ONLY; actual native handlers/PostgreSQL; no external transport"}
	if bundles {
		input["bundle_seed"] = seedBundleBrowser(t, ctx, db, accounts[0]["login"])
	}
	b, _ = json.MarshalIndent(input, "", "  ")
	output := os.Getenv("NATIVE_BROWSER_INPUT")
	f, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal("new protected browser input path required")
	}
	if _, err = f.Write(b); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()
	t.Log("Synthetic browser server ready; protected input written; no external network")
	for {
		select {
		case <-ctx.Done():
			t.Fatal("bounded browser server expired")
		case <-time.After(200 * time.Millisecond):
			if _, err = os.Stat(output + ".stop"); err == nil {
				return
			}
		}
	}
}
