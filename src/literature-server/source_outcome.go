package main

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// These exact, persisted messages are the diagnostic contract for schema 8.
// Unknown historical messages stay unknown; identifiers never imply a diagnosis.
const (
	pdfNoDeposit         = "The permitted PMC cloud source listed no deposit for this article. This does not establish absence at other sources."
	pdfManyVersions      = "The permitted PMC cloud source listed multiple deposit versions; no version was selected."
	pdfIncompleteListing = "The permitted PMC cloud version listing was incomplete; no version was selected."
	pdfManuscriptTDM     = "This deposit is an author manuscript with license code TDM; it is outside the supported published-article PDF policy."
	pdfManuscript        = "This deposit is an author manuscript; it is outside the supported published-article PDF policy."
	pdfTDM               = "This deposit has license code TDM; the supported PDF policy requires a reviewed published-article CC BY grant."
	pdfMissing           = "PMC advertises no original PDF for this deposit; rendering is not available."
	pdfSuffix            = " No PDF accepted; open the article source links."
	retainedPrefix       = "Retained source evidence at "
)

type sourceOutcome struct {
	Status          string          `json:"status"`
	Label           string          `json:"label"`
	Detail          string          `json:"detail"`
	NextAction      string          `json:"nextAction"`
	RequestedFormat string          `json:"requestedFormat"`
	Evidence        string          `json:"evidence"`
	ObservedAt      *string         `json:"observedAt"`
	RetryEligible   bool            `json:"retryEligible"`
	BatchID         *string         `json:"batchId"`
	Links           structuredLinks `json:"sourceLinks"`
}

func sourceText(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func sourceArticle(r structuredRecord) map[string]any {
	return map[string]any{"Pmid": sourceText(r.IDs.PMID), "Pmcid": sourceText(r.IDs.PMCID), "Doi": sourceText(r.IDs.DOI)}
}

var sourceOutcomeColumns = []string{"Source outcome", "Source outcome detail", "Next action", "Outcome evidence", "Source observed at", "Outcome format"}

func outcomeValues(row map[string]any) []string {
	var o sourceOutcome
	switch value := row["sourceOutcome"].(type) {
	case sourceOutcome:
		o = value
	case *sourceOutcome:
		if value != nil {
			o = *value
		}
	}
	return []string{o.Status, o.Detail, o.NextAction, o.Evidence, sourceText(o.ObservedAt), o.RequestedFormat}
}

func outcomeLinks(a map[string]any) structuredLinks {
	clean := map[string]any{"Pmid": articleString(a, "Pmid"), "Pmcid": articleString(a, "Pmcid"), "Doi": articleString(a, "Doi")}
	links(clean)
	return structuredLinks{optionalText(articleString(clean, "OriginalUri")), optionalText(articleString(clean, "PmcUri")), optionalText(articleString(clean, "DoiUri")), optionalText(articleString(clean, "DoiLinkState"))}
}

func describeSource(format, state, reason string, retry, validated, available bool, a map[string]any) sourceOutcome {
	o := sourceOutcome{Status: "not_checked", Label: "Original not checked", Detail: "Saved metadata does not establish whether a permitted original is available.", NextAction: "Open the article source links or explicitly request a supported original.", RequestedFormat: format, Evidence: "no_saved_outcome", Links: outcomeLinks(a)}
	// Frozen observations remain observations, never live retry permission.
	if strings.HasPrefix(reason, "Saved observation: ") && strings.HasSuffix(reason, " No acquisition or retry was requested.") {
		reason = strings.TrimSuffix(strings.TrimPrefix(reason, "Saved observation: "), " No acquisition or retry was requested.")
		retry = false
	}
	if strings.HasPrefix(reason, retainedPrefix) {
		if stamp, rest, found := strings.Cut(strings.TrimPrefix(reason, retainedPrefix), ": "); found {
			if _, err := time.Parse(time.RFC3339Nano, stamp); err == nil {
				o.ObservedAt = &stamp
				o.Evidence = "retained_source_metadata"
				reason = rest
			}
		}
	}
	set := func(status, label, detail, action string) {
		o.Status, o.Label, o.Detail, o.NextAction = status, label, detail, action
	}
	if state != "" && o.Evidence == "no_saved_outcome" {
		o.Evidence = "saved_item_outcome"
	}
	if state == "acquired" {
		set("stored", "Original stored; validation required", "An original was stored previously. This metadata view does not revalidate its rights or bytes.", "Open the saved batch or save a research snapshot to validate the stored original before download.")
		if validated {
			o.Evidence = "current_original_validation"
			if available {
				set("ready", "Original ready to save", "The stored original passed current policy and integrity checks.", "Use Save to download the unchanged original to your device.")
			} else {
				set("restricted", "Stored original currently unavailable", "The original is retained, but current policy or integrity checks prevent download.", "Open the article source links; contact the operator if access should be available.")
			}
		}
		return o
	}
	if state == "failed" || state == "transient" || state == "rate_wait" {
		o.RetryEligible = retry
		set("retryable", "Acquisition needs attention", "The saved attempt did not acquire an original. A retry is never automatic.", "Open the saved batch or plan to inspect the failure and retry eligibility.")
		if !retry {
			o.NextAction = "Review the saved failure and source links; retry is unavailable in this scope or at the attempt limit."
		}
		return o
	}
	if state == "queued" || state == "running" || state == "paused" || state == "cancelled" || state == "waiting" {
		set(state, "Acquisition "+state, "No completed original is established by this processing state.", "Open the saved batch or plan for progress and available controls.")
		return o
	}
	if state == "unavailable" || state == "unsupported" || state == "held" {
		set("held", "Original held for review", "The retained outcome does not establish a supported downloadable original.", "Open the article source links. Repeating discovery does not resolve a policy or version hold.")
		if format == "pdf" {
			switch reason {
			case pdfNoDeposit + pdfSuffix:
				set("no_deposit", "No deposit in permitted source", pdfNoDeposit, "Open PMC, PubMed or DOI links to check other access options.")
			case pdfManyVersions + pdfSuffix:
				set("version_ambiguous", "Deposit version needs review", pdfManyVersions, "Open the article source links; do not automatically choose the highest version.")
			case pdfIncompleteListing + pdfSuffix:
				set("listing_incomplete", "Deposit listing incomplete", pdfIncompleteListing, "Open the article source links; no version or PDF availability was established.")
			case pdfManuscriptTDM + pdfSuffix:
				set("manuscript_tdm", "Author manuscript / TDM", pdfManuscriptTDM, "Open the article source links for permitted access. No PDF was acquired.")
			case pdfManuscript + pdfSuffix:
				set("manuscript", "Author manuscript outside policy", pdfManuscript, "Open the article source links for permitted access. No PDF was acquired.")
			case pdfTDM + pdfSuffix:
				set("tdm", "TDM deposit outside policy", pdfTDM, "Open the article source links for permitted access. No PDF was acquired.")
			case pdfMissing + pdfSuffix:
				set("no_pdf", "No PDF advertised for deposit", pdfMissing, "Open the article source links; no rendered substitute will be created.")
			case "No supported PMCID; third-party access is not provided." + pdfSuffix:
				set("unsupported_source", "No supported PMC identifier", "This saved record has no supported PMC identifier for the permitted PDF route.", "Open PubMed or DOI links to check access at the article source.")
			}
		}
		if reason == "Operator source restriction: article rights need clarification; open source links." || reason == "NCBI denied access; application login does not confer source permission." || reason == "Article rights restricted or conflicting. No original accepted; open source links." {
			set("restricted", "Source access restricted", "The retained source or operator decision restricts acquisition. Product sign-in does not confer source permission.", "Open the article source links to review permitted access.")
		}
	}
	return o
}

// A saved search shows only its own library's latest PDF attempt and stored-file
// count. This read never validates an upstream source or chooses a stored version.
func sourceHistory(ctx context.Context, tx pgx.Tx, library string, ids []string, format string) (map[string]sourceOutcome, error) {
	rows, err := tx.Query(ctx, `SELECT r.search_id,r.metadata::jsonb->>'Pmid',r.metadata::jsonb->>'Pmcid',r.metadata::jsonb->>'Doi',
 COALESCE(i.state,''),COALESCE(i.reason,''),COALESCE(i.attempts,0),i.batch_id,COALESCE(i.batch_state,''),i.plan_id,
 (SELECT count(*) FROM native_originals o WHERE o.library_id=r.library_id AND o.search_id=r.search_id AND o.format=$3)
 FROM ld_records r LEFT JOIN LATERAL (SELECT i.*,b.state batch_state,b.plan_id FROM native_items i JOIN native_batches b USING(library_id,batch_id)
 WHERE i.library_id=r.library_id AND i.search_id=r.search_id AND b.requested_format=$3 ORDER BY b.created_at DESC,b.batch_id DESC LIMIT 1) i ON true
 WHERE r.library_id=$1 AND r.search_id=ANY($2)`, library, ids, format)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]sourceOutcome{}
	for rows.Next() {
		var id, state, reason, batchState string
		var pmid, pmcid, doi, batch, plan *string
		var attempts, originals int
		if err = rows.Scan(&id, &pmid, &pmcid, &doi, &state, &reason, &attempts, &batch, &batchState, &plan, &originals); err != nil {
			return nil, err
		}
		a := map[string]any{"Pmid": sourceText(pmid), "Pmcid": sourceText(pmcid), "Doi": sourceText(doi)}
		// Child batches are controlled by their parent plan, not by the saved
		// search's batch action. Only advertise a directly actionable retry.
		o := describeSource(format, state, reason, attempts < 3 && batchState != "paused" && batchState != "cancelled" && plan == nil, false, false, a)
		if originals == 1 {
			o = describeSource(format, "acquired", "", false, false, false, a)
		}
		if originals > 1 {
			o.Status = "stored_versions"
			o.Label = "Multiple stored original versions"
			o.Detail = "More than one original is stored; no version was automatically selected."
			o.NextAction = "Open the saved original records and review their exact versions."
			o.RetryEligible = false
			o.Evidence = "stored_original_descriptors"
		}
		o.BatchID = batch
		out[id] = o
	}
	return out, rows.Err()
}
