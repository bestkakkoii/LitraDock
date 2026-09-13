package main

import (
	"bytes"
	"context"
	"crypto/md5" // Source-advertised object checksum only; SHA256 remains the immutable identity.
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

const cloudHost = "pmc-oa-opendata.s3.amazonaws.com"
const cloudBase = "https://" + cloudHost
const pdfPolicy = "native-pmc-cloud-version-grant-v1"
const pdfPolicySummary = "Original PDFs from an unambiguous PMC published deposit with a reviewed CC BY 4.0 grant and matching object checksum. Other sources and versions remain held with links. Saved files are archival snapshots and may not reflect current NLM data."
const proofLimit = 2 * 1024 * 1024

var depositPattern = regexp.MustCompile(`^PMC[1-9][0-9]*\.[1-9][0-9]{0,5}$`)
var md5Pattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

type pdfProof struct {
	Policy     string `json:"policy"`
	AcquiredAt string `json:"acquiredAt"`
	Listing    []byte `json:"listing"`
	Metadata   []byte `json:"metadata"`
	JATS       []byte `json:"jats"`
}
type cloudMetadata struct {
	PMCID      string `json:"pmcid"`
	Version    int    `json:"version"`
	PMID       int64  `json:"pmid"`
	DOI        string `json:"doi"`
	Open       *bool  `json:"is_pmc_openaccess"`
	Manuscript *bool  `json:"is_manuscript"`
	OCR        *bool  `json:"is_historical_ocr"`
	Retracted  *bool  `json:"is_retracted"`
	License    string `json:"license_code"`
	PDF        string `json:"pdf_url"`
	XML        string `json:"xml_url"`
}

func pdfHeld(reason string) error {
	return &sourceError{"unavailable", reason + " No PDF accepted; open the article source links."}
}

func cloudVersion(b []byte, pmcid string) (string, error) {
	if !pmcidPattern.MatchString(pmcid) || len(b) > 64*1024 {
		return "", pdfHeld("Version listing is unsupported.")
	}
	n, e := parseXML(b)
	if e != nil {
		return "", e
	}
	if n.Name != "ListBucketResult" || n.Namespace != "http://s3.amazonaws.com/doc/2006-03-01/" {
		return "", pdfHeld("Unexpected version listing.")
	}
	for key, want := range map[string]string{"Name": "pmc-oa-opendata", "Prefix": pmcid + ".", "Delimiter": "/", "IsTruncated": "false", "MaxKeys": "3", "KeyCount": "1"} {
		v := n.direct(key)
		if len(v) != 1 || len(v[0].Children) != 0 || v[0].Namespace != n.Namespace || v[0].Text != want {
			return "", pdfHeld("No single complete, unambiguous deposit version was listed.")
		}
	}
	versions := n.direct("CommonPrefixes")
	if len(versions) != 1 || len(n.direct("Contents")) != 0 || len(versions[0].direct("Prefix")) != 1 {
		return "", pdfHeld("Missing or multiple deposit versions require review.")
	}
	prefix := versions[0].child("Prefix")
	version := strings.TrimSuffix(prefix.Text, "/")
	if prefix.Namespace != n.Namespace || len(prefix.Children) != 0 || prefix.Text != version+"/" || !depositPattern.MatchString(version) || !strings.HasPrefix(version, pmcid+".") {
		return "", pdfHeld("Deposit identity mismatch.")
	}
	return version, nil
}

// Reject duplicate JSON keys before typed decoding; ignored future fields cannot shadow rights/identity.
func uniqueJSON(b []byte) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 16 {
			return errors.New("JSON depth")
		}
		t, e := d.Token()
		if e != nil {
			return e
		}
		if delim, ok := t.(json.Delim); ok {
			switch delim {
			case '{':
				seen := map[string]bool{}
				for d.More() {
					k, e := d.Token()
					if e != nil {
						return e
					}
					name, ok := k.(string)
					if !ok || seen[name] {
						return errors.New("duplicate JSON key")
					}
					seen[name] = true
					if e = walk(depth + 1); e != nil {
						return e
					}
				}
			case '[':
				for d.More() {
					if e = walk(depth + 1); e != nil {
						return e
					}
				}
			default:
				return errors.New("JSON delimiter")
			}
			_, e = d.Token()
			return e
		}
		return nil
	}
	if e := walk(0); e != nil {
		return e
	}
	if _, e := d.Token(); e != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
func cloudObject(raw, version, format string) (string, string, error) {
	u, e := url.Parse(raw)
	path := "/" + version + "/" + version + "." + format
	if e != nil || u.Scheme != "s3" || u.Host != "pmc-oa-opendata" || u.User != nil || u.Fragment != "" || u.Path != path || u.RawPath != "" {
		return "", "", pdfHeld("Unsafe or mismatched advertised object path.")
	}
	q, e := url.ParseQuery(u.RawQuery)
	if e != nil || len(q) != 1 || len(q["md5"]) != 1 || !md5Pattern.MatchString(q.Get("md5")) {
		return "", "", pdfHeld("Missing or ambiguous source checksum.")
	}
	return path, q.Get("md5"), nil
}
func parseCloudMetadata(b []byte, version string, a map[string]any) (cloudMetadata, error) {
	var m cloudMetadata
	if len(b) > 64*1024 || uniqueJSON(b) != nil || json.Unmarshal(b, &m) != nil {
		return m, pdfHeld("Malformed article version metadata.")
	}
	if m.PMCID+"."+strconv.Itoa(m.Version) != version || m.PMCID != articleString(a, "Pmcid") || strconv.FormatInt(m.PMID, 10) != articleString(a, "Pmid") || m.DOI == "" || normalizeDoi(m.DOI) != articleString(a, "Doi") {
		return m, pdfHeld("Article identifiers or deposit version disagree.")
	}
	if m.Open == nil || !*m.Open || m.Manuscript == nil || *m.Manuscript || m.OCR == nil || *m.OCR || m.Retracted == nil || *m.Retracted || m.License != "CC BY" {
		return m, pdfHeld("Deposit rights, type or retraction status is unsupported or unknown.")
	}
	if m.PDF == "" {
		return m, pdfHeld("PMC advertises no original PDF for this deposit; rendering is not available.")
	}
	if _, _, e := cloudObject(m.PDF, version, "pdf"); e != nil {
		return m, e
	}
	if _, _, e := cloudObject(m.XML, version, "xml"); e != nil {
		return m, e
	}
	return m, nil
}
func checksumMD5(b []byte, want string) bool {
	h := md5.Sum(b)
	return hex.EncodeToString(h[:]) == want
}

func validateVersionJATS(b []byte, a map[string]any) (string, error) {
	if len(b) > originalLimit {
		return "", pdfHeld("JATS evidence exceeds its limit.")
	}
	n, e := parseXMLDeclaration(b, `DOCTYPE article PUBLIC "-//NLM//DTD JATS (Z39.96) Journal Archiving and Interchange DTD with MathML3 v1.4 20241031//EN" "JATS-archivearticle1-4-mathml3.dtd"`)
	if e != nil {
		return "", e
	}
	if n.Name != "article" || len(n.all("article")) != 0 {
		return "", pdfHeld("Expected one complete JATS article.")
	}
	if n.Namespace != "" || n.Attrs["dtd-version"] != "1.4" {
		return "", pdfHeld("Unreviewed cloud JATS structure.")
	}
	return validateArticleGrantNS(n, a, "")
}

var pdfParserMu sync.Mutex

func validatePDFSyntax(b []byte) (err error) {
	pdfParserMu.Lock()
	defer pdfParserMu.Unlock()
	// Parsing never rewrites the document, loads local configuration, follows links or reads credentials.
	defer func() {
		if recover() != nil {
			err = pdfHeld("PDF parser rejected the document.")
		}
	}()
	if len(b) < 64 || len(b) > originalLimit || !bytes.HasPrefix(b, []byte("%PDF-")) || !bytes.HasSuffix(bytes.TrimSpace(b), []byte("%%EOF")) {
		return pdfHeld("Incomplete, oversized or non-PDF original.")
	}
	conf := &model.Configuration{Reader15: true, ValidationMode: model.ValidationRelaxed, Offline: true, Limits: model.ResourceLimits{MaxStreamBytes: originalLimit, MaxDecodeBytes: 16 * 1024 * 1024, MaxImageBytes: 16 * 1024 * 1024, MaxImagePixels: 8 * 1024 * 1024, MaxObjectCount: 100000, MaxObjectStreamCount: 10000, MaxObjectStreamFirst: 2 * 1024 * 1024, MaxXRefEntries: 100000, MaxRecursionDepth: 64}}
	c, e := api.ReadContext(bytes.NewReader(b), conf)
	if e != nil {
		return pdfHeld("PDF structure is unsupported or malformed.")
	}
	if c.Encrypt != nil {
		return pdfHeld("Encrypted PDF is unsupported.")
	}
	if e = api.ValidateContext(c); e != nil || c.PageCount < 1 || c.PageCount > 1000 {
		return pdfHeld("PDF validation or page bound failed.")
	}
	return nil
}
func validatePDF(b, proof []byte, a map[string]any) (originalInfo, error) {
	var out originalInfo
	var p pdfProof
	if len(proof) > proofLimit || uniqueJSON(proof) != nil || json.Unmarshal(proof, &p) != nil || p.Policy != pdfPolicy {
		return out, pdfHeld("Stored PDF evidence is invalid.")
	}
	if _, e := time.Parse(time.RFC3339Nano, p.AcquiredAt); e != nil {
		return out, pdfHeld("Invalid acquisition time.")
	}
	v, e := cloudVersion(p.Listing, articleString(a, "Pmcid"))
	if e != nil {
		return out, e
	}
	m, e := parseCloudMetadata(p.Metadata, v, a)
	if e != nil {
		return out, e
	}
	path, hash, e := cloudObject(m.PDF, v, "pdf")
	if e != nil || !checksumMD5(b, hash) {
		return out, pdfHeld("Original PDF checksum disagrees with version metadata.")
	}
	_, jhash, _ := cloudObject(m.XML, v, "xml")
	if !checksumMD5(p.JATS, jhash) {
		return out, pdfHeld("Version JATS checksum disagrees.")
	}
	rights, e := validateVersionJATS(p.JATS, a)
	if e != nil {
		return out, e
	}
	if e = validatePDFSyntax(b); e != nil {
		return out, e
	}
	sum := sha256.Sum256(b)
	return originalInfo{Hash: hex.EncodeToString(sum[:]), Rights: rights, Stamp: p.AcquiredAt, Source: cloudBase + path, Format: "PDF", MediaType: "application/pdf", Version: fmt.Sprintf("PMC deposit %d; published article", m.Version), DepositVersion: strconv.Itoa(m.Version), DepositType: "published article", Proof: proof}, nil
}
func validateStored(b, proof []byte, format string, a map[string]any) (originalInfo, error) {
	if format == "pdf" {
		return validatePDF(b, proof, a)
	}
	if format != "xml" || len(proof) != 0 {
		return originalInfo{}, errors.New("unsupported stored format")
	}
	return validateOriginal(b, a)
}
func (s *server) acquirePDF(ctx context.Context, a map[string]any) ([]byte, originalInfo, error) {
	var out originalInfo
	p := pdfProof{Policy: pdfPolicy, AcquiredAt: time.Now().UTC().Format(time.RFC3339Nano)}
	id := articleString(a, "Pmcid")
	if !pmcidPattern.MatchString(id) {
		return nil, out, pdfHeld("No supported PMCID; third-party access is not provided.")
	}
	var e error
	p.Listing, e = s.request(ctx, "pmc-cloud", url.Values{"kind": {"list"}, "id": {id}})
	if e != nil {
		return nil, out, e
	}
	v, e := cloudVersion(p.Listing, id)
	if e != nil {
		return nil, out, e
	}
	p.Metadata, e = s.request(ctx, "pmc-cloud", url.Values{"kind": {"json"}, "id": {v}})
	if e != nil {
		return nil, out, e
	}
	m, e := parseCloudMetadata(p.Metadata, v, a)
	if e != nil {
		return nil, out, e
	}
	p.JATS, e = s.request(ctx, "pmc-cloud", url.Values{"kind": {"xml"}, "id": {v}})
	if e != nil {
		return nil, out, e
	}
	_, jh, _ := cloudObject(m.XML, v, "xml")
	if !checksumMD5(p.JATS, jh) {
		return nil, out, pdfHeld("Version JATS checksum disagrees.")
	}
	if _, e = validateVersionJATS(p.JATS, a); e != nil {
		return nil, out, e
	}
	proof, e := json.Marshal(p)
	if e != nil || len(proof) > proofLimit {
		return nil, out, pdfHeld("Version evidence exceeds the storage bound.")
	}
	b, e := s.request(ctx, "pmc-cloud", url.Values{"kind": {"pdf"}, "id": {v}})
	if e != nil {
		return nil, out, e
	}
	out, e = validatePDF(b, proof, a)
	return b, out, e
}
