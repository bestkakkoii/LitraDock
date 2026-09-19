package main

import (
	"encoding/json"
	"strings"
	"time"
)

type routeProvenance struct {
	Execution      string `json:"execution"`
	SourceClaim    string `json:"sourceClaim"`
	Verification   string `json:"verification"`
	ResponseSHA256 string `json:"responseSHA256"`
	ReceivedAt     string `json:"receivedAt"`
	SubmittedQuery string `json:"submittedQuery,omitempty"`
	Translation    string `json:"translation,omitempty"`
}

type routeQueryAssociation struct {
	RunID      string           `json:"runID"`
	Provenance *routeProvenance `json:"provenance"`
}

func checkedRouteProvenance(a map[string]any, query bool) (*routeProvenance, error) {
	prefix := "Metadata"
	if query {
		prefix = ""
	}
	v := articleString(a, prefix+"Verification")
	if v == "" {
		return nil, nil
	}
	p := &routeProvenance{Execution: articleString(a, prefix+"Execution"), SourceClaim: articleString(a, prefix+"SourceClaim"), Verification: v, ResponseSHA256: articleString(a, prefix+"ResponseSHA256"), ReceivedAt: articleString(a, prefix+"ReceivedAt")}
	if p.Execution != userRouteExecution || p.SourceClaim != "pubmed" || p.Verification != userRouteVerification || len(p.ResponseSHA256) != 64 || strings.Trim(p.ResponseSHA256, "0123456789abcdef") != "" {
		return nil, exportInvalid("Invalid source provenance; no partial export returned")
	}
	if _, e := time.Parse(time.RFC3339Nano, p.ReceivedAt); e != nil {
		return nil, exportInvalid("Invalid source receipt time")
	}
	if query {
		p.SubmittedQuery = articleString(a, "SubmittedQuery")
		p.Translation = articleString(a, "Translation")
	}
	return p, nil
}

func queryRouteProvenance(raw string) (*routeProvenance, error) {
	var a map[string]any
	if json.Unmarshal([]byte(raw), &a) != nil {
		return nil, exportInvalid("Invalid saved query snapshot")
	}
	return checkedRouteProvenance(a, true)
}

var routeProvenanceColumns = []string{"Metadata execution", "Metadata verification", "Metadata response SHA256", "Metadata received at", "Query membership verification", "Submitted query", "Query translation", "Query membership provenance by run (JSON)"}

func routeExportValues(row map[string]any) ([]string, error) {
	var a map[string]any
	raw, _ := row["metadata"].(string)
	if json.Unmarshal([]byte(raw), &a) != nil {
		return nil, exportInvalid("Invalid stored metadata")
	}
	p, e := checkedRouteProvenance(a, false)
	if e != nil {
		return nil, e
	}
	q, _ := row["queryRouteProvenance"].(*routeProvenance)
	queries, _ := row["queryRouteProvenanceByRun"].([]routeQueryAssociation)
	if p == nil && q == nil && len(queries) == 0 {
		return nil, nil
	}
	v := []string{"previously_saved", "prior_saved_record", "", "", "", "", "", ""}
	if p != nil {
		v[0], v[1], v[2], v[3] = p.Execution, p.Verification, p.ResponseSHA256, p.ReceivedAt
	}
	if q != nil {
		v[4], v[5], v[6] = q.Verification, q.SubmittedQuery, q.Translation
		queries = []routeQueryAssociation{{row["run_ids"].(string), q}}
	}
	if len(queries) > 0 {
		encoded, e := json.Marshal(queries)
		if e != nil {
			return nil, e
		}
		v[4], v[7] = userRouteVerification, string(encoded)
	}
	return v, nil
}

func hasRouteExport(rows []map[string]any) (bool, error) {
	found := false
	for _, row := range rows {
		values, e := routeExportValues(row)
		if e != nil {
			return false, e
		}
		found = found || len(values) > 0
	}
	return found, nil
}
