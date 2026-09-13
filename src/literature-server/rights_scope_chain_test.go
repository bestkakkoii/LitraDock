package main

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestReviewer002FullProofContradiction(t *testing.T) {
	article := syntheticArticle()
	pdf := syntheticPDF("REVIEWER SCOPE COUNTEREXAMPLE")
	proof := syntheticPDFProof(t, pdf, article)
	makeProof := func(jats string) []byte {
		p := proof
		p.JATS = []byte(jats)
		var metadata cloudMetadata
		if err := json.Unmarshal(p.Metadata, &metadata); err != nil {
			t.Fatal(err)
		}
		sum := md5.Sum(p.JATS)
		metadata.XML = "s3://pmc-oa-opendata/" + articleString(article, "Pmcid") + ".1/" + articleString(article, "Pmcid") + ".1.xml?md5=" + hex.EncodeToString(sum[:])
		p.Metadata, _ = json.Marshal(metadata)
		return proofBytes(p)
	}
	good := syntheticMDPIJATS(t)
	if _, err := validatePDF(pdf, makeProof(good), article); err != nil {
		t.Fatal("full proof positive control", err)
	}
	bad := strings.Replace(good, "</body>", "<p>This material may not be redistributed.</p></body>", 1)
	if _, err := validatePDF(pdf, makeProof(bad), article); err == nil {
		t.Fatal("Explicit conflicting body notice admitted through full listing/JSON/JATS/checksum/PDF validation")
	}
}

func TestReviewer002OuterDTDGuard(t *testing.T) {
	good := syntheticMDPIJATS(t)
	missing := strings.Replace(good, ` dtd-version="1.4"`, "", 1)
	if _, err := validateVersionJATS([]byte(missing), syntheticArticle()); err == nil {
		t.Fatal("missing dtd-version admitted")
	}
	t.Log("outer validateVersionJATS rejects absent dtd-version before new profile; no defect")
}
