package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Revalidate outside the data snapshot, after potentially slow reads/encoding.
// Hold the session/account/library locks through body handoff; a committed logout
// before this point prevents an attachment, and a later logout waits for handoff.
func (s *server) snapshotResponseAdmission(w http.ResponseWriter, r *http.Request, ctx context.Context, library string) (func(), bool) {
	if _, ok := ctx.Value(snapshotSessionKey{}).(*session); !ok {
		cookie, e := r.Cookie(s.cookieName())
		if e != nil {
			reply(w, 401, nil)
			return nil, false
		}
		sess, e := s.authenticate(ctx, cookie.Value)
		if e != nil {
			reply(w, 503, nil)
			return nil, false
		}
		if sess == nil {
			reply(w, 401, nil)
			return nil, false
		}
		ctx = context.WithValue(ctx, snapshotSessionKey{}, sess)
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		planReply(w, nil, e)
		return nil, false
	}
	release := func() {
		clean, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = tx.Rollback(clean)
	}
	if e = snapshotAdmission(ctx, tx, library); e != nil {
		release()
		planReply(w, nil, e)
		return nil, false
	}
	return release, true
}

var snapshotExtraColumns = []string{"Abstract", "Journal", "Publication metadata JSON", "Query contexts JSON", "Original provenance JSON", "Typed record JSON"}

func snapshotRows(d savedSnapshotDocument) ([]map[string]any, error) {
	rows := []map[string]any{}
	for n, o := range d.Observations {
		if n >= len(d.Research.Records) {
			return nil, exportInvalid("Incomplete saved snapshot")
		}
		r := d.Research.Records[n]
		row := map[string]any{"metadata": o.Metadata, "state": o.Item.Phase, "reason": o.Item.Reason, "original_hash": o.Item.OriginalHash, "run_ids": strings.Join(r.RunIDs, "; ")}
		for _, original := range r.Originals {
			if original.SHA256 == o.Item.OriginalHash {
				text := func(v *string) string {
					if v == nil {
						return ""
					}
					return *v
				}
				row["rights_uri"] = text(original.Rights)
				row["source_uri"] = text(original.Source)
				row["repository_stamp"] = text(original.Stamp)
				row["format"] = original.Format
				row["version"] = text(original.Version)
				row["bytes"] = original.Bytes
			}
		}
		queries := []structuredQuery{}
		for _, q := range d.Research.Queries {
			for _, id := range r.RunIDs {
				if q.RunID == id {
					queries = append(queries, q)
				}
			}
		}
		encode := func(v any) (string, error) { b, e := json.Marshal(v); return string(b), e }
		text := func(v *string) string {
			if v == nil {
				return ""
			}
			return *v
		}
		extra := []string{text(r.Publication.Abstract), text(r.Publication.Journal)}
		for _, v := range []any{r.Publication, queries, r.Originals, r} {
			x, e := encode(v)
			if e != nil {
				return nil, e
			}
			extra = append(extra, x)
		}
		row["snapshot_extra"] = extra
		rows = append(rows, row)
	}
	return rows, nil
}

func encodeSnapshotCSV(ctx context.Context, rows []map[string]any) ([]byte, error) {
	var b structuredBuffer
	w := csv.NewWriter(&b)
	if e := w.Write(append(append([]string{}, workbookColumns...), snapshotExtraColumns...)); e != nil {
		return nil, e
	}
	for _, row := range rows {
		if e := ctx.Err(); e != nil {
			return nil, e
		}
		var a map[string]any
		if e := json.Unmarshal([]byte(row["metadata"].(string)), &a); e != nil {
			return nil, exportInvalid("Invalid saved metadata")
		}
		links(a)
		values := []string{}
		for _, key := range []string{"SearchId", "Title", "Authors", "Year", "Pmid", "Pmcid", "Doi", "OriginalUri", "PmcUri", "DoiUri"} {
			values = append(values, csvSafe(articleString(a, key)))
		}
		for _, key := range []string{"state", "reason", "rights_uri", "original_hash", "source_uri", "repository_stamp", "format", "version", "bytes", "run_ids"} {
			v := ""
			if row[key] != nil {
				v = fmt.Sprint(row[key])
			}
			values = append(values, csvSafe(v))
		}
		values = append(values, "", csvSafe(articleString(a, "DoiLinkState")))
		for _, x := range row["snapshot_extra"].([]string) {
			values = append(values, csvSafe(x))
		}
		if e := w.Write(values); e != nil {
			return nil, e
		}
	}
	w.Flush()
	return b.Bytes(), w.Error()
}

func (s *server) snapshotMetadata(ctx context.Context, library, plan, format string) ([]byte, error) {
	if !s.savedSnapshots {
		return nil, planConflict("Saved snapshots require the supported migration.")
	}
	tx, e := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	d, e := loadResearchSnapshot(ctx, tx, library, plan)
	if e != nil {
		return nil, e
	}
	var data []byte
	switch format {
	case "json", "jsonl":
		data, e = encodeStructured(ctx, d.Research, format)
	case "csv", "xlsx":
		var rows []map[string]any
		rows, e = snapshotRows(d)
		if e == nil {
			if format == "csv" {
				data, e = encodeSnapshotCSV(ctx, rows)
			} else {
				data, e = encodeWorkbook(ctx, rows, "", "", snapshotExtraColumns...)
			}
		}
	default:
		return nil, &planError{400, "Choose JSON, JSONL, CSV or XLSX saved snapshot metadata."}
	}
	if e != nil {
		return nil, e
	}
	return data, tx.Commit(ctx)
}

func (s *server) snapshotMetadataHTTP(w http.ResponseWriter, r *http.Request, ctx context.Context, library, plan string) {
	var input struct {
		Format string `json:"format"`
	}
	if !decode(w, r, &input) {
		return
	}
	data, e := s.snapshotMetadata(ctx, library, plan, input.Format)
	if e != nil {
		planReply(w, nil, e)
		return
	}
	media := map[string]string{"json": "application/json; charset=utf-8", "jsonl": "application/x-ndjson; charset=utf-8", "csv": "text/csv; charset=utf-8", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}[input.Format]
	release, ok := s.snapshotResponseAdmission(w, r, ctx, library)
	if !ok {
		return
	}
	defer release()
	w.Header().Set("Content-Type", media)
	w.Header().Set("Content-Disposition", "attachment; filename=\"litradock-saved-research."+input.Format+"\"")
	_, _ = w.Write(data)
}
