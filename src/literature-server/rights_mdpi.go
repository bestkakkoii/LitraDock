package main

import (
	"regexp"
	"strings"
)

const mdpiGrantParagraph = "Licensee MDPI, Basel, Switzerland. This article is an open access article distributed under the terms and conditions of the Creative Commons Attribution (CC BY) license (http://creativecommons.org/licenses/by/4.0/)."

var mdpiCopyright = regexp.MustCompile(`^© ([0-9]{4}) by the authors\.$`)
var additionalRightsNotice = regexp.MustCompile(`(?i)licen[sc]e|copyright|permission|reproduced|adapted|third[- ]party|creative commons|excluded from|all rights reserved|no redistribution`)

// This profile recognizes one complete observed English article grant. It does
// not interpret arbitrary legal prose. Unknown scope, attributes, namespaces,
// extra text and component notices remain held for review. See ADR0022.
func reviewedMDPIArticleGrant(article, permissions *node) bool {
	const ali = "http://www.niso.org/schemas/ali/1.0/"
	const xlink = "http://www.w3.org/1999/xlink"
	const ccby = "https://creativecommons.org/licenses/by/4.0/"
	const displayed = "http://creativecommons.org/licenses/by/4.0/"
	plain := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	compact := func(s string) string { return strings.Join(strings.Fields(s), "") }
	type attribute struct{ value, namespace string }
	shape := func(n *node, namespace string, attrs map[string]attribute, children ...string) bool {
		if n == nil || n.Namespace != namespace || len(n.Children) != len(children) {
			return false
		}
		for i, name := range children {
			if n.Children[i].Name != name {
				return false
			}
		}
		for k, v := range n.Attrs {
			if n.AttrNS[k] == "xmlns" || k == "xmlns" && n.AttrNS[k] == "" {
				continue
			}
			want, ok := attrs[k]
			if !ok || v != want.value || n.AttrNS[k] != want.namespace {
				return false
			}
		}
		for k, want := range attrs {
			if n.Attrs[k] != want.value || n.AttrNS[k] != want.namespace {
				return false
			}
		}
		return true
	}
	// No inherited, unreviewed scope on the containing article/front/metadata.
	for _, parent := range []*node{article, article.child("front"), article.child("front").child("article-meta")} {
		if parent == nil || parent.Namespace != "" {
			return false
		}
		for k, v := range parent.Attrs {
			if parent.AttrNS[k] == "xmlns" || k == "xmlns" && parent.AttrNS[k] == "" {
				continue
			}
			if parent != article || !(k == "dtd-version" && v == "1.4" && parent.AttrNS[k] == "" || k == "article-type" && (v == "review-article" || v == "research-article") && parent.AttrNS[k] == "" || k == "lang" && v == "en" && parent.AttrNS[k] == "http://www.w3.org/XML/1998/namespace") {
				return false
			}
		}
	}
	if !shape(permissions, "", nil, "copyright-statement", "copyright-year", "license") {
		return false
	}
	statement, year, license := permissions.Children[0], permissions.Children[1], permissions.Children[2]
	match := mdpiCopyright.FindStringSubmatch(plain(statement.Text))
	if !shape(statement, "", nil) || !shape(year, "", nil) || len(match) != 2 || plain(year.Text) != match[1] || !shape(license, "", map[string]attribute{"license-type": {"open-access", ""}}, "license_ref", "license-p") {
		return false
	}
	ref, paragraph := license.Children[0], license.Children[1]
	if !shape(ref, ali, map[string]attribute{"specific-use": {"textmining", ""}, "content-type": {"ccbylicense", ""}}) || plain(ref.Text) != ccby || !shape(paragraph, "", nil, "ext-link") {
		return false
	}
	link := paragraph.Children[0]
	if !shape(link, "", map[string]attribute{"ext-link-type": {"uri", ""}, "href": {displayed, xlink}}) || plain(link.Text) != displayed || plain(paragraph.Text) != mdpiGrantParagraph {
		return false
	}
	// Comparing the complete text also rejects injected text between child nodes.
	if compact(permissions.Text) != compact(statement.Text+year.Text+ccby+mdpiGrantParagraph) {
		return false
	}
	if len(article.all("permissions")) != 1 || len(article.all("license")) != 1 || len(article.all("license_ref")) != 1 {
		return false
	}
	// Check the entire remainder, including abstract/front matter and mixed
	// inline text. A matching article grant cannot override an external restriction.
	outside := strings.Replace(article.Text, permissions.Text, "", 1)
	metadataExpected := map[string]string{
		"pmc-license-ref": "CC BY", "pmc-prop-suppress-copyright": "no",
		"pmc-prop-legally-suppressed": "no", "pmc-status-embargo": "no",
	}
	seenMetadata := map[string]bool{}
	for _, meta := range article.all("custom-meta") {
		key, value := meta.child("meta-name"), meta.child("meta-value")
		if key == nil || value == nil {
			return false
		}
		want, known := metadataExpected[key.Text]
		if !known {
			continue
		}
		if seenMetadata[key.Text] || !shape(meta, "", nil, "meta-name", "meta-value") || !shape(key, "", nil) || !shape(value, "", nil) || value.Text != want || compact(meta.Text) != compact(key.Text+value.Text) {
			return false
		}
		seenMetadata[key.Text] = true
		outside = strings.Replace(outside, meta.Text, "", 1)
	}
	if permissionConflict.MatchString(outside) || additionalRightsNotice.MatchString(outside) {
		return false
	}
	for _, name := range []string{"attrib", "credit", "copyright-holder"} {
		if len(article.all(name)) != 0 {
			return false
		}
	}
	if len(article.all("copyright-statement")) != 1 || len(article.all("copyright-year")) != 1 {
		return false
	}
	var unscoped func(*node) bool
	unscoped = func(n *node) bool {
		if n == permissions {
			return true
		}
		for k := range n.Attrs {
			if k == "specific-use" || k == "applies_to" || k == "start_date" || k == "end_date" || k == "base" || strings.Contains(k, "license") || strings.Contains(k, "rights") || strings.Contains(k, "permission") {
				return false
			}
		}
		if n.Name == "license-p" {
			return false
		}
		for _, c := range n.Children {
			if !unscoped(c) {
				return false
			}
		}
		return true
	}
	if !unscoped(article) {
		return false
	}
	return true
}
