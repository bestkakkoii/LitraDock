package main

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const sourceLimit = 32 * 1024 * 1024

var documentType = regexp.MustCompile(`^DOCTYPE\s+(PubmedArticleSet|eSearchResult)(?:\s+(?:SYSTEM\s+(?:"[^"]*"|'[^']*')|PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*')))?\s*$`)

type sourceError struct{ State, Reason string }

func publicSourceIP(ip net.IP) bool {
	a, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	a = a.Unmap()
	if !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		return false
	}
	for _, block := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "2001::/32", "2002::/16", "64:ff9b::/96"} {
		if netip.MustParsePrefix(block).Contains(a) {
			return false
		}
	}
	return true
}

func (e *sourceError) Error() string { return e.Reason }
func providerClient() *http.Client {
	tr := &http.Transport{Proxy: nil, MaxConnsPerHost: 1, IdleConnTimeout: 30 * time.Second, TLSHandshakeTimeout: 10 * time.Second}
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || (host != "eutils.ncbi.nlm.nih.gov" && host != "pmc.ncbi.nlm.nih.gov" && host != cloudHost) || port != "443" {
			return nil, errors.New("unsupported endpoint")
		}
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, a := range addresses {
			if !publicSourceIP(a.IP) {
				return nil, errors.New("unsafe source address")
			}
		}
		for _, a := range addresses {
			c, e := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(a.IP.String(), port))
			if e == nil {
				return c, nil
			}
			err = e
		}
		return nil, err
	}
	return &http.Client{Transport: tr, Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func (s *server) request(ctx context.Context, path string, q url.Values) ([]byte, error) {
	if path != "esearch.fcgi" && path != "efetch.fcgi" && path != "pmc-oai" && path != "pmc-cloud" {
		return nil, &sourceError{"unsupported", "Unsupported metadata endpoint."}
	}
	endpoint := "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/" + path
	responseKind := "xml"
	if path == "pmc-cloud" {
		var e error
		endpoint, responseKind, e = cloudTarget(q)
		if e != nil {
			return nil, e
		}
	} else {
		if path == "pmc-oai" {
			endpoint = pmcEndpoint
		} else {
			q.Set("db", "pubmed")
			q.Set("retmode", "xml")
			q.Set("tool", "LitraDock")
		}
		endpoint += "?" + q.Encode()
	}
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, "SELECT pg_advisory_lock(724913003)"); err != nil {
		return nil, err
	}
	defer func() {
		c, done := context.WithTimeout(context.Background(), 2*time.Second)
		defer done()
		if _, e := conn.Exec(c, "SELECT pg_advisory_unlock_all()"); e != nil {
			_ = conn.Conn().Close(c)
		}
	}()
	var next time.Time
	if err = conn.QueryRow(ctx, "SELECT next_at FROM ld_source_budget WHERE name='ncbi'").Scan(&next); err != nil {
		return nil, err
	}
	if delay := time.Until(next); delay > 0 {
		if delay > 10*time.Second {
			return nil, &sourceError{"rate_wait", "NCBI cooldown is active; no request sent. Retry later."}
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	var used int
	if err = conn.QueryRow(ctx, "SELECT COALESCE(sum(requests),0) FROM ld_source_usage WHERE provider='ncbi'").Scan(&used); err != nil {
		return nil, err
	}
	if used >= 250 {
		return nil, &sourceError{"rate_wait", "Candidate provider lifetime budget reached; contact the operator."}
	}
	eastern, err := time.LoadLocation("America/New_York")
	if err != nil {
		return nil, err
	}
	local := time.Now().In(eastern)
	var dayUsed int
	if err = conn.QueryRow(ctx, "SELECT COALESCE(sum(requests),0) FROM ld_source_usage WHERE provider='ncbi' AND day=$1", local.Format("2006-01-02")).Scan(&dayUsed); err != nil {
		return nil, err
	}
	if local.Weekday() >= time.Monday && local.Weekday() <= time.Friday && local.Hour() >= 5 && local.Hour() < 21 && dayUsed >= 100 {
		return nil, &sourceError{"rate_wait", "NCBI daytime allowance reached; retry after 21:00 US Eastern or on weekends."}
	}
	if _, err = conn.Exec(ctx, "INSERT INTO ld_source_usage VALUES('ncbi',$1,1) ON CONFLICT(provider,day) DO UPDATE SET requests=ld_source_usage.requests+1", local.Format("2006-01-02")); err != nil {
		return nil, err
	}
	if _, err = conn.Exec(ctx, "UPDATE ld_source_budget SET next_at=now()+$1::interval WHERE name='ncbi'", func() string {
		if path == "pmc-cloud" {
			return "1 second"
		}
		return "400 milliseconds"
	}()); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "LitraDock/Go-native-002")
	req.Header.Set("Accept-Encoding", "gzip, deflate")
	if path == "pmc-cloud" {
		req.Header.Set("Accept-Encoding", "identity")
	}
	response, err := s.provider.Do(req)
	if err != nil {
		return nil, &sourceError{"transient", "Metadata network or TLS request failed; no completion assumed."}
	}
	defer response.Body.Close()
	if response.StatusCode == 429 || response.StatusCode == 503 || response.StatusCode == 502 {
		until := time.Now().Add(2 * time.Second)
		if raw := response.Header.Get("Retry-After"); raw != "" {
			if seconds, e := time.ParseDuration(raw + "s"); e == nil && seconds > 0 {
				until = time.Now().Add(seconds)
			} else if stamp, e := http.ParseTime(raw); e == nil && stamp.After(until) {
				until = stamp
			}
		}
		if _, err = conn.Exec(ctx, "UPDATE ld_source_budget SET next_at=GREATEST(next_at,$1) WHERE name='ncbi'", until); err != nil {
			return nil, err
		}
		return nil, &sourceError{"rate_wait", "NCBI requested cooldown; work is retained with no automatic retry."}
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return nil, &sourceError{"unsupported", "NCBI redirected; alternate targets are not fetched by this candidate."}
	}
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return nil, &sourceError{"unavailable", "NCBI denied access; application login does not confer source permission."}
	}
	if response.StatusCode != 200 {
		return nil, &sourceError{"unavailable", fmt.Sprintf("NCBI returned HTTP %d; no result fabricated.", response.StatusCode)}
	}
	if path == "pmc-cloud" {
		return readCloudBody(response, responseKind)
	}
	return readMetadataBody(response)
}
func readMetadataBody(response *http.Response) ([]byte, error) {
	ct := strings.ToLower(response.Header.Get("Content-Type"))
	if !strings.Contains(ct, "xml") && !strings.HasPrefix(ct, "text/plain") {
		return nil, &sourceError{"failed", "Expected XML metadata; source returned another content type."}
	}
	if response.ContentLength > sourceLimit {
		return nil, &sourceError{"failed", "Source exceeds 32 MiB; nothing was truncated."}
	}
	var reader io.Reader = io.LimitReader(response.Body, sourceLimit+1)
	switch response.Header.Get("Content-Encoding") {
	case "gzip":
		r, e := gzip.NewReader(reader)
		if e != nil {
			return nil, e
		}
		defer r.Close()
		reader = r
	case "deflate":
		r, e := zlib.NewReader(reader)
		if e != nil {
			return nil, e
		}
		defer r.Close()
		reader = r
	case "":
	default:
		return nil, &sourceError{"failed", "Unsupported metadata compression."}
	}
	b, err := io.ReadAll(io.LimitReader(reader, sourceLimit+1))
	if err != nil {
		return nil, &sourceError{"failed", "Incomplete metadata response; no original accepted."}
	}
	if len(b) > sourceLimit {
		return nil, &sourceError{"failed", "Decoded source exceeds 32 MiB; nothing was truncated."}
	}
	return b, nil
}

type node struct {
	Name       string
	Namespace  string
	AttrNS     map[string]string
	Attrs      map[string]string
	Children   []*node
	Text       string
	text       strings.Builder
	Start, End int64
}

func parseXML(b []byte) (*node, error) { return parseXMLDeclaration(b, "") }
func parseXMLDeclaration(b []byte, allowed string) (*node, error) {
	if len(b) > sourceLimit {
		return nil, errors.New("XML bound")
	}
	d := xml.NewDecoder(bytes.NewReader(b))
	var root *node
	stack := []*node{}
	count := 0
	textSize := 0
	declaredRoot := ""
	for {
		start := d.InputOffset()
		t, e := d.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, &sourceError{"failed", "Malformed source XML."}
		}
		switch v := t.(type) {
		case xml.StartElement:
			count++
			if count > 200000 || len(stack) >= 32 {
				return nil, &sourceError{"failed", "XML structural limit exceeded; no truncation."}
			}
			n := &node{Name: v.Name.Local, Namespace: v.Name.Space, AttrNS: map[string]string{}, Attrs: map[string]string{}, Start: start}
			for _, a := range v.Attr {
				if _, exists := n.Attrs[a.Name.Local]; exists {
					return nil, &sourceError{"failed", "Ambiguous XML attribute names."}
				}
				n.Attrs[a.Name.Local] = a.Value
				n.AttrNS[a.Name.Local] = a.Name.Space
			}
			if len(stack) == 0 {
				if root != nil {
					return nil, &sourceError{"failed", "Multiple XML roots."}
				}
				root = n
			} else {
				p := stack[len(stack)-1]
				p.Children = append(p.Children, n)
			}
			stack = append(stack, n)
		case xml.CharData:
			textSize += len(v) * (len(stack) + 1)
			if textSize > sourceLimit*2 {
				return nil, &sourceError{"failed", "XML text complexity limit exceeded; no truncation."}
			}
			if len(stack) > 0 {
				stack[len(stack)-1].text.Write(v)
			} else if strings.TrimSpace(string(v)) != "" {
				return nil, &sourceError{"failed", "Text outside XML root."}
			}
		case xml.EndElement:
			n := stack[len(stack)-1]
			n.Text = n.text.String()
			n.End = d.InputOffset()
			stack = stack[:len(stack)-1]
			if len(stack) > 0 {
				stack[len(stack)-1].text.WriteString(n.Text)
			}
		case xml.Directive:
			fields := strings.Fields(string(v))
			if declaredRoot != "" || root != nil || !(documentType.MatchString(strings.TrimSpace(string(v))) || allowed != "" && strings.Join(strings.Fields(string(v)), " ") == allowed) || strings.ContainsAny(string(v), "[]") {
				return nil, &sourceError{"failed", "Unsupported XML directive."}
			}
			declaredRoot = fields[1]
		}
	}
	if root == nil {
		return nil, &sourceError{"failed", "Empty XML document."}
	}
	if declaredRoot != "" && root.Name != declaredRoot {
		return nil, &sourceError{"failed", "XML declared root mismatch."}
	}
	return root, nil
}
func (n *node) all(name string) []*node {
	out := []*node{}
	for _, c := range n.Children {
		if c.Name == name {
			out = append(out, c)
		}
		out = append(out, c.all(name)...)
	}
	return out
}
func (n *node) child(name string) *node {
	if n == nil {
		return nil
	}
	for _, c := range n.Children {
		if c.Name == name {
			return c
		}
	}
	return nil
}
func (n *node) direct(name string) []*node {
	out := []*node{}
	if n == nil {
		return out
	}
	for _, c := range n.Children {
		if c.Name == name {
			out = append(out, c)
		}
	}
	return out
}
func (n *node) directValue(name string) string {
	if n == nil {
		return ""
	}
	for _, c := range n.direct(name) {
		return strings.TrimSpace(c.Text)
	}
	return ""
}

type searchResult struct {
	Window                      bool
	Offset                      int
	Total                       int
	IDs                         []string
	Articles                    []map[string]any
	Query, Translation, Started string
}

var numeric = regexp.MustCompile(`^[0-9]+$`)
var doiPrefix = regexp.MustCompile(`(?i)^(https?://(dx\.)?doi\.org/|doi:\s*)`)
var pmidQuery = regexp.MustCompile(`(?i)^PMID:\s*([0-9]+)$`)

func normalizeDoi(value string) string {
	return strings.ToLower(doiPrefix.ReplaceAllString(strings.TrimSpace(value), ""))
}

func (s *server) search(ctx context.Context, query string, limit int) (searchResult, error) {
	r := searchResult{Started: time.Now().UTC().Format(time.RFC3339Nano), IDs: []string{}, Articles: []map[string]any{}}
	query = strings.TrimSpace(query)
	if match := pmidQuery.FindStringSubmatch(query); match != nil {
		query = match[1]
	}
	if numeric.MatchString(query) {
		query += "[uid]"
	} else if strings.HasPrefix(normalizeDoi(query), "10.") {
		query = "\"" + strings.ReplaceAll(normalizeDoi(query), "\"", "") + "\"[AID]"
	}
	r.Query = query
	b, err := s.request(ctx, "esearch.fcgi", url.Values{"term": {query}, "retmax": {fmt.Sprint(limit)}, "sort": {"relevance"}})
	if err != nil {
		return r, err
	}
	r.Total, r.IDs, r.Translation, err = parseSearchMetadata(b, limit)
	if err != nil {
		return r, err
	}
	seen := map[string]bool{}
	for _, id := range r.IDs {
		seen[id] = true
	}
	if len(r.IDs) == 0 {
		return r, nil
	}
	b, err = s.request(ctx, "efetch.fcgi", url.Values{"id": {strings.Join(r.IDs, ",")}})
	if err != nil {
		return r, err
	}
	records, err := parsePubMed(b)
	if err != nil {
		return r, err
	}
	byID := map[string]map[string]any{}
	for _, a := range records {
		id := a["Pmid"].(string)
		if !seen[id] || byID[id] != nil {
			return r, &sourceError{"failed", "PubMed metadata did not match requested identities."}
		}
		byID[id] = a
	}
	for _, id := range r.IDs {
		if a := byID[id]; a != nil {
			r.Articles = append(r.Articles, a)
		}
	}
	return r, nil
}
func parseSearchMetadata(b []byte, limit int) (int, []string, string, error) {
	var total int
	var translation string
	resultIDs := []string{}
	doc, err := parseXML(b)
	if err != nil {
		return 0, nil, "", err
	}
	if doc.Name != "eSearchResult" || len(doc.all("ERROR")) > 0 {
		return 0, nil, "", &sourceError{"failed", "PubMed search returned an API error."}
	}
	if len(doc.direct("Count")) != 1 || len(doc.direct("IdList")) != 1 || len(doc.direct("QueryTranslation")) > 1 {
		return 0, nil, "", &sourceError{"failed", "Ambiguous PubMed search structure."}
	}
	if len(doc.child("Count").Children) != 0 {
		return 0, nil, "", &sourceError{"failed", "Malformed PubMed total."}
	}
	if total, err = strconv.Atoi(doc.directValue("Count")); err != nil || total < 0 {
		return 0, nil, "", &sourceError{"failed", "Invalid PubMed total."}
	}
	translation = doc.directValue("QueryTranslation")
	ids := doc.child("IdList")
	if ids == nil {
		return 0, nil, "", &sourceError{"failed", "Missing PubMed identity list."}
	}
	seen := map[string]bool{}
	for _, n := range ids.Children {
		if n.Name != "Id" || len(n.Children) != 0 {
			return 0, nil, "", &sourceError{"failed", "Malformed PubMed identity list."}
		}
		id := strings.TrimSpace(n.Text)
		if !numeric.MatchString(id) || seen[id] {
			return 0, nil, "", &sourceError{"failed", "Invalid or duplicate PubMed identity."}
		}
		seen[id] = true
		resultIDs = append(resultIDs, id)
	}
	if len(resultIDs) > limit || len(resultIDs) > total {
		return 0, nil, "", &sourceError{"failed", "Excessive PubMed result identities."}
	}
	return total, resultIDs, translation, nil
}
func parsePubMed(b []byte) ([]map[string]any, error) {
	doc, err := parseXML(b)
	if err != nil {
		return nil, err
	}
	if doc.Name != "PubmedArticleSet" || len(doc.all("ERROR")) > 0 {
		return nil, &sourceError{"failed", "Invalid PubMed metadata response."}
	}
	out := []map[string]any{}
	for _, record := range doc.Children {
		if record.Name != "PubmedArticle" {
			return nil, &sourceError{"unsupported", "Unsupported PubMed record format; no silent omission."}
		}
		citation := record.child("MedlineCitation")
		a := citation.child("Article")
		if len(record.direct("MedlineCitation")) != 1 || len(citation.direct("Article")) != 1 || len(citation.direct("PMID")) != 1 || len(a.direct("ArticleTitle")) != 1 || len(record.direct("PubmedData")) > 1 || len(record.child("PubmedData").direct("ArticleIdList")) > 1 {
			return nil, &sourceError{"failed", "Missing or ambiguous article identity/title structure; no record selected."}
		}
		pmid := citation.directValue("PMID")
		title := a.directValue("ArticleTitle")
		if !numeric.MatchString(pmid) || title == "" || len(citation.child("PMID").Children) != 0 {
			return nil, &sourceError{"failed", "Missing metadata identity/title."}
		}
		article := map[string]any{}
		for _, k := range []string{"SearchId", "Title", "Authors", "Year", "Doi", "Pmid", "Pmcid", "OriginalUri", "DoiUri", "PmcUri", "Journal", "PublicationDate", "ArticleNumber", "Pages", "Abstract", "PublicationTypes", "RawXml", "FullTextMetadataXml", "EqualContribution", "License", "RetrievedAt"} {
			article[k] = ""
		}
		article["Pmid"], article["Title"] = pmid, title
		article["Journal"] = a.child("Journal").directValue("Title")
		article["Pages"] = a.child("Pagination").directValue("MedlinePgn")
		pub := a.child("ArticleDate")
		if pub == nil {
			pub = a.child("Journal").child("JournalIssue").child("PubDate")
		}
		if pub != nil {
			for _, field := range []string{"Year", "Month", "Day", "MedlineDate"} {
				values := pub.direct(field)
				if len(values) > 1 || len(values) == 1 && len(values[0].Children) > 0 {
					return nil, &sourceError{"failed", "Ambiguous publication date scalar."}
				}
			}
			article["Year"] = pub.directValue("Year")
			if article["Year"] == "" {
				re := regexp.MustCompile(`\d{4}`)
				article["Year"] = re.FindString(pub.directValue("MedlineDate"))
			}
			pieces := []string{}
			for _, x := range []string{article["Year"].(string), pub.directValue("Month"), pub.directValue("Day")} {
				if x != "" {
					pieces = append(pieces, x)
				}
			}
			article["PublicationDate"] = strings.Join(pieces, "-")
		}
		authors := []string{}
		for _, author := range a.child("AuthorList").direct("Author") {
			name := author.directValue("CollectiveName")
			if name == "" {
				parts := []string{}
				for _, k := range []string{"ForeName", "LastName", "Suffix"} {
					if v := author.directValue(k); v != "" {
						parts = append(parts, v)
					}
				}
				name = strings.Join(parts, " ")
			}
			authors = append(authors, name)
		}
		article["Authors"] = strings.Join(authors, "; ")
		abstracts := []string{}
		for _, n := range a.child("Abstract").direct("AbstractText") {
			v := n.Text
			if n.Attrs["Label"] != "" {
				v = n.Attrs["Label"] + ": " + v
			}
			abstracts = append(abstracts, v)
		}
		article["Abstract"] = strings.Join(abstracts, "\n")
		types := []string{}
		for _, n := range a.child("PublicationTypeList").direct("PublicationType") {
			types = append(types, n.Text)
		}
		article["PublicationTypes"] = strings.Join(types, "; ")
		idList := record.child("PubmedData").child("ArticleIdList")
		if idList == nil {
			idList = &node{}
		}
		seenKinds := map[string]bool{}
		for _, id := range idList.Children {
			if id.Name != "ArticleId" {
				return nil, &sourceError{"failed", "Malformed article identifier list."}
			}
			kind := id.Attrs["IdType"]
			if kind == "pubmed" || kind == "doi" || kind == "pmc" {
				if seenKinds[kind] || strings.TrimSpace(id.Text) == "" {
					return nil, &sourceError{"failed", "Duplicate or empty metadata identifier."}
				}
				seenKinds[kind] = true
			}
			if kind == "pubmed" && strings.TrimSpace(id.Text) != pmid {
				return nil, &sourceError{"failed", "Citation and PubMed identifiers disagree."}
			}
			k := ""
			switch id.Attrs["IdType"] {
			case "doi":
				k = "Doi"
			case "pmc":
				k = "Pmcid"
			}
			if k != "" {
				v := strings.TrimSpace(id.Text)
				if k == "Doi" {
					v = normalizeDoi(v)
				} else {
					v = strings.ToUpper(v)
				}
				if article[k] != "" && article[k] != v {
					return nil, &sourceError{"failed", "Conflicting metadata identifiers."}
				}
				article[k] = v
			}
		}
		elDoi := ""
		for _, id := range a.direct("ELocationID") {
			if id.Attrs["EIdType"] == "doi" {
				v := normalizeDoi(id.Text)
				if elDoi != "" || v == "" {
					return nil, &sourceError{"failed", "Duplicate or empty article DOI."}
				}
				elDoi = v
			}
		}
		if elDoi != "" {
			if article["Doi"] != "" && article["Doi"] != elDoi {
				return nil, &sourceError{"failed", "Article DOI evidence disagrees."}
			}
			article["Doi"] = elDoi
		}
		article["RawXml"] = string(b[record.Start:record.End])
		article["RetrievedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
		article["RetrievalState"] = "not_requested"
		links(article)
		out = append(out, article)
	}
	return out, nil
}
func links(a map[string]any) {
	for _, e := range []struct{ key, id, base string }{{"OriginalUri", "Pmid", "https://pubmed.ncbi.nlm.nih.gov/"}, {"PmcUri", "Pmcid", "https://pmc.ncbi.nlm.nih.gov/articles/"}, {"DoiUri", "Doi", "https://doi.org/"}} {
		if v, ok := a[e.id].(string); ok && v != "" {
			if e.id == "Doi" {
				a[e.key] = ""
				a["DoiLinkState"] = "available"
				unsupported := false
				for _, segment := range strings.Split(v, "/") {
					if segment == "." || segment == ".." {
						unsupported = true
					}
				}
				if unsupported {
					a["DoiLinkState"] = "unsupported_path_segments"
					continue
				}
			}
			a[e.key] = e.base + strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape(v), "+", "%20"), "%2F", "/")
			if e.id != "Doi" {
				a[e.key] = a[e.key].(string) + "/"
			}
		}
	}
}
