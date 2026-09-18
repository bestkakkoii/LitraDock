package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMDPIHTTPSGrantProfile(t *testing.T) {
	old := syntheticMDPIJATS(t)
	good := strings.ReplaceAll(strings.Replace(old, ` license-type="open-access"`, "", 1), "http://creativecommons.org/", "https://creativecommons.org/")
	if grant, e := validateVersionJATS([]byte(good), syntheticArticle()); e != nil || grant != "https://creativecommons.org/licenses/by/4.0/" {
		t.Fatal("synthetic new profile rejected", e)
	}
	for name, change := range map[string][2]string{
		"unknown empty attribute":   {`<license>`, `<license unknown="">`},
		"restricted type":           {`<license>`, `<license license-type="restricted">`},
		"unreviewed paired type":    {`<license>`, `<license license-type="open-access">`},
		"data scope":                {`<license>`, `<license specific-use="data">`},
		"inherited scope":           {`<front>`, `<front specific-use="data">`},
		"future ALI":                {`specific-use="textmining"`, `specific-use="textmining" start_date="2099-01-01"`},
		"ALI component scope":       {`specific-use="textmining"`, `specific-use="textmining" applies_to="figure"`},
		"missing ALI namespace":     {`http://www.niso.org/schemas/ali/1.0/`, `https://example.invalid/ali`},
		"unqualified link":          {`xlink:href=`, `href=`},
		"link scope":                {`xlink:href="https://creativecommons.org/licenses/by/4.0/"`, `xlink:href="https://creativecommons.org/licenses/by/4.0/?scope=data"`},
		"link downgrade":            {`xlink:href="https://creativecommons.org/licenses/by/4.0/"`, `xlink:href="http://creativecommons.org/licenses/by/4.0/"`},
		"data-only grant":           {`This article is an open access article`, `These data are open access`},
		"intervening restriction":   {`</copyright-year>`, `</copyright-year>Permission required.`},
		"extra paragraph":           {`</license-p>`, `</license-p><license-p>Only some content.</license-p>`},
		"duplicate license":         {`</license>`, `</license><license/>`},
		"unknown license namespace": {`<license>`, `<license xmlns="https://example.invalid/license">`},
		"component notice":          {`</body>`, `<fig><caption>Reproduced with permission.</caption></fig></body>`},
		"body restriction":          {`</body>`, `<p>No redistribution.</p></body>`},
		"repository conflict":       {`</article-meta>`, `<custom-meta-group><custom-meta><meta-name>pmc-license-ref</meta-name><meta-value>CC BY-NC</meta-value></custom-meta></custom-meta-group></article-meta>`},
		"wrong PMID":                {`pub-id-type="pmid">990000001`, `pub-id-type="pmid">990000009`},
		"wrong DOI":                 {`10.0000/synthetic`, `10.0000/other`},
		"malformed":                 {`</license-p>`, `</license>`},
	} {
		t.Run(name, func(t *testing.T) {
			if strings.Count(good, change[0]) != 1 {
				t.Fatal("mutation must change exactly one boundary")
			}
			bad := strings.Replace(good, change[0], change[1], 1)
			if _, e := validateVersionJATS([]byte(bad), syntheticArticle()); e == nil {
				t.Fatal("unreviewed grant admitted")
			}
		})
	}
	// Do not independently relax the type and URI requirements into a cross product.
	if _, e := validateVersionJATS([]byte(strings.Replace(old, ` license-type="open-access"`, "", 1)), syntheticArticle()); e == nil {
		t.Fatal("unreviewed absent-type HTTP profile admitted")
	}
}

// Independent review042 exposed these inherited false admissions in both profiles.
func TestMDPIExplicitExternalUseRestrictions(t *testing.T) {
	old := syntheticMDPIJATS(t)
	newProfile := strings.ReplaceAll(strings.Replace(old, ` license-type="open-access"`, "", 1), "http://creativecommons.org/", "https://creativecommons.org/")
	for profile, good := range map[string]string{"HTTP": old, "HTTPS": newProfile} {
		t.Run(profile, func(t *testing.T) {
			if _, e := validateVersionJATS([]byte(good), syntheticArticle()); e != nil {
				t.Fatal("positive control", e)
			}
			for _, notice := range []string{
				"This article is for personal use only.",
				"This article may not be shared.",
				"This article is for PERSONAL\n USE\tONLY.",
				"This article may <bold>not</bold> be shared.",
			} {
				bad := strings.Replace(good, "</body>", "<p>"+notice+"</p></body>", 1)
				if _, e := validateVersionJATS([]byte(bad), syntheticArticle()); e == nil {
					t.Errorf("explicit restriction admitted: %q", notice)
				}
			}
		})
	}
}

// Private immutable replay, never a product fixture or a fresh source request.
func TestMDPI2025CapturedJATS(t *testing.T) {
	dir := os.Getenv("LITRADOCK_MDPI_2025_CAPTURE")
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
	listing := read("1.body", "c1b6e45584c185de037435ccd36c3ffdc09751b844cbfd8aff580bf030204a3a")
	metadata := read("2.body", "d85661d1bdef8b7199c316c8d95ff5a4c5eada8d9b15d9834a2501a58db74590")
	jats := read("3.body", "131630c66e5b85f8d541208bec3faf180e42af95944a58eaf64681a8f61d9c78")
	a := map[string]any{"Pmcid": "PMC11852450", "Pmid": "40001485", "Doi": "10.3390/biom15020182"}
	v, e := cloudVersion(listing, "PMC11852450")
	if e != nil || v != "PMC11852450.1" {
		t.Fatal("captured version", e)
	}
	m, e := parseCloudMetadata(metadata, v, a)
	if e != nil {
		t.Fatal("captured metadata", e)
	}
	_, digest, e := cloudObject(m.XML, v, "xml")
	if e != nil || !checksumMD5(jats, digest) {
		t.Fatal("captured byte binding", e)
	}
	grant, e := validateVersionJATS(jats, a)
	if e != nil || grant != "https://creativecommons.org/licenses/by/4.0/" {
		t.Fatal("captured article grant", e)
	}
	// Actual capture counterexamples remain private; neither mutation is grant evidence.
	for _, changed := range []string{
		strings.Replace(string(jats), "This article is an open access article", "The data is open access", 1),
		strings.Replace(string(jats), "</body>", "<p>Figure 1 excluded from this license.</p></body>", 1),
	} {
		if changed == string(jats) {
			t.Fatal("actual capture mutation not applied")
		}
		if _, e := validateVersionJATS([]byte(changed), a); e == nil {
			t.Fatal("contradictory captured grant admitted")
		}
	}
	a["Pmid"] = "40001486"
	if _, e = validateVersionJATS(jats, a); e == nil {
		t.Fatal("foreign article accepted")
	}
	t.Log("Pinned genuine listing/version/JATS accepted offline; no PDF or provider call")
}
