package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func csvSafe(s string) string {
	t := strings.TrimLeft(s, " \t\r\n")
	if t != "" && strings.ContainsAny(t[:1], "=+-@") {
		return "'" + s
	}
	return s
}
func (s *server) exportRows(ctx context.Context, library, run, batch string) ([]map[string]any, error) {
	if (run == "") == (batch == "") {
		return nil, errors.New("choose exactly one run or batch")
	}
	if run != "" {
		rows, _, err := s.runMetadataRows(ctx, library, run, 0)
		return rows, err
	}
	var rows []map[string]any
	var e error
	var count int
	var detail any
	detail, e = s.batchDetail(ctx, library, batch)
	if e == nil {
		rows = detail.(map[string]any)["items"].([]map[string]any)
		count = len(rows)
		for _, row := range rows {
			raw, _ := json.Marshal(row["article"])
			row["metadata"] = string(raw)
		}
	}
	if e != nil {
		return nil, e
	}
	if count > 1000 {
		return nil, errors.New("export limit1000; nothing truncated")
	}
	if count == 0 {
		return nil, errors.New("no saved export records")
	}
	if len(rows) != count {
		return nil, errors.New("Saved records changed during export; retry without a partial export.")
	}
	for _, row := range rows {
		row["run_ids"] = run
		row["batch_id"] = batch
	}
	if batch != "" {
		ids := []string{}
		byID := map[string]map[string]any{}
		for _, row := range rows {
			id := row["search_id"].(string)
			ids = append(ids, id)
			byID[id] = row
		}
		links, e := s.rows(ctx, "SELECT search_id,run_id FROM ld_results WHERE library_id=$1 AND search_id=ANY($2) ORDER BY search_id,run_id LIMIT 10001", library, ids)
		if e != nil {
			return nil, e
		}
		if len(links) > 10000 {
			return nil, errors.New("Saved query association bound exceeded; no partial export")
		}
		for _, link := range links {
			row := byID[link["search_id"].(string)]
			previous := row["run_ids"].(string)
			if previous != "" {
				previous += "; "
			}
			row["run_ids"] = previous + link["run_id"].(string)
		}
	}
	return rows, nil
}
func (s *server) exportCSV(ctx context.Context, library, run, batch string) ([]byte, error) {
	rows, e := s.exportRows(ctx, library, run, batch)
	if e != nil {
		return nil, e
	}
	return encodeRecordCSV(ctx, rows)
}

func encodeRecordCSV(ctx context.Context, rows []map[string]any, extraColumns ...string) ([]byte, error) {
	if len(rows) < 1 || len(rows) > runSelectionLimit {
		return nil, errors.New("CSV supports 1–1000 saved records; nothing truncated")
	}
	var b bytes.Buffer
	w := csv.NewWriter(&b)
	_ = w.Write(append(append(append([]string{"Search ID", "Title", "Authors", "Year", "PMID", "PMCID", "DOI", "PubMed URL", "PMC URL", "DOI URL", "Current item state", "Reason", "Rights URI", "Original SHA256"}, sourceOutcomeColumns...), "Search Run ID", "Batch ID"), extraColumns...))
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var a map[string]any
		if json.Unmarshal([]byte(row["metadata"].(string)), &a) != nil {
			return nil, errors.New("invalid stored metadata")
		}
		links(a)
		out := []string{}
		for _, key := range []string{"SearchId", "Title", "Authors", "Year", "Pmid", "Pmcid", "Doi", "OriginalUri", "PmcUri", "DoiUri"} {
			out = append(out, csvSafe(articleString(a, key)))
		}
		for _, key := range []string{"state", "reason", "rights_uri", "original_hash"} {
			v, _ := row[key].(string)
			out = append(out, csvSafe(v))
		}
		for _, value := range outcomeValues(row) {
			out = append(out, csvSafe(value))
		}
		out = append(out, csvSafe(row["run_ids"].(string)), csvSafe(row["batch_id"].(string)))
		if len(extraColumns) > 0 {
			extra, ok := row["snapshot_extra"].([]string)
			if !ok || len(extra) != len(extraColumns) {
				return nil, errors.New("incomplete CSV scope detail")
			}
			for _, value := range extra {
				out = append(out, csvSafe(value))
			}
		}
		_ = w.Write(out)
		if b.Len() > 4*1024*1024 {
			return nil, errors.New("export byte limit reached; no partial export returned")
		}
	}
	w.Flush()
	return b.Bytes(), w.Error()
}
func (s *server) nativeRoutes(w http.ResponseWriter, r *http.Request, ctx context.Context, library string, parts []string) bool {
	if s.planRoutes(w, r, ctx, library, parts) {
		return true
	}
	if len(parts) == 4 && parts[3] == "batches" && r.Method == "POST" {
		var input struct {
			RequestID string
			Format    string
			SearchIDs []string
		}
		if !decode(w, r, &input) {
			return true
		}
		id, e := s.queueBatch(ctx, library, input.RequestID, input.SearchIDs, input.Format)
		if e != nil {
			reply(w, 409, map[string]string{"error": e.Error()})
		} else {
			reply(w, 200, map[string]string{"id": id})
		}
		return true
	}
	if len(parts) == 5 && parts[3] == "batches" && r.Method == "GET" {
		v, e := s.batchDetail(ctx, library, parts[4])
		if e != nil {
			reply(w, 404, nil)
		} else {
			reply(w, 200, v)
		}
		return true
	}
	if len(parts) == 6 && parts[3] == "batches" && parts[5] == "control" && r.Method == "POST" {
		var input struct{ Value string }
		if !decode(w, r, &input) {
			return true
		}
		if e := s.controlBatch(ctx, library, parts[4], input.Value); e != nil {
			reply(w, 409, map[string]string{"error": "Batch control unavailable in its current state."})
		} else {
			reply(w, 200, nil)
		}
		return true
	}
	if len(parts) == 6 && parts[3] == "originals" && r.Method == "GET" {
		b, info, e := s.original(ctx, library, parts[4], parts[5])
		if e != nil {
			reply(w, 409, map[string]string{"error": "Original unavailable under current policy or integrity check; source links remain available."})
		} else {
			w.Header().Set("Content-Type", info.MediaType)
			w.Header().Set("Content-Disposition", "attachment; filename=\"original-"+info.Hash+"."+strings.ToLower(info.Format)+"\"")
			_, _ = w.Write(b)
		}
		return true
	}
	if len(parts) == 4 && parts[3] == "exports" && r.Method == "POST" {
		var input struct {
			RunID, BatchID, Format, Selection string
			SelectionRevision                 *int
		}
		if !decode(w, r, &input) {
			return true
		}
		if input.Selection != "" || input.SelectionRevision != nil {
			if input.Selection != "selected" || input.RunID == "" || input.BatchID != "" || input.SelectionRevision == nil || *input.SelectionRevision < 1 {
				reply(w, 400, map[string]string{"error": "Selected metadata requires one saved run and its current selection revision."})
				return true
			}
			s.selectedRunExport(w, r, ctx, library, input.RunID, input.Format, *input.SelectionRevision)
			return true
		}
		if input.Format == "json" || input.Format == "jsonl" {
			document, e := s.structuredResearch(ctx, library, input.RunID, input.BatchID)
			var data []byte
			if e == nil {
				data, e = encodeStructured(ctx, document, input.Format)
			}
			if e != nil {
				reply(w, 409, map[string]string{"error": "Structured export unavailable: the saved scope is missing, inconsistent, or exceeds export limits. No partial file was returned."})
			} else {
				w.Header().Set("Content-Type", structuredMedia(input.Format))
				w.Header().Set("Content-Disposition", "attachment; filename=\"litradock-research."+input.Format+"\"")
				_, _ = w.Write(data)
			}
			return true
		}
		if (input.Format == "zip" || input.Format == "pdf-download") && input.BatchID != "" && input.RunID == "" {
			if !s.admitBundle(w) {
				return true
			}
			defer s.bundleBusy.Store(false)
			b, e := s.exportBundle(ctx, library, input.BatchID)
			var report []byte
			if e == nil && input.Format == "pdf-download" {
				report, b, e = pdfDownloadPackage(b, "batch", input.BatchID)
			}
			if e != nil {
				reply(w, 409, map[string]string{"error": e.Error()})
			} else if input.Format == "pdf-download" {
				release, ok := s.snapshotResponseAdmission(w, r, ctx, library)
				if !ok {
					return true
				}
				defer release()
				writePDFDownload(w, report, b)
			} else {
				w.Header().Set("Content-Type", "application/zip")
				w.Header().Set("Content-Disposition", "attachment; filename=\"litradock-originals.zip\"")
				_, _ = w.Write(b)
			}
			return true
		}
		if input.Format == "xlsx" {
			b, e := s.exportXLSX(ctx, library, input.RunID, input.BatchID)
			if e != nil {
				reply(w, 409, map[string]string{"error": e.Error()})
			} else {
				w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
				w.Header().Set("Content-Disposition", "attachment; filename=\"litradock-records.xlsx\"")
				_, _ = w.Write(b)
			}
			return true
		}
		if input.Format != "csv" {
			reply(w, 400, map[string]string{"error": "Choose CSV, XLSX, JSON or JSONL metadata, or ZIP for one saved batch."})
			return true
		}
		b, e := s.exportCSV(ctx, library, input.RunID, input.BatchID)
		if e != nil {
			reply(w, 409, map[string]string{"error": e.Error()})
		} else {
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", "attachment; filename=\"litradock-records.csv\"")
			_, _ = w.Write(b)
		}
		return true
	}
	return false
}

// The bundle has a hard original-byte budget before allocation. ZIP Store avoids CPU-heavy recompression.
func (s *server) exportBundle(ctx context.Context, library, batch string) ([]byte, error) {
	var total int64
	if e := s.db.QueryRow(ctx, "SELECT COALESCE(sum(octet_length(o.content)),0) FROM native_items i JOIN native_originals o ON o.library_id=i.library_id AND o.search_id=i.search_id AND o.hash=i.original_hash WHERE i.library_id=$1 AND i.batch_id=$2", library, batch).Scan(&total); e != nil {
		return nil, e
	}
	if total > 32*1024*1024 {
		return nil, errors.New("Bundle exceeds32MiB original-byte limit; save individual originals instead")
	}
	value, e := s.batchDetail(ctx, library, batch)
	if e != nil {
		return nil, e
	}
	detail := value.(map[string]any)
	var out bytes.Buffer
	z := zip.NewWriter(&out)
	manifest := []map[string]any{}
	for _, row := range detail["items"].([]map[string]any) {
		a := row["article"].(map[string]any)
		entry := map[string]any{"searchId": row["search_id"], "pmid": a["Pmid"], "pmcid": a["Pmcid"], "doi": a["Doi"], "sourceLinks": []any{a["OriginalUri"], a["PmcUri"], a["DoiUri"]}, "state": row["state"], "reason": row["reason"]}
		entry["sourceOutcome"] = row["sourceOutcome"]
		if row["downloadAvailable"] == true {
			hash, _ := row["original_hash"].(string)
			b, info, err := s.original(ctx, library, row["search_id"].(string), hash)
			if err != nil {
				entry["state"] = "unavailable"
				entry["reason"] = "Original failed current policy/integrity check; open source links."
				entry["sourceOutcome"] = describeSource(detail["requestedFormat"].(string), "acquired", "", false, true, false, a)
			} else {
				filename := "originals/" + row["search_id"].(string) + "-" + hash + "." + strings.ToLower(info.Format)
				w, err := z.CreateHeader(&zip.FileHeader{Name: filename, Method: zip.Store})
				if err != nil {
					return nil, err
				}
				if _, err = w.Write(b); err != nil {
					return nil, err
				}
				entry["file"] = filename
				entry["sha256"] = hash
				entry["bytes"] = len(b)
				entry["rightsUri"] = info.Rights
				entry["sourceUri"] = info.Source
				entry["repositoryStamp"] = info.Stamp
				entry["format"] = info.Format
				entry["mediaType"] = info.MediaType
				entry["depositVersion"] = info.DepositVersion
				entry["depositType"] = info.DepositType
				entry["publicationVersion"] = info.Version
			}
		}
		manifest = append(manifest, entry)
	}
	m, _ := json.MarshalIndent(map[string]any{"batchId": batch, "requestedFormat": detail["requestedFormat"], "generatedAt": time.Now().UTC(), "policy": detail["policy"], "items": manifest, "scope": "Exact permitted repository originals in their stated format; unresolved items retain source links. Archival snapshots may not reflect current NLM data."}, "", "  ")
	for name, b := range map[string][]byte{"manifest.json": m} {
		w, e := z.Create(name)
		if e != nil {
			return nil, e
		}
		if _, e = w.Write(b); e != nil {
			return nil, e
		}
	}
	csvBytes, e := s.exportCSV(ctx, library, "", batch)
	if e != nil {
		return nil, e
	}
	w, e := z.Create("records.csv")
	if e != nil {
		return nil, e
	}
	if _, e = w.Write(csvBytes); e != nil {
		return nil, e
	}
	if e = z.Close(); e != nil {
		return nil, e
	}
	if out.Len() > 37*1024*1024 {
		return nil, fmt.Errorf("Bundle bound exceeded; nothing sent")
	}
	return out.Bytes(), nil
}
