package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestPrivateReviewedDataReplay(t *testing.T) {
	path := os.Getenv("LITRADOCK_RIGHTS_V3_REPLAY")
	if path == "" {
		t.Skip("Private pinned captures absent; no live request")
	}
	var rows []struct {
		Path, SHA256 string
		Article      map[string]any
	}
	b, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(b, &rows) != nil || len(rows) != 2 {
		t.Fatal("Two pinned private captures required")
	}
	for _, row := range rows {
		b, err = os.ReadFile(row.Path)
		sum := sha256.Sum256(b)
		if err != nil || hex.EncodeToString(sum[:]) != row.SHA256 {
			t.Fatal("Pinned original bytes mismatch")
		}
		info, err := validateOriginal(b, row.Article)
		if err != nil || info.Hash != row.SHA256 || info.Rights != "https://creativecommons.org/licenses/by/4.0/" {
			t.Fatal("Captured article validation", err)
		}
	}
	t.Log("Two exact genuine captures validated; replay is not a new provider request")
}

func syntheticLinkedDataGrant() string {
	b := strings.Replace(syntheticOAI(), "© The Author(s) 2026", "© The Author(s). 2026", 1)
	return strings.Replace(b, "waiver (http://creativecommons.org/publicdomain/zero/1.0/)", `waiver (<ns0:ext-link ext-link-type="uri" ns2:href="http://creativecommons.org/publicdomain/zero/1.0/">http://creativecommons.org/publicdomain/zero/1.0/</ns0:ext-link>)`, 1)
}

func TestReviewedDataLinkGrant(t *testing.T) {
	b := syntheticLinkedDataGrant()
	a := syntheticArticle()
	for name, body := range map[string]string{"old plaintext": syntheticOAI(), "linked data": b, "neutral punctuation": strings.Replace(b, "Author(s).", "Author(s)", 1)} {
		t.Run(name, func(t *testing.T) {
			info, err := validateOriginal([]byte(body), a)
			if err != nil || info.Rights != "https://creativecommons.org/licenses/by/4.0/" {
				t.Fatalf("reviewed article grant %v %+v", err, info)
			}
		})
	}
	link := `<ns0:ext-link ext-link-type="uri" ns2:href="http://creativecommons.org/publicdomain/zero/1.0/">http://creativecommons.org/publicdomain/zero/1.0/</ns0:ext-link>`
	nestedRef := strings.Replace(syntheticOAI(), "</ns1:license_ref>", "", 1)
	nestedRef = strings.Replace(nestedRef, "</ns0:license-p>", "</ns0:license-p></ns1:license_ref>", 1)
	for name, body := range map[string]string{
		"N023 paragraph nested under textmining ref": nestedRef,
		"N023 unknown empty attribute":               strings.Replace(b, `license-type="OpenAccess"`, `license-type="OpenAccess" unknown-review-scope=""`, 1),
		"missing scope attribute":                    strings.Replace(b, ` specific-use="textmining"`, "", 1),
		"article grant swapped":                      strings.Replace(b, `ns2:href="http://creativecommons.org/licenses/by/4.0/"`, `ns2:href="http://creativecommons.org/publicdomain/zero/1.0/"`, 1),
		"data grant swapped":                         strings.Replace(b, `ns2:href="http://creativecommons.org/publicdomain/zero/1.0/"`, `ns2:href="http://creativecommons.org/licenses/by/4.0/"`, 1),
		"data scope attributed to article":           strings.Replace(b, "applies to the data", "applies to the article", 1),
		"query injection":                            strings.Replace(b, `ns2:href="http://creativecommons.org/publicdomain/zero/1.0/"`, `ns2:href="http://creativecommons.org/publicdomain/zero/1.0/?x=1"`, 1),
		"hidden scope":                               strings.Replace(b, link, strings.Replace(link, "ext-link-type", `specific-use="article" ext-link-type`, 1), 1),
		"nested link":                                strings.Replace(b, link, "<ns0:bold>"+link+"</ns0:bold>", 1),
		"duplicate link":                             strings.Replace(b, link, link+link, 1),
		"restriction":                                strings.Replace(b, "which permits unrestricted use", "Commercial use is prohibited", 1),
		"unknown punctuation prose":                  strings.Replace(b, "Author(s).", "Author(s). All rights reserved.", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if body == b {
				t.Fatal("unchanged negative")
			}
			if _, err := validateOriginal([]byte(body), a); err == nil {
				t.Fatal("ambiguous grant accepted")
			}
		})
	}
}
