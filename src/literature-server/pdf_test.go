package main

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Explicitly synthetic one-page parser input, never served as a product source.
func syntheticPDF(label string) []byte {
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	stream := "BT /F1 12 Tf 20 200 Td (SYNTHETIC ONLY " + label + ") Tj ET\n"
	for i, obj := range []string{`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`, fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(stream), stream)} {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, obj)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, off := range offsets[1:] {
		fmt.Fprintf(&b, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	return b.Bytes()
}
func syntheticPDFProof(t *testing.T, b []byte, a map[string]any) pdfProof {
	t.Helper()
	pmc := articleString(a, "Pmcid")
	v := pmc + ".1"
	rights, e := os.ReadFile("testdata/rights-template-001.xml")
	if e != nil {
		t.Fatal(e)
	}
	grant := strings.ReplaceAll(strings.ReplaceAll(string(rights), "ns0:", ""), `xmlns:ns0="https://jats.nlm.nih.gov/ns/archiving/1.4/"`, "")
	jats := []byte(fmt.Sprintf(`<article dtd-version="1.4"><front><article-meta><article-id pub-id-type="pmc">%s</article-id><article-id pub-id-type="pmid">%s</article-id><article-id pub-id-type="doi">%s</article-id>%s</article-meta></front><body><p>SYNTHETIC ONLY</p></body></article>`, pmc, articleString(a, "Pmid"), articleString(a, "Doi"), grant))
	hash := func(b []byte) string { h := md5.Sum(b); return hex.EncodeToString(h[:]) }
	var pmid int64
	fmt.Sscan(articleString(a, "Pmid"), &pmid)
	yes, no := true, false
	m := cloudMetadata{PMCID: pmc, Version: 1, PMID: pmid, DOI: articleString(a, "Doi"), Open: &yes, Manuscript: &no, OCR: &no, Retracted: &no, License: "CC BY", PDF: "s3://pmc-oa-opendata/" + v + "/" + v + ".pdf?md5=" + hash(b), XML: "s3://pmc-oa-opendata/" + v + "/" + v + ".xml?md5=" + hash(jats)}
	meta, _ := json.Marshal(m)
	listing := fmt.Sprintf(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>pmc-oa-opendata</Name><Prefix>%s.</Prefix><KeyCount>1</KeyCount><MaxKeys>3</MaxKeys><Delimiter>/</Delimiter><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>%s/</Prefix></CommonPrefixes></ListBucketResult>`, pmc, v)
	return pdfProof{Policy: pdfPolicy, AcquiredAt: "2026-09-13T00:00:00Z", Listing: []byte(listing), Metadata: meta, JATS: jats}
}
func proofBytes(p pdfProof) []byte { b, _ := json.Marshal(p); return b }

func TestPDFPolicyControls(t *testing.T) {
	a := syntheticArticle()
	b := syntheticPDF("alpha")
	p := syntheticPDFProof(t, b, a)
	info, e := validatePDF(b, proofBytes(p), a)
	if e != nil || info.Format != "PDF" || info.MediaType != "application/pdf" || info.DepositVersion != "1" || info.Rights != "https://creativecommons.org/licenses/by/4.0/" {
		t.Fatal(info, e)
	}
	for name, mutate := range map[string]func(*pdfProof){
		"truncated versions": func(p *pdfProof) { p.Listing = bytes.Replace(p.Listing, []byte("false"), []byte("true"), 1) },
		"wrong version": func(p *pdfProof) {
			p.Metadata = bytes.Replace(p.Metadata, []byte(`"version":1`), []byte(`"version":2`), 1)
		},
		"unknown rights": func(p *pdfProof) { p.Metadata = bytes.Replace(p.Metadata, []byte("CC BY"), []byte("UNKNOWN"), 1) },
		"null restriction": func(p *pdfProof) {
			p.Metadata = bytes.Replace(p.Metadata, []byte(`"is_retracted":false`), []byte(`"is_retracted":null`), 1)
		},
		"retracted": func(p *pdfProof) {
			p.Metadata = bytes.Replace(p.Metadata, []byte(`"is_retracted":false`), []byte(`"is_retracted":true`), 1)
		},
		"manuscript": func(p *pdfProof) {
			p.Metadata = bytes.Replace(p.Metadata, []byte(`"is_manuscript":false`), []byte(`"is_manuscript":true`), 1)
		},
		"duplicate rights": func(p *pdfProof) {
			p.Metadata = bytes.Replace(p.Metadata, []byte(`"license_code":`), []byte(`"license_code":"CC BY-NC","license_code":`), 1)
		},
		"unsafe target": func(p *pdfProof) {
			p.Metadata = bytes.Replace(p.Metadata, []byte("s3://pmc-oa-opendata/"), []byte("https://127.0.0.1/"), 1)
		},
		"modified JATS":  func(p *pdfProof) { p.JATS = append(p.JATS, ' ') },
		"unknown policy": func(p *pdfProof) { p.Policy = "future" },
	} {
		t.Run(name, func(t *testing.T) {
			q := p
			mutate(&q)
			if _, e := validatePDF(b, proofBytes(q), a); e == nil {
				t.Fatal("unsafe evidence accepted")
			}
		})
	}
	for _, key := range []string{"Pmid", "Pmcid", "Doi"} {
		t.Run(key, func(t *testing.T) {
			wrong := syntheticArticle()
			wrong[key] = "mismatch"
			if _, e := validatePDF(b, proofBytes(p), wrong); e == nil {
				t.Fatal("identity accepted")
			}
		})
	}
	for _, bad := range [][]byte{[]byte(syntheticOAI()), b[:len(b)-10], append(append([]byte{}, b...), []byte("modified")...), []byte("%PDF-1.4\n" + strings.Repeat("garbage", 20) + "\n%%EOF")} {
		q := syntheticPDFProof(t, bad, a)
		if _, e := validatePDF(bad, proofBytes(q), a); e == nil {
			t.Fatal("malformed PDF accepted despite recomputed source checksum")
		}
	}
	if _, e := validateStored(b, proofBytes(p), "xml", a); e == nil {
		t.Fatal("PDF satisfied XML")
	}
	if _, _, e := cloudObject("s3://pmc-oa-opendata/PMC990000001.1/PMC990000001.1.pdf?md5="+strings.Repeat("a", 32)+"&md5="+strings.Repeat("b", 32), "PMC990000001.1", "pdf"); e == nil {
		t.Fatal("duplicate digest accepted")
	}
}
func TestPDFTransportBounds(t *testing.T) {
	for _, q := range []url.Values{{"kind": {"pdf"}, "id": {"../x"}}, {"kind": {"pdf"}, "id": {"PMC1.1"}, "url": {"https://evil.invalid"}}, {"kind": {"other"}, "id": {"PMC1.1"}}} {
		if _, _, e := cloudTarget(q); e == nil {
			t.Fatal("unsafe target")
		}
	}
	for _, c := range []struct {
		mime, body string
		length     int64
		ok         bool
	}{{"binary/octet-stream", "bounded", 7, true}, {"text/html", "challenge", 9, false}, {"application/pdf", "short", 20, false}, {"application/pdf", strings.Repeat("x", originalLimit+1), -1, false}} {
		r := &http.Response{Header: http.Header{"Content-Type": {c.mime}}, Body: io.NopCloser(strings.NewReader(c.body)), ContentLength: c.length}
		_, e := readCloudBody(r, "pdf")
		if (e == nil) != c.ok {
			t.Fatal("media/length bound", c.mime, e)
		}
	}
}

// Opt-in retained genuine bytes only; this test makes zero network requests and is not cold-path proof.
func TestPDFRetainedGenuine(t *testing.T) {
	source, jats := os.Getenv("LITRADOCK_PDF_RETAINED"), os.Getenv("LITRADOCK_JATS_RETAINED")
	if source == "" || jats == "" {
		t.Skip("Private retained genuine PDF/JATS evidence not configured")
	}
	for _, id := range []string{"PMC6836491", "PMC6083573"} {
		t.Run(id, func(t *testing.T) {
			read := func(dir, name string) []byte {
				b, e := os.ReadFile(filepath.Join(dir, name))
				if e != nil {
					t.Fatal(e)
				}
				return b
			}
			meta := read(source, id+".1.json")
			var m cloudMetadata
			if e := json.Unmarshal(meta, &m); e != nil {
				t.Fatal(e)
			}
			p := pdfProof{Policy: pdfPolicy, AcquiredAt: "2026-09-13T03:37:00Z", Listing: read(source, id+"-versions.xml"), Metadata: meta, JATS: read(jats, id+".1.xml")}
			a := map[string]any{"Pmcid": m.PMCID, "Pmid": fmt.Sprint(m.PMID), "Doi": m.DOI}
			info, e := validatePDF(read(source, id+".1.pdf"), proofBytes(p), a)
			if e != nil {
				t.Fatal(e)
			}
			t.Log("retained exact PDF", info.Hash, info.Version)
		})
	}
}
