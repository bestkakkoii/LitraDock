package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestUserRouteSourceBoundary(t *testing.T) {
	s := &server{cfg: config{UserRouteEnabled: true}}
	for _, path := range []string{"esearch.fcgi", "efetch.fcgi"} {
		if _, e := s.request(context.Background(), path, url.Values{}); e == nil || !strings.Contains(e.Error(), "server fallback") {
			t.Fatal("server PubMed request not refused before database/network", path, e)
		}
	}
	s.cfg.Origin = "http://127.0.0.1:8080"
	s.userRoute = true
	r := httptest.NewRequest("GET", s.cfg.Origin+"/service-info", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	csp := w.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "connect-src 'self' https://eutils.ncbi.nlm.nih.gov") || !strings.Contains(csp, "frame-ancestors 'none'") || strings.Contains(csp, "connect-src *") {
		t.Fatal("invalid direct source CSP", csp)
	}
	s.cfg.UserRouteEnabled = false
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if strings.Contains(w.Header().Get("Content-Security-Policy"), "eutils") {
		t.Fatal("disabled source CSP widened")
	}
}

func syntheticUserRouteMetadata(t *testing.T) []byte {
	t.Helper()
	body, e := os.ReadFile("testdata/synthetic-pubmed.xml")
	if e != nil {
		t.Fatal(e)
	}
	end := strings.Index(string(body), "</PubmedArticle>") + len("</PubmedArticle>")
	return append(append([]byte{}, body[:end]...), []byte("</PubmedArticleSet>")...)
}

func TestUserRouteMetadataUntrusted(t *testing.T) {
	body := syntheticUserRouteMetadata(t)
	h := sha256.Sum256(body)
	hash := hex.EncodeToString(h[:])
	attempt := newUUID()
	a, e := parseUserRouteMetadata(body, []string{"990000001"}, hash, attempt)
	if e != nil || len(a) != 1 {
		t.Fatal(e)
	}
	if articleString(a[0], "MetadataVerification") != userRouteVerification || articleString(a[0], "MetadataResponseSHA256") != hash || articleString(a[0], "MetadataExecution") != userRouteExecution {
		t.Fatal("missing client trust boundary")
	}
	if articleString(a[0], "RawXml") == "" || articleString(a[0], "Pmid") != "990000001" || articleString(a[0], "Doi") == "" {
		t.Fatal("raw metadata/identifiers lost")
	}
	for name, b := range map[string][]byte{
		"foreign":        []byte(strings.ReplaceAll(string(body), "990000001", "990000002")),
		"entity":         []byte(`<!DOCTYPE PubmedArticleSet [<!ENTITY x SYSTEM "file:///SYNTHETIC">]><PubmedArticleSet>&x;</PubmedArticleSet>`),
		"huge":           []byte(strings.Repeat("x", userRouteBodyLimit+1)),
		"bad-utf8":       {255, 254},
		"json-key-error": []byte(`{"error":"SYNTHETIC invalid key","api-key":"SYNTHETIC_SECRET"}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, e := parseUserRouteMetadata(b, []string{"990000001"}, hash, attempt); e == nil {
				t.Fatal("unsafe response accepted")
			}
		})
	}
	a[0]["SearchId"] = "LD-" + strings.Repeat("1", 32)
	raw, _ := json.Marshal(a[0])
	record, e := structuredArticle(a[0]["SearchId"].(string), string(raw))
	if e != nil || record.Provenance == nil || record.Provenance.Verification != userRouteVerification {
		t.Fatal("structured trust lost", e)
	}
	row := map[string]any{"metadata": string(raw), "run_ids": "RUN-" + strings.Repeat("2", 32), "batch_id": ""}
	csv, e := encodeRecordCSV(context.Background(), []map[string]any{row})
	if e != nil || !strings.Contains(string(csv), userRouteVerification) || !strings.Contains(string(csv), hash) {
		t.Fatal("CSV trust lost", e)
	}
	if _, e := encodeWorkbook(context.Background(), []map[string]any{row}, row["run_ids"].(string), ""); e != nil {
		t.Fatal("workbook provenance", e)
	}
	a[0]["MetadataVerification"] = "provider_verified"
	raw, _ = json.Marshal(a[0])
	if _, e := structuredArticle(a[0]["SearchId"].(string), string(raw)); e == nil {
		t.Fatal("forged verification silently exported")
	}
}

func TestUserRouteQueryAndFailures(t *testing.T) {
	for input, want := range map[string]string{" PMID: 31719837 ": "31719837[uid]", "https://doi.org/10.0000/SYNTHETIC": "\"10.0000/synthetic\"[AID]", "asthma[Title] AND 2020:2026[dp]": "asthma[Title] AND 2020:2026[dp]"} {
		if got := normalizedPubMedQuery(input); got != want {
			t.Fatalf("query changed: %q", got)
		}
	}
	for _, code := range []string{"rate_limited", "request_rejected", "network_unavailable", "provider_unavailable", "invalid_response", "cancelled", "interrupted"} {
		state, reason, _, ok := userRouteFailure(code)
		if !ok || state == "" || reason == "" {
			t.Fatal("missing explicit failure", code)
		}
	}
	if _, _, _, ok := userRouteFailure("SYNTHETIC_SECRET"); ok {
		t.Fatal("untrusted free-text reason admitted")
	}
}
