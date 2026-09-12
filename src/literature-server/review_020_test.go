package main

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestReviewer020Rights(t *testing.T) {
	good := syntheticOAI()
	a := syntheticArticle()
	mutate := func(old, new string) string {
		t.Helper()
		if strings.Count(good, old) != 1 {
			t.Fatalf("mutation target count %d for %q", strings.Count(good, old), old)
		}
		v := strings.Replace(good, old, new, 1)
		if v == good {
			t.Fatal("unchanged negative")
		}
		return v
	}
	positives := map[string]string{"baseline": good, "year": mutate("© The Author(s) 2026", "© The Author(s) 1999"), "whitespace": mutate("which permits unrestricted use", "which  permits\n unrestricted use")}
	for n, b := range positives {
		t.Run(n, func(t *testing.T) {
			v, e := validateOriginal([]byte(b), a)
			h := sha256.Sum256([]byte(b))
			if e != nil || v.Rights != "https://creativecommons.org/licenses/by/4.0/" || v.Hash != hex.EncodeToString(h[:]) {
				t.Fatalf("positive rights/hash %v %+v", e, v)
			}
			t.Log("accepted original-byte SHA and article CC BY")
		})
	}
	negatives := map[string]string{
		"commercial-restriction":     mutate("which permits unrestricted use", "Commercial use is prohibited. which permits unrestricted use"),
		"redistribution-restriction": mutate("which permits unrestricted use", "Redistribution is prohibited. which permits unrestricted use"),
		"complete-unknown-wording":   mutate("which permits unrestricted use", "which permits limited use"),
		"duplicate-copyright":        mutate("</ns0:copyright-statement>", "</ns0:copyright-statement><ns0:copyright-statement>© The Author(s) 2026</ns0:copyright-statement>"),
		"nested-copyright":           mutate("© The Author(s) 2026", "<ns0:bold>© The Author(s) 2026</ns0:bold>"),
		"query-uri":                  mutate("ns2:href=\"http://creativecommons.org/licenses/by/4.0/\"", "ns2:href=\"http://creativecommons.org/licenses/by/4.0/?x=1\""),
		"attribute-only-cc0":         mutate("ns2:href=\"http://creativecommons.org/licenses/by/4.0/\"", "ns2:href=\"https://creativecommons.org/publicdomain/zero/1.0/\""),
	}
	for n, b := range negatives {
		t.Run(n, func(t *testing.T) {
			v, e := validateOriginal([]byte(b), a)
			if e == nil {
				t.Errorf("unsafe changed input accepted rights=%s hash=%s", v.Rights, v.Hash)
			} else {
				t.Logf("denied: %v", e)
			}
		})
	}
}
