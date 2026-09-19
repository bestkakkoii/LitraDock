package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func heldOutcome(t *testing.T, err error) sourceOutcome {
	t.Helper()
	var e *sourceError
	if !errors.As(err, &e) || e.State != "unavailable" {
		t.Fatalf("expected held policy result, got %v", err)
	}
	return describeSource("pdf", e.State, e.Reason, false, false, false, syntheticArticle())
}

func TestSourceOutcomeListingControls(t *testing.T) {
	a := syntheticArticle()
	p := syntheticPDFProof(t, syntheticPDF("outcomes"), a)
	good := string(p.Listing)
	entry := `<CommonPrefixes><Prefix>PMC990000001.1/</Prefix></CommonPrefixes>`
	for _, tc := range []struct{ name, body, want string }{
		{"empty", strings.Replace(strings.Replace(good, "<KeyCount>1</KeyCount>", "<KeyCount>0</KeyCount>", 1), entry, "", 1), "no_deposit"},
		{"multiple", strings.Replace(strings.Replace(good, "<KeyCount>1</KeyCount>", "<KeyCount>2</KeyCount>", 1), entry, entry+strings.Replace(entry, ".1/", ".2/", 1), 1), "version_ambiguous"},
		{"truncated", strings.Replace(good, "<IsTruncated>false", "<IsTruncated>true", 1), "listing_incomplete"},
		{"count contradiction", strings.Replace(good, "<KeyCount>1", "<KeyCount>0", 1), "held"},
		{"duplicate count", strings.Replace(good, "<KeyCount>1</KeyCount>", "<KeyCount>1</KeyCount><KeyCount>0</KeyCount>", 1), "held"},
		{"identity contradiction", strings.Replace(good, "PMC990000001.1/", "PMC990000002.1/", 1), "held"},
		{"contents contradiction", strings.Replace(good, "</ListBucketResult>", "<Contents/></ListBucketResult>", 1), "held"},
		{"duplicate version", strings.Replace(strings.Replace(good, "<KeyCount>1</KeyCount>", "<KeyCount>2</KeyCount>", 1), entry, entry+entry, 1), "held"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, e := cloudVersion([]byte(tc.body), articleString(a, "Pmcid"))
			if e == nil || v != "" {
				t.Fatal("held listing selected a version")
			}
			if tc.want == "malformed" {
				return
			}
			if got := heldOutcome(t, e).Status; got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
		})
	}
	if v, e := cloudVersion(p.Listing, articleString(a, "Pmcid")); e != nil || v != "PMC990000001.1" {
		t.Fatal("positive control", e)
	}
}

func TestSourceOutcomeMetadataControls(t *testing.T) {
	a := syntheticArticle()
	b := syntheticPDF("outcomes")
	p := syntheticPDFProof(t, b, a)
	for _, tc := range []struct {
		name   string
		mutate func(*cloudMetadata)
		want   string
	}{
		{"manuscript TDM", func(m *cloudMetadata) { yes := true; m.Manuscript = &yes; m.License = "TDM" }, "manuscript_tdm"},
		{"manuscript CC BY", func(m *cloudMetadata) { yes := true; m.Manuscript = &yes }, "manuscript"},
		{"TDM published", func(m *cloudMetadata) { m.License = "TDM" }, "tdm"},
		{"no PDF", func(m *cloudMetadata) { m.PDF = "" }, "no_pdf"},
		{"unknown rights", func(m *cloudMetadata) { m.License = "UNKNOWN" }, "held"},
		{"identity before diagnosis", func(m *cloudMetadata) { yes := true; m.Manuscript = &yes; m.License = "TDM"; m.PMID++ }, "held"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var m cloudMetadata
			json.Unmarshal(p.Metadata, &m)
			tc.mutate(&m)
			raw, _ := json.Marshal(m)
			_, e := parseCloudMetadata(raw, "PMC990000001.1", a)
			if got := heldOutcome(t, e).Status; got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
		})
	}
	info, e := validatePDF(b, proofBytes(p), a)
	if e != nil || info.Hash != bundleDigest(b) {
		t.Fatal("positive original changed", e)
	}
}

func TestSourceOutcomeHistoryAndPrivacy(t *testing.T) {
	a := syntheticArticle()
	a["OriginalUri"] = "https://user:secret@pubmed.ncbi.nlm.nih.gov/private?token=PRIVATE_SENTINEL"
	reason := retainedPrefix + "2026-09-18T14:43:50.2946762Z: " + pdfNoDeposit + pdfSuffix
	o := describeSource("pdf", "unavailable", reason, true, false, false, a)
	if o.Status != "no_deposit" || o.RetryEligible || o.ObservedAt == nil || o.Evidence != "retained_source_metadata" {
		t.Fatal(o)
	}
	b, _ := json.Marshal(o)
	if strings.Contains(string(b), "PRIVATE_SENTINEL") || strings.Contains(string(b), "secret") {
		t.Fatal("raw metadata link escaped")
	}
	if o := describeSource("xml", "unavailable", reason, false, false, false, a); o.Status == "no_deposit" {
		t.Fatal("PDF diagnosis leaked into XML scope")
	}
	if o := describeSource("pdf", "unavailable", "No single complete, unambiguous deposit version was listed."+pdfSuffix, false, false, false, a); o.Status != "held" {
		t.Fatal("historical ambiguity invented a precise diagnosis")
	}
	for _, v := range []struct {
		validated, available bool
		want                 string
	}{{false, false, "stored"}, {true, false, "restricted"}, {true, true, "ready"}} {
		if o := describeSource("pdf", "acquired", "", false, v.validated, v.available, a); o.Status != v.want {
			t.Fatal(o)
		}
	}
	for _, retry := range []bool{true, false} {
		if o := describeSource("pdf", "transient", "", retry, false, false, a); o.Status != "retryable" || o.RetryEligible != retry {
			t.Fatal(o)
		}
	}
	if o := describeSource("pdf", "failed", "Saved observation: network failed No acquisition or retry was requested.", true, false, false, a); o.RetryEligible {
		t.Fatal("frozen observation offered retry")
	}
}

func TestSourceOutcomeRetainedNative019(t *testing.T) {
	dir := os.Getenv("LITRADOCK_NATIVE019_CAPTURE")
	if dir == "" {
		t.Skip("Private authentic native019 capture directory not supplied")
	}
	bodies := [][]byte{}
	for n, want := range []string{"9c67b1cc1c78ab156df7c34ad958933902713d034cd80b1b1f0700ae73ef3987", "e411112ccc8649c10008434bf07aa0a66a3a9b2abc545aed51fbb4581bad4406", "c4aabd2b8dc064f4a6c369cdbeab4894d2dc5cc4f4879f0596bbd0eff1ef7259"} {
		b, e := os.ReadFile(filepath.Join(dir, string(rune('1'+n))+".body"))
		if e != nil {
			t.Fatal("capture unavailable")
		}
		h := sha256.Sum256(b)
		if hex.EncodeToString(h[:]) != want {
			t.Fatal("capture hash changed")
		}
		bodies = append(bodies, b)
	}
	v, e := cloudVersion(bodies[0], "PMC8107196")
	if e != nil || v != "PMC8107196.1" {
		t.Fatal("authentic sole deposit", e)
	}
	a := map[string]any{"Pmid": "33173175", "Pmcid": "PMC8107196", "Doi": "10.1038/s41390-020-01231-6"}
	_, e = parseCloudMetadata(bodies[1], v, a)
	if heldOutcome(t, e).Status != "manuscript_tdm" {
		t.Fatal("authentic manuscript/TDM disposition")
	}
	_, e = cloudVersion(bodies[2], "PMC11519786")
	if heldOutcome(t, e).Status != "no_deposit" {
		t.Fatal("authentic empty deposit disposition")
	}
	t.Log("Authentic native019 captured bodies hash-verified; no network, new grant, or PDF acquired")
}
