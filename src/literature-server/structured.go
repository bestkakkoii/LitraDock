package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type exportDataError struct{ message string }

func (e *exportDataError) Error() string { return e.message }
func exportInvalid(message string) error { return &exportDataError{message} }

const structuredSchema = "litradock.research-export"
const structuredLimit = 1000
const structuredBytes = 8 * 1024 * 1024

type structuredScope struct {
	PlanID    *string `json:"planId,omitempty"`
	Kind      string  `json:"kind"`
	RunID     *string `json:"runId"`
	BatchID   *string `json:"batchId"`
	Selection string  `json:"selection"`
}
type structuredCounts struct {
	Exported  int  `json:"exportedRecords"`
	Scope     int  `json:"scopeRecords"`
	Provider  *int `json:"providerMatches"`
	Retrieved *int `json:"retrievedRecords"`
}
type structuredQuery struct {
	RunID       string     `json:"runId"`
	Query       string     `json:"query"`
	State       string     `json:"state"`
	Reason      *string    `json:"reason"`
	Provider    int        `json:"providerMatches"`
	Retrieved   int        `json:"retrievedRecords"`
	Limit       int        `json:"requestedLimit"`
	Complete    bool       `json:"retrievalComplete"`
	SubmittedAt *time.Time `json:"submittedAt"`
}
type structuredIDs struct {
	PMID  *string `json:"pmid"`
	PMCID *string `json:"pmcid"`
	DOI   *string `json:"doi"`
}
type structuredPublication struct {
	Title            *string `json:"title"`
	Authors          *string `json:"authors"`
	Year             *string `json:"year"`
	Journal          *string `json:"journal"`
	PublicationDate  *string `json:"publicationDate"`
	ArticleNumber    *string `json:"articleNumber"`
	Pages            *string `json:"pages"`
	Abstract         *string `json:"abstract"`
	PublicationTypes *string `json:"publicationTypes"`
	RetrievedAt      *string `json:"retrievedAt"`
}
type structuredLinks struct {
	PubMed   *string `json:"pubmed"`
	PMC      *string `json:"pmc"`
	DOI      *string `json:"doi"`
	DOIState *string `json:"doiLinkState"`
}
type structuredAcquisition struct {
	State  *string `json:"state"`
	Reason *string `json:"reason"`
	Format *string `json:"requestedFormat"`
}
type structuredOriginal struct {
	Kind         string    `json:"kind"`
	Format       string    `json:"format"`
	MediaType    string    `json:"mediaType"`
	Deposit      *string   `json:"depositVersion"`
	Version      *string   `json:"version"`
	SHA256       string    `json:"sha256"`
	Bytes        int64     `json:"bytes"`
	Source       *string   `json:"sourceUri"`
	Rights       *string   `json:"rightsUri"`
	Stamp        *string   `json:"repositoryStamp"`
	AcquiredAt   time.Time `json:"acquiredAt"`
	Availability string    `json:"availability"`
}
type structuredRecord struct {
	SearchID    string                `json:"searchId"`
	RunIDs      []string              `json:"runIds"`
	IDs         structuredIDs         `json:"identifiers"`
	Publication structuredPublication `json:"publication"`
	Links       structuredLinks       `json:"sourceLinks"`
	Acquisition structuredAcquisition `json:"acquisition"`
	Originals   []structuredOriginal  `json:"originals"`
}
type structuredDocument struct {
	Schema      string             `json:"schema"`
	Version     int                `json:"schemaVersion"`
	Type        string             `json:"type"`
	GeneratedAt time.Time          `json:"generatedAt"`
	Scope       structuredScope    `json:"scope"`
	Counts      structuredCounts   `json:"counts"`
	Queries     []structuredQuery  `json:"queryContexts"`
	Records     []structuredRecord `json:"records,omitempty"`
}

func optionalText(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// Only named scalar publication fields cross the export boundary. Raw source and
// application maps never become serialized records, even when new keys are added.
func structuredArticle(id, raw string) (structuredRecord, error) {
	r := structuredRecord{SearchID: id, RunIDs: []string{}, Originals: []structuredOriginal{}}
	if !utf8.ValidString(raw) || len(raw) > 4*1024*1024 {
		return r, exportInvalid("Stored metadata exceeds structured export bounds")
	}
	var a map[string]json.RawMessage
	if uniqueJSON([]byte(raw)) != nil || json.Unmarshal([]byte(raw), &a) != nil || a == nil {
		return r, exportInvalid("Invalid stored metadata; no partial export returned")
	}
	var invalid bool
	get := func(key string) *string {
		value, exists := a[key]
		if !exists || string(value) == "null" {
			return nil
		}
		var s string
		if !structuredUnicode(value) || json.Unmarshal(value, &s) != nil || len(s) > 256*1024 {
			invalid = true
			return nil
		}
		return optionalText(s)
	}
	if storedID := get("SearchId"); storedID == nil || *storedID != id {
		return r, exportInvalid("Stored Search ID does not match its record")
	}
	r.IDs = structuredIDs{get("Pmid"), get("Pmcid"), get("Doi")}
	r.Publication = structuredPublication{get("Title"), get("Authors"), get("Year"), get("Journal"), get("PublicationDate"), get("ArticleNumber"), get("Pages"), get("Abstract"), get("PublicationTypes"), get("RetrievedAt")}
	if invalid {
		return r, exportInvalid("Stored publication field is not bounded text")
	}
	// Derive only the same validated landing links used by the normal application.
	linkInput := map[string]any{}
	for k, v := range map[string]*string{"Pmid": r.IDs.PMID, "Pmcid": r.IDs.PMCID, "Doi": r.IDs.DOI} {
		if v != nil {
			linkInput[k] = *v
		}
	}
	links(linkInput)
	r.Links = structuredLinks{optionalText(articleString(linkInput, "OriginalUri")), optionalText(articleString(linkInput, "PmcUri")), optionalText(articleString(linkInput, "DoiUri")), optionalText(articleString(linkInput, "DoiLinkState"))}
	return r, nil
}

func (s *server) structuredResearch(ctx context.Context, library, run, batch string) (structuredDocument, error) {
	if (run == "") == (batch == "") {
		return structuredDocument{}, exportInvalid("Choose exactly one saved run or batch")
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return structuredDocument{}, err
	}
	defer tx.Rollback(context.Background())
	d, err := s.structuredResearchSnapshot(ctx, tx, library, run, batch, "")
	if err != nil {
		return d, err
	}
	return d, tx.Commit(ctx)
}

// The caller owns one consistent snapshot, including any plan state and original bytes.
func (s *server) structuredResearchSnapshot(ctx context.Context, tx pgx.Tx, library, run, batch, plan string) (structuredDocument, error) {
	d := structuredDocument{Schema: structuredSchema, Version: 1, Type: "document", GeneratedAt: time.Now().UTC(), Queries: []structuredQuery{}, Records: []structuredRecord{}, Scope: structuredScope{Selection: "all_saved_scope", RunID: optionalText(run), BatchID: optionalText(batch), PlanID: optionalText(plan)}}
	var err error
	format := ""
	if plan != "" {
		d.Scope.Kind = "plan"
		if err = tx.QueryRow(ctx, "SELECT requested_format FROM native_plans WHERE library_id=$1 AND plan_id=$2", library, plan).Scan(&format); err != nil {
			return d, err
		}
	} else if run != "" {
		d.Scope.Kind = "run"
		var provider, fetched int
		if err = tx.QueryRow(ctx, "SELECT total,fetched FROM ld_runs WHERE library_id=$1 AND run_id=$2", library, run).Scan(&provider, &fetched); err != nil {
			return d, exportInvalid("Saved run unavailable")
		}
		d.Counts.Provider, d.Counts.Retrieved = &provider, &fetched
	} else {
		d.Scope.Kind = "batch"
		if err = tx.QueryRow(ctx, "SELECT requested_format FROM native_batches WHERE library_id=$1 AND batch_id=$2", library, batch).Scan(&format); err != nil {
			return d, exportInvalid("Saved batch unavailable")
		}
	}
	join, identifier := "ld_results", run
	column := "run_id"
	if batch != "" {
		join, identifier, column = "native_items", batch, "batch_id"
	}
	if plan != "" {
		join, identifier, column = "native_plan_items", plan, "plan_id"
	}
	from := " FROM ld_records r JOIN " + join + " x USING(library_id,search_id) WHERE x.library_id=$1 AND x." + column + "=$2"
	var count int
	var metadataBytes int64
	if err = tx.QueryRow(ctx, "SELECT count(*),COALESCE(sum(octet_length(r.metadata)),0)"+from, library, identifier).Scan(&count, &metadataBytes); err != nil {
		return d, err
	}
	if count < 1 || count > structuredLimit || metadataBytes > 4*1024*1024 || (d.Counts.Retrieved != nil && count != *d.Counts.Retrieved) {
		return d, exportInvalid("Saved export count or metadata bound unavailable; nothing truncated")
	}
	d.Counts.Exported, d.Counts.Scope = count, count
	query := "SELECT r.search_id,r.metadata,'' AS state,'' AS reason" + from + " ORDER BY x.rank"
	if batch != "" {
		query = "SELECT r.search_id,r.metadata,x.state,x.reason" + from + " ORDER BY x.rank"
	}
	rows, err := tx.Query(ctx, query, library, identifier)
	if err != nil {
		return d, err
	}
	ids, indices := []string{}, map[string]int{}
	for rows.Next() {
		var id, raw, state, reason string
		if err = rows.Scan(&id, &raw, &state, &reason); err != nil {
			break
		}
		var record structuredRecord
		record, err = structuredArticle(id, raw)
		if err != nil {
			break
		}
		if _, duplicate := indices[id]; duplicate {
			err = exportInvalid("Duplicate saved export membership")
			break
		}
		record.Acquisition = structuredAcquisition{optionalText(state), optionalText(reason), optionalText(format)}
		indices[id], ids = len(d.Records), append(ids, id)
		d.Records = append(d.Records, record)
	}
	rows.Close()
	if err != nil {
		return d, err
	}
	if err = rows.Err(); err != nil {
		return d, err
	}
	if len(ids) != count {
		return d, exportInvalid("Incomplete saved export membership")
	}
	// Association limits fail explicitly; related queries are never silently cut off.
	rows, err = tx.Query(ctx, "SELECT run_id,search_id FROM ld_results WHERE library_id=$1 AND search_id=ANY($2) AND ($3='' OR run_id=$3) ORDER BY run_id,rank LIMIT 10001", library, ids, run)
	if err != nil {
		return d, err
	}
	queryIDs, seen := []string{}, map[string]bool{}
	associations := 0
	for rows.Next() {
		var rid, id string
		if err = rows.Scan(&rid, &id); err != nil {
			break
		}
		associations++
		d.Records[indices[id]].RunIDs = append(d.Records[indices[id]].RunIDs, rid)
		if !seen[rid] {
			seen[rid] = true
			queryIDs = append(queryIDs, rid)
		}
	}
	rows.Close()
	if err != nil {
		return d, err
	}
	if err = rows.Err(); err != nil {
		return d, err
	}
	if associations > 10000 || len(queryIDs) > structuredLimit {
		return d, exportInvalid("Query association export limit reached; nothing truncated")
	}
	var queryBytes int64
	if err = tx.QueryRow(ctx, "SELECT COALESCE(sum(octet_length(input)+octet_length(reason)),0) FROM ld_runs WHERE library_id=$1 AND run_id=ANY($2)", library, queryIDs).Scan(&queryBytes); err != nil {
		return d, err
	}
	if queryBytes > 1024*1024 {
		return d, exportInvalid("Query context export bound unavailable")
	}
	rows, err = tx.Query(ctx, `SELECT run_id,input,state,reason,total,fetched,requested_limit,(SELECT min(created_at) FROM ld_jobs j WHERE j.library_id=r.library_id AND j.run_id=r.run_id) FROM ld_runs r WHERE library_id=$1 AND run_id=ANY($2) ORDER BY run_id`, library, queryIDs)
	if err != nil {
		return d, err
	}
	for rows.Next() {
		var q structuredQuery
		var reason string
		if err = rows.Scan(&q.RunID, &q.Query, &q.State, &reason, &q.Provider, &q.Retrieved, &q.Limit, &q.SubmittedAt); err != nil {
			break
		}
		if q.Provider < 0 || q.Retrieved < 0 || q.Retrieved > q.Provider || q.Limit < 1 || !utf8.ValidString(q.Query) || !utf8.ValidString(reason) {
			err = exportInvalid("Invalid saved query context")
			break
		}
		q.Reason, q.Complete = optionalText(reason), q.State == "complete" && q.Retrieved == q.Provider
		d.Queries = append(d.Queries, q)
	}
	rows.Close()
	if err != nil {
		return d, err
	}
	if err = rows.Err(); err != nil {
		return d, err
	}
	if len(d.Queries) != len(queryIDs) {
		return d, exportInvalid("Incomplete or invalid saved query contexts")
	}
	rows, err = tx.Query(ctx, `SELECT search_id,hash,octet_length(content),source_uri,rights_uri,repository_stamp,acquired_at,format FROM native_originals WHERE library_id=$1 AND search_id=ANY($2) ORDER BY search_id,acquired_at,hash LIMIT 1001`, library, ids)
	if err != nil {
		return d, err
	}
	originalCount := 0
	for rows.Next() {
		var id, source, rights, stamp, format string
		o := structuredOriginal{Kind: "source_original", Availability: "not_revalidated"}
		if err = rows.Scan(&id, &o.SHA256, &o.Bytes, &source, &rights, &stamp, &o.AcquiredAt, &format); err != nil {
			break
		}
		originalCount++
		o.Source, o.Rights, o.Stamp = optionalText(source), optionalText(rights), optionalText(stamp)
		o.Format, o.MediaType = strings.ToUpper(format), "application/xml"
		if format == "pdf" {
			o.MediaType = "application/pdf"
			parts := strings.Split(source, "/")
			if len(parts) == 5 {
				versionID := parts[3]
				if target, _, e := cloudTarget(url.Values{"kind": {"pdf"}, "id": {versionID}}); e == nil && target == source && d.Records[indices[id]].IDs.PMCID != nil && strings.HasPrefix(versionID, *d.Records[indices[id]].IDs.PMCID+".") {
					v := strings.Split(versionID, ".")[1]
					o.Deposit, o.Version = &v, optionalText("PMC deposit "+v+"; published article")
				}
			}
		} else if format == "xml" {
			o.Version = optionalText("repository snapshot")
		} else {
			err = exportInvalid("Unsupported stored original format")
			break
		}
		if len(source) > 2048 || len(rights) > 2048 || len(stamp) > 256 || o.Bytes < 0 || o.Bytes > 8*1024*1024 || len(o.SHA256) != 64 {
			err = exportInvalid("Invalid original descriptor bounds")
			break
		}
		d.Records[indices[id]].Originals = append(d.Records[indices[id]].Originals, o)
	}
	rows.Close()
	if err != nil {
		return d, err
	}
	if err = rows.Err(); err != nil {
		return d, err
	}
	if originalCount > structuredLimit {
		return d, exportInvalid("Original descriptor export limit or metadata invalid")
	}
	return d, nil
}

type structuredBuffer struct{ bytes.Buffer }

func (b *structuredBuffer) Write(p []byte) (int, error) {
	if len(p) > structuredBytes-b.Len() {
		return 0, exportInvalid("Structured export exceeds 8 MiB; no partial file returned")
	}
	return b.Buffer.Write(p)
}

func encodeStructured(ctx context.Context, d structuredDocument, format string) ([]byte, error) {
	if format != "json" && format != "jsonl" {
		return nil, exportInvalid("Choose JSON or JSONL")
	}
	if len(d.Records) < 1 || len(d.Records) > structuredLimit || len(d.Records) != d.Counts.Exported || d.Counts.Scope != d.Counts.Exported {
		return nil, exportInvalid("Invalid structured export record count")
	}
	var out structuredBuffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if format == "json" {
		if err := encoder.Encode(d); err != nil {
			return nil, err
		}
	} else {
		records := d.Records
		d.Records, d.Type = nil, "manifest"
		if err := encoder.Encode(d); err != nil {
			return nil, err
		}
		for _, record := range records {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if err := encoder.Encode(struct {
				Type   string           `json:"type"`
				Record structuredRecord `json:"record"`
			}{"record", record}); err != nil {
				return nil, err
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// Keep endpoint metadata separate from the data model; no user-supplied filename.
func structuredMedia(format string) string {
	if format == "jsonl" {
		return "application/x-ndjson; charset=utf-8"
	}
	return "application/json; charset=utf-8"
}

// encoding/json replaces isolated UTF-16 surrogate escapes; refuse those rather
// than silently changing an exported publication string. Literal Unicode is UTF-8 checked.
func structuredUnicode(raw []byte) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return false
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return false
		}
		n, e := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if e != nil {
			return false
		}
		i += 4
		if n >= 0xDC00 && n <= 0xDFFF {
			return false
		}
		if n >= 0xD800 && n <= 0xDBFF {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return false
			}
			low, e := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if e != nil || low < 0xDC00 || low > 0xDFFF {
				return false
			}
			i += 6
		}
	}
	return true
}
