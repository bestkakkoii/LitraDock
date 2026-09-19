package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
)

var runSelectionExportColumns = []string{"Export scope", "Selection revision", "Saved record count"}

// Run metadata, ordered membership and source outcomes share one snapshot. The
// selected variant additionally fences the caller's displayed selection revision.
func (s *server) runMetadataRows(ctx context.Context, library, run string, revision int) ([]map[string]any, runSelectionView, error) {
	v := runSelectionView{RunID: run}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return nil, v, err
	}
	defer tx.Rollback(context.Background())
	if err = snapshotAdmission(ctx, tx, library); err != nil {
		return nil, v, err
	}
	var fetched int
	var querySnapshot string
	if err = tx.QueryRow(ctx, "SELECT fetched,snapshot FROM ld_runs WHERE library_id=$1 AND run_id=$2", library, run).Scan(&fetched, &querySnapshot); errors.Is(err, pgx.ErrNoRows) {
		return nil, v, &planError{404, "Saved export run not found."}
	} else if err != nil {
		return nil, v, err
	}
	queryProvenance, err := queryRouteProvenance(querySnapshot)
	if err != nil {
		return nil, v, err
	}
	if revision > 0 {
		v, err = s.selectionStateFrom(ctx, tx, library, run)
		if err != nil {
			return nil, v, err
		}
		if v.Revision != revision {
			return nil, v, &planError{409, "Selection or saved records changed. Reload before exporting the selected scope."}
		}
	} else {
		v.SavedCount = fetched
	}
	from := ` FROM ld_records r JOIN ld_results x USING(library_id,search_id)
 WHERE x.library_id=$1 AND x.run_id=$2`
	args := []any{library, run}
	if revision > 0 {
		from += " AND x.search_id=ANY($3::text[])"
		args = append(args, v.SelectedIDs)
	}
	var count int
	var metadataBytes int64
	if err = tx.QueryRow(ctx, `SELECT count(*),COALESCE(sum(octet_length((r.metadata::jsonb-'RawXml'-'FullTextMetadataXml')::text)),0)`+from, args...).Scan(&count, &metadataBytes); err != nil {
		return nil, v, err
	}
	expected := fetched
	if revision > 0 {
		expected = v.SelectedCount
	}
	if count < 1 || count > runSelectionLimit || count != expected || v.SavedCount != fetched || metadataBytes > 32<<20 {
		return nil, v, &planError{409, "Saved export scope is empty, inconsistent or exceeds its record/metadata limit. No partial file was returned."}
	}
	if revision == 0 {
		v.SelectedCount = count
	}
	rows, err := tx.Query(ctx, `SELECT x.search_id,(r.metadata::jsonb-'RawXml'-'FullTextMetadataXml')::text`+from+" ORDER BY x.rank,x.search_id", args...)
	if err != nil {
		return nil, v, err
	}
	result := []map[string]any{}
	ids := []string{}
	for rows.Next() {
		var id, raw string
		var article map[string]any
		if err = rows.Scan(&id, &raw); err != nil {
			break
		}
		if json.Unmarshal([]byte(raw), &article) != nil || articleString(article, "SearchId") != id {
			err = errors.New("saved export identity mismatch")
			break
		}
		row := map[string]any{"metadata": raw, "run_ids": run, "batch_id": "", "state": "", "reason": "", "rights_uri": "", "original_hash": ""}
		row["queryRouteProvenance"] = queryProvenance
		if revision > 0 {
			row["snapshot_extra"] = []string{"selected_saved_records", strconv.Itoa(v.Revision), strconv.Itoa(v.SavedCount)}
		}
		ids = append(ids, id)
		result = append(result, row)
	}
	rows.Close()
	if err != nil {
		return nil, v, err
	}
	if err = rows.Err(); err != nil {
		return nil, v, err
	}
	if len(result) != count {
		return nil, v, errors.New("saved export membership changed")
	}
	outcomes, err := sourceHistory(ctx, tx, library, ids, "pdf")
	if err != nil {
		return nil, v, err
	}
	for i, row := range result {
		row["sourceOutcome"] = outcomes[ids[i]]
	}
	return result, v, tx.Commit(ctx)
}

func (s *server) selectedStructuredResearch(ctx context.Context, library, run string, revision int) (structuredDocument, runSelectionView, error) {
	var document structuredDocument
	var selection runSelectionView
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return document, selection, err
	}
	defer tx.Rollback(context.Background())
	if err = snapshotAdmission(ctx, tx, library); err != nil {
		return document, selection, err
	}
	selection, err = s.selectionStateFrom(ctx, tx, library, run)
	if err != nil {
		return document, selection, err
	}
	if revision < 1 || selection.Revision != revision {
		return document, selection, &planError{409, "Selection or saved records changed. Reload before exporting the selected scope."}
	}
	document, err = s.liveStructuredSelectionSnapshot(ctx, tx, library, run, "", "", &selection)
	if err != nil {
		return document, selection, err
	}
	return document, selection, tx.Commit(ctx)
}

func (s *server) selectedRunExport(w http.ResponseWriter, r *http.Request, ctx context.Context, library, run, format string, revision int) {
	var data []byte
	var selection runSelectionView
	var err error
	media := ""
	switch format {
	case "json", "jsonl":
		var document structuredDocument
		document, selection, err = s.selectedStructuredResearch(ctx, library, run, revision)
		if err == nil {
			data, err = encodeStructured(ctx, document, format)
		}
		media = structuredMedia(format)
	case "csv", "xlsx":
		var rows []map[string]any
		rows, selection, err = s.runMetadataRows(ctx, library, run, revision)
		if err == nil && format == "csv" {
			data, err = encodeRecordCSV(ctx, rows, runSelectionExportColumns...)
			media = "text/csv; charset=utf-8"
		} else if err == nil {
			data, err = encodeWorkbook(ctx, rows, run, "", runSelectionExportColumns...)
			media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
		}
	default:
		err = &planError{400, "Selected saved records support CSV, XLSX, JSON and JSONL metadata exports."}
	}
	if err != nil {
		var invalid *exportDataError
		if errors.As(err, &invalid) {
			err = &planError{409, "Selected metadata is empty, inconsistent or exceeds export limits. No partial file was returned."}
		}
		runSelectionReply(w, nil, err)
		return
	}
	release, allowed := s.snapshotResponseAdmission(w, r, ctx, library)
	if !allowed {
		return
	}
	defer release()
	w.Header().Set("Content-Type", media)
	w.Header().Set("Content-Disposition", "attachment; filename=\"litradock-selected."+format+"\"")
	w.Header().Set("X-LitraDock-Export-Scope", "selected_saved_records")
	w.Header().Set("X-LitraDock-Selection-Revision", strconv.Itoa(selection.Revision))
	w.Header().Set("X-LitraDock-Export-Count", strconv.Itoa(selection.SelectedCount))
	_, _ = w.Write(data)
}
