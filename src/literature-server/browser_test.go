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
	cfg.Revision = "https://github.com/bestkakkoii/LitraDock/tree/" + revision
	cfg.Operator, cfg.Contact, cfg.Retention = "SYNTHETIC isolated browser qualification", "No external contact", "Disposable test data only"
	cfg.Expires = time.Now().Add(time.Hour)
	cfg.BlockedPMCIDs = []string{"PMC990000003"}
	for i := 1; i <= 12; i++ {
		cfg.BlockedPMCIDs = append(cfg.BlockedPMCIDs, fmt.Sprintf("PMC990001%03d", i))
	}
	originals := []map[string]any{}
	for _, id := range []string{"990000001", "990000002"} {
		body := strings.ReplaceAll(strings.ReplaceAll(syntheticOAI(), "990000001", id), "10.0000/synthetic", "10.0000/synthetic"+id)
		sum := sha256.Sum256([]byte(body))
		originals = append(originals, map[string]any{"pmid": id, "sha256": hex.EncodeToString(sum[:]), "bytes": len([]byte(body))})
	}
	transport := nativeTransport(func(r *http.Request) (*http.Response, error) {
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
		case r.URL.Host == "eutils.ncbi.nlm.nih.gov" && strings.HasSuffix(r.URL.Path, "/efetch.fcgi"):
			body = `<PubmedArticleSet>`
			for _, id := range strings.Split(r.URL.Query().Get("id"), ",") {
				if !regexp.MustCompile(`^99000[01][0-9]{3}$`).MatchString(id) {
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
		default:
			return nil, fmt.Errorf("closed synthetic transport: network forbidden")
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/xml"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	s := &server{native: true, db: db, cfg: cfg, slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1), provider: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	service := &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second}
	defer service.Close()
	go s.worker(ctx)
	go service.Serve(listener)
	input := map[string]any{"origin": cfg.Origin, "accounts": accounts, "source_revision": revision, "manifest": manifestPath, "originals": originals, "scope": "SYNTHETIC ONLY; actual native handlers/PostgreSQL; no external transport"}
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
