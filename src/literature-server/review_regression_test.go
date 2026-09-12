package main

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestReview014MetadataAndCredentialRegressions(t *testing.T) {
	b, e := os.ReadFile("testdata/synthetic-pubmed.xml")
	if e != nil {
		t.Fatal(e)
	}
	good := string(b)
	for _, x := range []string{
		strings.Replace(good, "<PMID>990000001</PMID>", "<PMID>990000001</PMID><PMID>990000099</PMID>", 1),
		strings.Replace(good, "</ArticleTitle>", "</ArticleTitle><ELocationID EIdType='doi'>10.5555/conflicting</ELocationID>", 1),
		strings.Replace(good, "<ArticleIdList>", "<ArticleIdList><ArticleId IdType='pubmed'>990000099</ArticleId>", 1),
		strings.Replace(good, "</ArticleTitle>", "</ArticleTitle><ArticleTitle>Conflicting title</ArticleTitle>", 1),
		strings.Replace(good, `<!DOCTYPE PubmedArticleSet SYSTEM "https://example.invalid/synthetic-never-fetch.dtd">`, `<!DOCTYPE PubmedArticleSet nonsense>`, 1),
		strings.Replace(good, "<ArticleIdList>", "<ArticleIdList><ArticleId IdType='doi'>10.0000/SYNTHETIC</ArticleId>", 1),
	} {
		if x == good {
			t.Fatal("ineffective control")
		}
		if _, e := parsePubMed([]byte(x)); e == nil {
			t.Fatal("ambiguous/malformed source accepted")
		}
	}
	corroborated := strings.Replace(good, "</ArticleTitle>", "</ArticleTitle><ELocationID EIdType='doi'>DOI: 10.0000/SYNTHETIC</ELocationID>", 1)
	corroborated = strings.Replace(corroborated, "<ArticleIdList>", "<ArticleIdList><ArticleId IdType='pubmed'>990000001</ArticleId>", 1)
	if _, e := parsePubMed([]byte(corroborated)); e != nil {
		t.Fatal("corroborated identities rejected", e)
	}
	for _, doi := range []string{"10.5555/plain", "10.5555/suffix#part", "10.5555/suffix?part", "10.5555/a+b%字"} {
		a := map[string]any{"Doi": doi}
		links(a)
		u, e := url.Parse(a["DoiUri"].(string))
		if e != nil {
			t.Fatal(e)
		}
		path, e := url.PathUnescape(strings.TrimPrefix(u.EscapedPath(), "/"))
		if e != nil || path != doi || u.RawQuery != "" || u.Fragment != "" {
			t.Fatal("DOI link lost identifier")
		}
	}
	for _, password := range []string{strings.Repeat("密", 257), string([]byte{255})} {
		_, sess, e := (&server{}).login(context.Background(), "synthetic", password)
		if e != nil || sess != nil {
			t.Fatal("native credential boundary")
		}
	}
	var vectors []struct{ Password, Hash string }
	b, _ = os.ReadFile("testdata/identity-v3.json")
	_ = json.Unmarshal(b, &vectors)
	for _, v := range vectors {
		if strings.Contains(v.Password, "é") && verifyPassword(v.Hash, strings.ReplaceAll(v.Password, "é", "e\u0301")) {
			t.Fatal("password normalized")
		}
	}
}

func TestPrivateRecordedSourceReplay(t *testing.T) {
	path := os.Getenv("LITRADOCK_GO_SOURCE_REPLAY")
	if os.Getenv("LITRADOCK_GO_INTEGRATION") != "yes" || path == "" {
		t.Skip("Private recorded genuine metadata unavailable; no provider request")
	}
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal("private replay absent")
	}
	var expected []map[string]any
	if json.Unmarshal(b, &expected) != nil || len(expected) != 3 {
		t.Fatal("private replay count")
	}
	var xml strings.Builder
	xml.WriteString("<PubmedArticleSet>")
	for _, a := range expected {
		xml.WriteString(a["RawXml"].(string))
	}
	xml.WriteString("</PubmedArticleSet>")
	got, e := parsePubMed([]byte(xml.String()))
	if e != nil || len(got) != len(expected) {
		t.Fatal("recorded genuine metadata rejected", e)
	}
	for i, a := range got {
		for _, k := range []string{"Pmid", "Pmcid", "Doi", "Title", "Authors", "Journal", "PublicationDate", "RawXml"} {
			if a[k] != expected[i][k] {
				t.Fatalf("recorded field mismatch %s", k)
			}
		}
	}
	t.Log("Three privately recorded genuine records replayed; identifiers, metadata and original record bytes retained; zero provider calls")
}

func TestReview015StructuralSelection(t *testing.T) {
	b, err := os.ReadFile("testdata/synthetic-pubmed.xml")
	if err != nil {
		t.Fatal(err)
	}
	good := string(b)
	baseline, err := parsePubMed(b)
	if err != nil {
		t.Fatal(err)
	}
	decoy := strings.Replace(good, "<PMID>990000001</PMID>", "<Wrapper><PMID>990000099</PMID></Wrapper><PMID>990000001</PMID>", 1)
	decoy = strings.Replace(decoy, "<ArticleTitle>", "<Wrapper><ArticleTitle>Wrong nested title</ArticleTitle></Wrapper><ArticleTitle>", 1)
	decoy = strings.Replace(decoy, "<Title>Synthetic Journal", "<Wrapper><Title>Wrong journal</Title></Wrapper><Title>Synthetic Journal", 1)
	got, err := parsePubMed([]byte(decoy))
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"Pmid", "Title", "Journal", "Authors", "Abstract", "PublicationDate"} {
		if got[0][k] != baseline[0][k] {
			t.Fatalf("nested decoy selected: %s", k)
		}
	}
	begin := strings.Index(decoy, "<PubmedArticle>")
	end := strings.Index(decoy, "</PubmedArticle>") + len("</PubmedArticle>")
	if got[0]["RawXml"] != decoy[begin:end] {
		t.Fatal("raw record bytes altered")
	}
	for _, xml := range []string{
		`<eSearchResult><Count>100</Count><IdList><Id>1</Id></IdList><QueryTranslation>direct query</QueryTranslation></eSearchResult>`,
		`<eSearchResult><Wrapper><Count>1</Count><QueryTranslation>wrong</QueryTranslation></Wrapper><Count>100</Count><IdList><Id>1</Id></IdList><QueryTranslation>direct query</QueryTranslation></eSearchResult>`,
	} {
		total, ids, translation, err := parseSearchMetadata([]byte(xml), 10)
		if err != nil || total != 100 || len(ids) != 1 || ids[0] != "1" || translation != "direct query" {
			t.Fatal("search structural selection", total, translation, err)
		}
	}
	for _, xml := range []string{
		`<eSearchResult><Wrapper><Count>100</Count></Wrapper><IdList/></eSearchResult>`,
		`<eSearchResult><Count>100</Count><Count>1</Count><IdList/></eSearchResult>`,
		`<eSearchResult><Count><Count>1</Count></Count><IdList/></eSearchResult>`,
		`<eSearchResult><Count>1</Count><IdList><Id><Id>1</Id></Id></IdList></eSearchResult>`,
	} {
		if _, _, _, err := parseSearchMetadata([]byte(xml), 10); err == nil {
			t.Fatal("malformed search accepted")
		}
	}
	for _, xml := range []string{strings.Replace(good, "<PMID>990000001</PMID>", "<Wrapper><PMID>990000001</PMID></Wrapper>", 1), strings.Replace(good, "<PMID>990000001</PMID>", "<PMID><PMID>990000001</PMID></PMID>", 1)} {
		if _, err := parsePubMed([]byte(xml)); err == nil {
			t.Fatal("malformed identity accepted")
		}
	}
	for _, doi := range []string{"10.5555/x/../y", "10.5555/./y", "10.5555/.."} {
		a := map[string]any{"Doi": doi, "DoiUri": "https://doi.org/wrong"}
		links(a)
		if a["Doi"] != doi || a["DoiUri"] != "" || a["DoiLinkState"] != "unsupported_path_segments" {
			t.Fatal("unsafe DOI linked or identity changed")
		}
	}
}
