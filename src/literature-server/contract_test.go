package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestIdentityV3DotNetGolden(t *testing.T) {
	b, e := os.ReadFile("testdata/identity-v3.json")
	if e != nil {
		t.Fatal(e)
	}
	var vectors []struct{ Password, Hash string }
	if json.Unmarshal(b, &vectors) != nil || len(vectors) != 2 {
		t.Fatal("missing actual .NET vectors")
	}
	for _, v := range vectors {
		if !verifyPassword(v.Hash, v.Password) || verifyPassword(v.Hash, v.Password+"wrong") {
			t.Fatal("Identity compatibility")
		}
		raw, _ := base64.StdEncoding.DecodeString(v.Hash)
		for _, i := range []int{0, 1, 5, 9, len(raw) - 1} {
			bad := bytes.Clone(raw)
			bad[i] ^= 255
			if verifyPassword(base64.StdEncoding.EncodeToString(bad), v.Password) {
				t.Fatal("modified hash accepted")
			}
		}
	}
	for _, hash := range []string{"", "not-base64", base64.StdEncoding.EncodeToString(make([]byte, 512))} {
		if verifyPassword(hash, "synthetic") {
			t.Fatal("malformed hash")
		}
	}
	if digest("synthetic") != "B3CC0475BB78A5026098858E9889ACF666D31062D513D303314ECA31D36E72F2" {
		t.Fatal("digest contract")
	}
}

func TestMetadataTransportBounds(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "::ffff:127.0.0.1", "2001:db8::1", "64:ff9b::7f00:1"} {
		if publicSourceIP(net.ParseIP(ip)) {
			t.Fatal("unsafe source target", ip)
		}
	}
	if !publicSourceIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("public positive control")
	}
	if providerClient().CheckRedirect(&http.Request{}, nil) != http.ErrUseLastResponse {
		t.Fatal("redirect followed")
	}
	for _, x := range []struct {
		content, encoding, body string
		length                  int64
	}{
		{"text/html", "", "<html/>", 7}, {"application/xml", "br", "x", 1}, {"application/xml", "gzip", "bad", 3}, {"application/xml", "", "", sourceLimit + 1},
	} {
		response := &http.Response{Header: http.Header{"Content-Type": {x.content}, "Content-Encoding": {x.encoding}}, Body: io.NopCloser(strings.NewReader(x.body)), ContentLength: x.length}
		if _, e := readMetadataBody(response); e == nil {
			t.Fatal("invalid response accepted")
		}
	}
	response := &http.Response{Header: http.Header{"Content-Type": {"application/xml"}}, Body: io.NopCloser(strings.NewReader("<eSearchResult/>"))}
	if b, e := readMetadataBody(response); e != nil || string(b) != "<eSearchResult/>" {
		t.Fatal("valid response changed")
	}
}
func TestMetadataExistingDotNetGolden(t *testing.T) {
	b, e := os.ReadFile("testdata/synthetic-pubmed.xml")
	if e != nil {
		t.Fatal(e)
	}
	got, e := parsePubMed(b)
	if e != nil {
		t.Fatal(e)
	}
	b, e = os.ReadFile("testdata/metadata-golden.json")
	if e != nil {
		t.Fatal(e)
	}
	var want []map[string]any
	if json.Unmarshal(b, &want) != nil {
		t.Fatal("golden")
	}
	if len(got) != len(want) {
		t.Fatal("record count")
	}
	for i, w := range want {
		for k, v := range w {
			if k == "RetrievedAt" || k == "RawXml" || k == "SearchId" {
				continue
			}
			if got[i][k] != v {
				t.Errorf("record%d %s got %v want %v", i, k, got[i][k], v)
			}
		}
		if !strings.Contains(got[i]["RawXml"].(string), "<PubmedArticle>") {
			t.Fatal("raw record lost")
		}
	}
}
func TestMalformedSourceIsNotCompletion(t *testing.T) {
	if n, e := parseXML([]byte(`<?xml version="1.0"?><!DOCTYPE eSearchResult PUBLIC "-//NLM//DTD esearch 20060628//EN" "https://example.invalid/never-fetch.dtd"><eSearchResult><Count>0</Count><IdList/></eSearchResult>`)); e != nil || n.Name != "eSearchResult" {
		t.Fatal("ESearch document declaration", e)
	}
	if _, e := parseXML([]byte(`<!DOCTYPE eSearchResult><PubmedArticleSet/>`)); e == nil {
		t.Fatal("declared root mismatch accepted")
	}
	samples := []string{"", "<PubmedArticleSet>", "<PubmedArticleSet/><extra/>", "text<PubmedArticleSet/>", "<wrong/>", "<PubmedArticleSet><PubmedBookArticle/></PubmedArticleSet>", "<PubmedArticleSet><PubmedArticle/></PubmedArticleSet>", "<!DOCTYPE PubmedArticleSet [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><PubmedArticleSet>&x;</PubmedArticleSet>", strings.Repeat("<n>", 33) + strings.Repeat("</n>", 33)}
	for _, x := range samples {
		if _, e := parsePubMed([]byte(x)); e == nil {
			t.Fatalf("accepted malformed input %q", x)
		}
	}
}
func TestRequestBodyAndStaticSecurity(t *testing.T) {
	for _, body := range []string{`{"Login":"a","extra":1}`, `{} {}`, `{`, strings.Repeat("x", 17000)} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		w := httptest.NewRecorder()
		var v struct{ Login string }
		if decode(w, r, &v) || w.Code != 400 {
			t.Fatal("body admitted")
		}
	}
	s := &server{cfg: config{Origin: "http://example.com"}}
	for _, path := range []string{"/", "/app.js", "/app.css"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || w.Header().Get("Content-Security-Policy") == "" {
			t.Fatal(path)
		}
	}
	if strings.Contains(script, "createElement('style')") || !strings.Contains(page, "/app.css") {
		t.Fatal("CSP stylesheet regression")
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "http://wrong.invalid/service-info", nil)
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("wrong host admitted")
	}
}
