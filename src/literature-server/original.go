package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const pmcEndpoint = "https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/"
const acquisitionPolicy = "native-pmc-oai-reviewed-grant-v3"
const originalLimit = 8 * 1024 * 1024

var pmcidPattern = regexp.MustCompile(`^PMC[1-9][0-9]*$`)
var permissionConflict = regexp.MustCompile(`(?i)all rights reserved|may not be redistributed|no redistribution|non[- ]commercial|no commercial re[- ]?use|no derivatives|permission (is )?required`)

type originalInfo struct {
	Hash, Rights, Stamp, Source                             string
	Format, MediaType, Version, DepositVersion, DepositType string
	Proof                                                   []byte
}

func xmlInfo(out originalInfo) originalInfo {
	out.Format = "XML"
	out.MediaType = "application/xml"
	out.Version = "repository snapshot; publication version unspecified"
	return out
}

func articleString(a map[string]any, k string) string { v, _ := a[k].(string); return v }
func pmcQuery(a map[string]any) (url.Values, error) {
	id := articleString(a, "Pmcid")
	if !pmcidPattern.MatchString(id) {
		return nil, &sourceError{"unsupported", "Reusable XML requires an unversioned PMCID; open the source links."}
	}
	if pmid := articleString(a, "Pmid"); pmid != "" && !numeric.MatchString(pmid) {
		return nil, errors.New("invalid PMID")
	}
	return url.Values{"verb": {"GetRecord"}, "metadataPrefix": {"pmc"}, "identifier": {"oai:pubmedcentral.nih.gov:" + id[3:]}}, nil
}
func validateOriginal(b []byte, expected map[string]any) (originalInfo, error) {
	var out originalInfo
	q, e := pmcQuery(expected)
	if e != nil {
		return out, e
	}
	fail := func(reason string) (originalInfo, error) {
		return out, &sourceError{"unavailable", reason + " No original accepted; open source links."}
	}
	if len(b) < 10 || len(b) > originalLimit {
		return fail("XML original exceeds the supported size or is empty.")
	}
	root, e := parseXML(b)
	if e != nil {
		return out, e
	}
	const ns = "http://www.openarchives.org/OAI/2.0/"
	if root.Name != "OAI-PMH" || root.Namespace != ns {
		return fail("Expected PMC OAI envelope.")
	}
	if len(root.direct("error")) > 0 {
		return fail("PMC did not provide reusable XML for this identity.")
	}
	one := func(n *node, name string) *node {
		if len(n.direct(name)) != 1 {
			return nil
		}
		return n.child(name)
	}
	req := one(root, "request")
	get := one(root, "GetRecord")
	record := one(get, "record")
	header := one(record, "header")
	metadata := one(record, "metadata")
	for _, n := range []*node{req, get, record, header, metadata} {
		if n == nil || n.Namespace != ns {
			return fail("Ambiguous OAI structure.")
		}
	}
	identity := q.Get("identifier")
	if req.Text != pmcEndpoint || req.Attrs["verb"] != "GetRecord" || req.Attrs["metadataPrefix"] != "pmc" || req.Attrs["identifier"] != identity {
		return fail("OAI request identity or format mismatch.")
	}
	hid := one(header, "identifier")
	stamp := one(header, "datestamp")
	if hid == nil || hid.Namespace != ns || len(hid.Children) != 0 || hid.Text != identity || stamp == nil || stamp.Namespace != ns || len(stamp.Children) != 0 || header.Attrs["status"] != "" {
		return fail("Deleted, mismatched or malformed OAI header.")
	}
	_, e = time.Parse(time.RFC3339, stamp.Text)
	if e != nil {
		_, e = time.Parse("2006-01-02", stamp.Text)
	}
	if e != nil {
		return fail("Invalid repository datestamp.")
	}
	if len(metadata.Children) != 1 || metadata.Children[0].Name != "article" || len(root.all("article")) != 1 {
		return fail("Expected one complete article structure.")
	}
	article := metadata.Children[0]
	rights, e := validateArticleGrant(article, expected)
	if e != nil {
		return out, e
	}
	out.Rights = rights
	sum := sha256.Sum256(b)
	out.Hash = hex.EncodeToString(sum[:])
	out.Stamp = stamp.Text
	out.Source = pmcEndpoint + "?" + q.Encode()
	return xmlInfo(out), nil
}

// Shared article-level validator: the OAI envelope and cloud version binding remain separate.
func validateArticleGrant(article *node, expected map[string]any) (string, error) {
	return validateArticleGrantNS(article, expected, "https://jats.nlm.nih.gov/ns/archiving/1.4/")
}
func validateArticleGrantNS(article *node, expected map[string]any, jatsNS string) (string, error) {
	rights := ""
	fail := func(reason string) (string, error) {
		return "", &sourceError{"unavailable", reason + " No original accepted; open source links."}
	}
	one := func(n *node, name string) *node {
		if len(n.direct(name)) != 1 {
			return nil
		}
		return n.child(name)
	}
	front := one(article, "front")
	am := one(front, "article-meta")
	body := one(article, "body")
	if am == nil || body == nil || strings.TrimSpace(body.Text) == "" {
		return fail("Missing or ambiguous article front/body.")
	}
	for kind, key := range map[string]string{"pmc": "Pmcid", "pmid": "Pmid", "doi": "Doi"} {
		values := []string{}
		for _, n := range am.direct("article-id") {
			typ := n.Attrs["pub-id-type"]
			if typ == kind || kind == "pmc" && typ == "pmcid" {
				if len(n.Children) != 0 {
					return fail("Nested article identity.")
				}
				v := strings.TrimSpace(n.Text)
				if kind == "pmc" {
					v = "PMC" + strings.TrimPrefix(v, "PMC")
				}
				if kind == "doi" {
					v = normalizeDoi(v)
				}
				values = append(values, v)
			}
		}
		want := articleString(expected, key)
		if len(values) > 1 || want != "" && (len(values) != 1 || values[0] != want) {
			return fail("Article identifier mismatch.")
		}
	}
	permissions := one(am, "permissions")
	if permissions == nil {
		return fail("Article rights unknown.")
	}
	if permissionConflict.MatchString(permissions.Text) {
		return fail("Article rights restricted or conflicting.")
	}
	// Unreviewed scope attributes or structural variants cannot hide behind the text digest.
	var reviewedStructure func(*node) bool
	reviewedStructure = func(n *node) bool {
		attrs := map[string]string{}
		namespace := jatsNS
		childrenAre := func(names ...string) bool {
			if len(n.Children) != len(names) {
				return false
			}
			for i, name := range names {
				if n.Children[i].Name != name {
					return false
				}
			}
			return true
		}
		switch n.Name {
		case "permissions":
			if !childrenAre("copyright-statement", "license") {
				return false
			}
		case "copyright-statement":
			if !childrenAre() {
				return false
			}
		case "license-p":
			if !childrenAre("bold", "ext-link") && !childrenAre("bold", "ext-link", "ext-link") {
				return false
			}
			if n.Children[1].Attrs["href"] != "http://creativecommons.org/licenses/by/4.0/" {
				return false
			}
			if len(n.Children) == 3 && n.Children[2].Attrs["href"] != "http://creativecommons.org/publicdomain/zero/1.0/" {
				return false
			}
		case "bold":
			if !childrenAre() || n.Text != "Open Access" {
				return false
			}
		case "license":
			if !childrenAre("license_ref", "license-p") {
				return false
			}
			attrs["license-type"] = "OpenAccess"
		case "license_ref":
			if !childrenAre() || n.Text != "https://creativecommons.org/licenses/by/4.0/" {
				return false
			}
			namespace = "http://www.niso.org/schemas/ali/1.0/"
			attrs["specific-use"] = "textmining"
			attrs["content-type"] = "ccbylicense"
		case "ext-link":
			attrs["ext-link-type"] = "uri"
			attrs["href"] = "http://creativecommons.org/licenses/by/4.0/"
			if n.Attrs["href"] == "http://creativecommons.org/publicdomain/zero/1.0/" {
				attrs["href"] = n.Attrs["href"]
			}
			if len(n.Children) != 0 || n.Text != attrs["href"] {
				return false
			}
		default:
			return false
		}
		if n.Namespace != namespace {
			return false
		}
		for k, v := range n.Attrs {
			if n.AttrNS[k] == "xmlns" || k == "xmlns" && n.AttrNS[k] == "" {
				continue
			}
			if expected, known := attrs[k]; !known || expected != v {
				return false
			}
			wantNS := ""
			if k == "href" {
				wantNS = "http://www.w3.org/1999/xlink"
			}
			if n.AttrNS[k] != wantNS {
				return false
			}
		}
		for k, expected := range attrs {
			if n.Attrs[k] != expected {
				return false
			}
		}
		for _, child := range n.Children {
			if !reviewedStructure(child) {
				return false
			}
		}
		return true
	}
	if !reviewedStructure(permissions) {
		return fail("Article rights structure or scope is unreviewed.")
	}
	// Rights prose is not natural-language permission inference. Only a reviewed
	// complete grant template is admitted; changed wording needs explicit review.
	statement := one(permissions, "copyright-statement")
	if statement == nil || len(statement.Children) != 0 || !regexp.MustCompile(`^© The Author\(s\)\.? [0-9]{4}$`).MatchString(statement.Text) || len(permissions.Children) != 2 || len(permissions.direct("license")) != 1 {
		return fail("Article rights wording is unreviewed or ambiguous.")
	}
	canonical := strings.Replace(permissions.Text, statement.Text, "COPYRIGHT-YEAR", 1)
	canonical = strings.Join(strings.Fields(canonical), "")
	grantDigest := sha256.Sum256([]byte(canonical))
	if hex.EncodeToString(grantDigest[:]) != "5e7f2fde4289fe38b132577a63be1238ec050d4e7220eeb6475d65e7421e016e" {
		return fail("Article rights wording is unreviewed; clarification required.")
	}
	// The same complete reviewed prose may mark its data-only CC0 URL as a
	// direct link. It is not an article grant: require that exact leaf/location
	// and exclude only that node from the article-license collection below.
	var dataLink *node
	license := permissions.child("license")
	paragraph := one(license, "license-p")
	for _, n := range license.all("ext-link") {
		if n.Attrs["href"] != "http://creativecommons.org/publicdomain/zero/1.0/" {
			continue
		}
		direct := false
		for _, child := range paragraph.direct("ext-link") {
			direct = direct || child == n
		}
		if dataLink != nil || !direct || len(n.Children) != 0 || n.Text != n.Attrs["href"] {
			return fail("Data-only rights link is ambiguous or outside reviewed scope.")
		}
		dataLink = n
	}
	grants := map[string]bool{}
	for _, license := range permissions.direct("license") {
		nodes := append([]*node{license}, license.all("ext-link")...)
		for _, n := range nodes {
			if n == dataLink {
				continue
			}
			raw := n.Attrs["href"]
			if raw == "" {
				continue
			}
			if n.AttrNS["href"] != "http://www.w3.org/1999/xlink" {
				return fail("Ambiguous article grant link.")
			}
			u, e := url.Parse(raw)
			if e != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
				return fail("Malformed rights URI.")
			}
			if u.Host == "creativecommons.org" && (u.Scheme == "http" || u.Scheme == "https") {
				path := strings.TrimSuffix(u.Path, "/") + "/"
				if path != "/licenses/by/4.0/" && path != "/publicdomain/zero/1.0/" {
					return fail("Article license unsupported.")
				}
				grants["https://creativecommons.org"+path] = true
			}
		}
	}
	if len(grants) != 1 {
		return fail("Article permission unknown or conflicting.")
	}
	for grant := range grants {
		rights = grant
	}
	return rights, nil
}
