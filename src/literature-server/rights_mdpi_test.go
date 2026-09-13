package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func syntheticMDPIJATS(t *testing.T) string {
	t.Helper()
	b, e := os.ReadFile("testdata/rights-template-mdpi.xml")
	if e != nil {
		t.Fatal(e)
	}
	return `<article dtd-version="1.4" article-type="review-article" xml:lang="en"><front><article-meta><article-id pub-id-type="pmc">990000001</article-id><article-id pub-id-type="pmid">990000001</article-id><article-id pub-id-type="doi">10.0000/synthetic</article-id>` + string(b) + `</article-meta></front><body><p>SYNTHETIC ONLY; no real paper or product fallback.</p></body></article>`
}

func TestMDPIGrantProfile(t *testing.T) {
	good := syntheticMDPIJATS(t)
	for name, b := range map[string]string{"exact": good, "year": strings.ReplaceAll(good, "2026", "2021"), "whitespace": strings.Replace(good, "Licensee MDPI", "Licensee\n MDPI", 1), "namespace prefix": strings.ReplaceAll(good, "ali:", "other:")} {
		if name == "namespace prefix" {
			b = strings.Replace(b, "xmlns:ali=", "xmlns:other=", 1)
		}
		t.Run(name, func(t *testing.T) {
			grant, e := validateVersionJATS([]byte(b), syntheticArticle())
			if e != nil || grant != "https://creativecommons.org/licenses/by/4.0/" {
				t.Fatalf("grant rejected: %v", e)
			}
		})
	}
	for name, change := range map[string][2]string{
		"unknown empty attribute":       {`license-type="open-access"`, `license-type="open-access" unknown=""`},
		"scoped license":                {`license-type="open-access"`, `license-type="open-access" specific-use="data"`},
		"future ALI":                    {`specific-use="textmining"`, `specific-use="textmining" start_date="2099-01-01"`},
		"ALI scope":                     {`specific-use="textmining"`, `specific-use="textmining" applies_to="figure"`},
		"wrong namespace":               {`http://www.niso.org/schemas/ali/1.0/`, `https://example.invalid/ali`},
		"unqualified href":              {`xlink:href=`, `href=`},
		"link query":                    {`xlink:href="http://creativecommons.org/licenses/by/4.0/"`, `xlink:href="http://creativecommons.org/licenses/by/4.0/?scope=data"`},
		"license family":                {`https://creativecommons.org/licenses/by/4.0/`, `https://creativecommons.org/licenses/by-nc/4.0/`},
		"data-only":                     {`This article is an open access article`, `The data is open access`},
		"limited prose":                 {`terms and conditions`, `limited terms and conditions`},
		"prose insertion":               {`</copyright-year>`, `</copyright-year>Only noncommercial use.`},
		"year mismatch":                 {`<copyright-year>2026`, `<copyright-year>2025`},
		"nested year":                   {`<copyright-year>2026</copyright-year>`, `<copyright-year><bold>2026</bold></copyright-year>`},
		"additional paragraph":          {`</license-p>`, `</license-p><license-p>Permission required.</license-p>`},
		"duplicate grant":               {`</license>`, `</license><license license-type="restricted"/>`},
		"wrong PMID":                    {`pub-id-type="pmid">990000001`, `pub-id-type="pmid">990000099`},
		"wrong DOI":                     {`10.0000/synthetic`, `10.0000/other`},
		"inherited scope":               {`<front>`, `<front specific-use="data-only">`},
		"inherited base":                {`<article dtd-version`, `<article xml:base="https://example.invalid" dtd-version`},
		"component permission":          {`</body>`, `<fig><permissions><license>CC BY-NC</license></permissions></fig></body>`},
		"component credit":              {`</body>`, `<fig><caption>Reproduced with permission; excluded from article license.</caption></fig></body>`},
		"unreviewed attribution":        {`</body>`, `<fig><attrib>Another copyright holder.</attrib></fig></body>`},
		"body restriction":              {`</body>`, `<p>Figure 1 is excluded from this license.</p></body>`},
		"back restriction":              {`</article>`, `<back><p>Permission required for reuse.</p></back></article>`},
		"component scope attribute":     {`</body>`, `<fig license-type="excluded"/></body>`},
		"unknown body scope":            {`<body>`, `<body specific-use="data-only">`},
		"contradictory repository flag": {`</article-meta>`, `<custom-meta-group><custom-meta><meta-name>pmc-license-ref</meta-name><meta-value>CC BY-NC</meta-value></custom-meta></custom-meta-group></article-meta>`},
		"unscoped extra paragraph":      {`</article-meta>`, `<license-p>CC BY</license-p></article-meta>`},
		"malformed":                     {`</license-p>`, `</license>`},
	} {
		t.Run(name, func(t *testing.T) {
			if strings.Count(good, change[0]) != 1 {
				t.Fatal("mutation must be exact and consequential")
			}
			b := strings.Replace(good, change[0], change[1], 1)
			if _, e := validateVersionJATS([]byte(b), syntheticArticle()); e == nil {
				t.Fatal("unreviewed grant admitted")
			}
		})
	}
}

// Opt-in immutable private source replay; no network and no PDF acquisition.
func TestMDPICapturedJATS(t *testing.T) {
	dir := os.Getenv("LITRADOCK_MDPI_CAPTURE")
	if dir == "" {
		t.Skip("Private captured chain not configured; no live proof")
	}
	read := func(name, hash string) []byte {
		b, e := os.ReadFile(filepath.Join(dir, name))
		s := sha256.Sum256(b)
		if e != nil || hex.EncodeToString(s[:]) != hash {
			t.Fatal("immutable capture mismatch", name)
		}
		return b
	}
	listing := read("2.body", "a5dda78cf65b50b61f6b8074ef32855ccf52b76d58f35ceb7255d60ea2929205")
	metadata := read("3.body", "148895f75d8accfe9689b384e5341967972ac164de6314da2289109c587c771b")
	jats := read("4.body", "26972702762bd6f01a528b0ed05c3d82996a3dafee0d86a4f64c4eb028299f73")
	a := map[string]any{"Pmcid": "PMC7957649", "Pmid": "33673725", "Doi": "10.3390/ijms22052412"}
	version, e := cloudVersion(listing, "PMC7957649")
	if e != nil || version != "PMC7957649.1" {
		t.Fatal("captured version", e)
	}
	m, e := parseCloudMetadata(metadata, version, a)
	if e != nil {
		t.Fatal("captured metadata", e)
	}
	_, md5, e := cloudObject(m.XML, version, "xml")
	if e != nil || !checksumMD5(jats, md5) {
		t.Fatal("captured byte binding", e)
	}
	rights, e := validateVersionJATS(jats, a)
	if e != nil || rights != "https://creativecommons.org/licenses/by/4.0/" {
		t.Fatal("captured rights", e)
	}
	// Corrupt actual transport evidence or identity must not survive revalidation.
	bad := append([]byte{}, jats...)
	bad[len(bad)/2] ^= 1
	if checksumMD5(bad, md5) {
		t.Fatal("modified original evidence accepted")
	}
	var altered map[string]any
	json.Unmarshal(metadata, &altered)
	altered["version"] = 2
	b, _ := json.Marshal(altered)
	if _, e = parseCloudMetadata(b, version, a); e == nil {
		t.Fatal("altered deposit version admitted")
	}
	a["Pmid"] = "33673726"
	if _, e = validateVersionJATS(jats, a); e == nil {
		t.Fatal("foreign article admitted")
	}
	t.Log("Pinned genuine JATS/metadata/listing accepted offline; no PDF or provider call")
}
