package main

import (
	"os"
	"strings"
	"testing"
)

// Independent reviewer counterexamples retained as synthetic regression inputs; never product data.
func TestReviewer002ScopeDistinctions(t *testing.T) {
	good := syntheticMDPIJATS(t)
	if _, err := validateVersionJATS([]byte(good), syntheticArticle()); err != nil {
		t.Fatal("positive control", err)
	}
	cases := []struct {
		name, old, replacement string
		wantHold               bool
	}{
		{"body existing restriction vocabulary", "</body>", "<p>This material may not be redistributed.</p></body>", true},
		{"body known noncommercial condition", "</body>", "<p>Use of this material is non-commercial only.</p></body>", true},
		{"abstract explicit restriction", "</article-meta>", "<abstract><p>All rights reserved. Permission required to reproduce this article.</p></abstract></article-meta>", true},
		{"front notes restriction", "</front>", "<notes><p>No redistribution of this article.</p></notes></front>", true},
		{"component end date", "</body>", "<fig end_date=\"2020-01-01\"/></body>", true},
		{"ordinary scientific description", "</body>", "<p>Expression increased in the treated cells.</p></body>", false},
		{"existing credit positive guard", "</body>", "<fig><caption>Reproduced with permission.</caption></fig></body>", true},
		{"foreign front namespace", "<front>", "<front xmlns=\"urn:foreign\">", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if strings.Count(good, c.old) != 1 {
				t.Fatal("nonunique mutation")
			}
			input := strings.Replace(good, c.old, c.replacement, 1)
			_, err := validateVersionJATS([]byte(input), syntheticArticle())
			t.Logf("observed held=%v expected held=%v error=%v", err != nil, c.wantHold, err)
			if (err != nil) != c.wantHold {
				t.Errorf("rights disposition mismatch")
			}
		})
	}
}

func TestReviewer002CapturedContradictions(t *testing.T) {
	if os.Getenv("LITRADOCK_MDPI_CAPTURE") == "" {
		t.Skip("Private captured article not configured")
	}
	b, err := os.ReadFile(os.Getenv("LITRADOCK_MDPI_CAPTURE") + "/4.body")
	if err != nil {
		t.Fatal(err)
	}
	a := map[string]any{"Pmcid": "PMC7957649", "Pmid": "33673725", "Doi": "10.3390/ijms22052412"}
	if _, err = validateVersionJATS(b, a); err != nil {
		t.Fatal("actual positive control", err)
	}
	for _, key := range []string{"pmc-prop-legally-suppressed", "pmc-status-embargo"} {
		t.Run(key, func(t *testing.T) {
			old := "<meta-name>" + key + "</meta-name><meta-value>no</meta-value>"
			if strings.Count(string(b), old) != 1 {
				t.Fatal("nonunique actual metadata")
			}
			mutant := strings.Replace(string(b), old, "<meta-name>"+key+"</meta-name><meta-value>yes</meta-value>", 1)
			_, err := validateVersionJATS([]byte(mutant), a)
			t.Logf("observed held=%v expected held=true error=%v", err != nil, err)
			if err == nil {
				t.Error("contradictory captured metadata admitted")
			}
		})
	}
}
