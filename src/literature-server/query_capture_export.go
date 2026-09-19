package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const captureExportBytes = 8 << 20
const captureArchiveBytes = 64 << 20

type captureExportFile struct {
	Name   string `json:"name"`
	Offset int    `json:"offset"`
	Count  int    `json:"count"`
	SHA256 string `json:"sha256"`
}

type captureMember struct {
	PMID        string  `json:"pmid"`
	Ordinal     int     `json:"ordinal"`
	State       string  `json:"metadataState"`
	SearchID    *string `json:"searchId"`
	URL         string  `json:"pubmedUrl"`
	Segment     int     `json:"segment"`
	SegmentRank int     `json:"segmentRank"`
}

type captureStageExport struct {
	Segment       int              `json:"segment"`
	ProviderTotal int              `json:"providerTotal"`
	Returned      int              `json:"returnedCount"`
	Added         int              `json:"addedCount"`
	Disposition   string           `json:"disposition"`
	Provenance    *routeProvenance `json:"provenance"`
}

type captureExportPart struct {
	Schema               string                `json:"schema"`
	Version              int                   `json:"schemaVersion"`
	Type                 string                `json:"type"`
	RunID                string                `json:"runId"`
	OriginalQuery        string                `json:"originalQuery"`
	InitialProviderTotal int                   `json:"initialProviderTotal"`
	InitialProvenance    *routeProvenance      `json:"initialQueryProvenance"`
	Scope                string                `json:"scope"`
	SelectionRevision    int                   `json:"selectionRevision"`
	CaptureRevision      int                   `json:"captureRevision"`
	SavedCount           int                   `json:"savedCount"`
	CapturedCount        int                   `json:"capturedCount"`
	ProcessedCount       int                   `json:"processedCount"`
	MissingCount         int                   `json:"missingCount"`
	ScopeCount           int                   `json:"scopeCount"`
	Offset               int                   `json:"offset"`
	Count                int                   `json:"count"`
	Remaining            int                   `json:"remaining"`
	Complete             bool                  `json:"complete"`
	Order                string                `json:"order"`
	Coverage             *queryCaptureView     `json:"capture"`
	Members              []captureMember       `json:"capturedIdentities,omitempty"`
	Stages               []captureStageExport  `json:"stages,omitempty"`
	Pending              []captureSegment      `json:"pendingSegments,omitempty"`
	Records              []captureExportRecord `json:"records,omitempty"`
	Files                []captureExportFile   `json:"files,omitempty"`
}

type captureExportRecord struct {
	structuredRecord
	Membership           captureMember    `json:"membership"`
	MembershipProvenance *routeProvenance `json:"membershipProvenance,omitempty"`
}

func captureStageProvenance(raw, hash, translation string, received time.Time) (*routeProvenance, error) {
	var descriptor userRouteDescriptor
	if json.Unmarshal([]byte(raw), &descriptor) != nil || descriptor.CaptureSegment < 1 || descriptor.Stage != "esearch" {
		return nil, errors.New("invalid captured provenance descriptor")
	}
	p := map[string]any{"Execution": userRouteExecution, "Verification": userRouteVerification, "SourceClaim": "pubmed", "ResponseSHA256": hash, "ReceivedAt": received.UTC().Format(time.RFC3339Nano), "SubmittedQuery": descriptor.Parameters["term"], "Translation": translation}
	return checkedRouteProvenance(p, true)
}

func (s *server) captureExportSnapshot(ctx context.Context, library, run, scope string, revision, captureRevision, offset, limit int, manifest bool, shared ...pgx.Tx) (captureExportPart, []map[string]any, error) {
	d := captureExportPart{Schema: "litradock.staged-query-export", Version: 1, Type: "manifest", RunID: run, Scope: scope, Offset: offset, Order: "initial_then_segment"}
	if !s.stagedQuery || !runIDPattern.MatchString(run) || (!manifest && (scope != "all" && scope != "selected" || revision < 1 || captureRevision < 1 || offset < 0 || limit < 1 || limit > 1000)) {
		return d, nil, &planError{400, "Choose one saved run, exact revisions and a metadata part of 1–1000 records."}
	}
	var tx pgx.Tx
	var err error
	finish := func() error { return nil }
	if len(shared) > 0 {
		tx = shared[0]
	} else {
		tx, err = s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
		if err != nil {
			return d, nil, err
		}
		defer tx.Rollback(context.Background())
		finish = func() error { return tx.Commit(ctx) }
	}
	if err = snapshotAdmission(ctx, tx, library); err != nil {
		return d, nil, err
	}
	selection, err := s.selectionStateFrom(ctx, tx, library, run)
	if err != nil {
		return d, nil, err
	}
	var snapshot, idsRaw, missingRaw string
	var frozen bool
	err = tx.QueryRow(ctx, `SELECT r.input,r.total,r.snapshot,w.revision,w.ids,w.next_offset,w.missing,w.frozen
FROM ld_runs r JOIN native_search_windows w USING(library_id,run_id) WHERE r.library_id=$1 AND r.run_id=$2`, library, run).Scan(&d.OriginalQuery, &d.InitialProviderTotal, &snapshot, &d.CaptureRevision, &idsRaw, &d.ProcessedCount, &missingRaw, &frozen)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, nil, &planError{404, "Saved captured query not found."}
	}
	if err != nil {
		return d, nil, err
	}
	if !frozen {
		return d, nil, &planError{409, "Initial query membership is not saved yet."}
	}
	d.SelectionRevision, d.SavedCount = selection.Revision, selection.SavedCount
	if !manifest && (revision != selection.Revision || captureRevision != d.CaptureRevision) {
		return d, nil, &planError{409, "Selection, saved records or capture progress changed. Reload before exporting a part."}
	}
	var ids, missing []string
	if json.Unmarshal([]byte(idsRaw), &ids) != nil || !validWindowIDs(ids) || json.Unmarshal([]byte(missingRaw), &missing) != nil || d.ProcessedCount < 0 || d.ProcessedCount > len(ids) || len(missing)+selection.SavedCount != d.ProcessedCount {
		return d, nil, errors.New("inconsistent captured export membership")
	}
	d.CapturedCount, d.MissingCount = len(ids), len(missing)
	d.InitialProvenance, err = queryRouteProvenance(snapshot)
	if err != nil {
		return d, nil, err
	}
	p, err := readCapturePlan(ctx, tx, library, run)
	if err != nil {
		return d, nil, err
	}
	w, err := s.continuationStatusFrom(ctx, tx, library, run)
	if err != nil {
		return d, nil, err
	}
	if w != nil {
		d.Coverage = w.Capture
	}
	stageBySegment := map[int]*routeProvenance{}
	if p != nil {
		d.Pending = append([]captureSegment{}, p.Frontier...)
		// 來源轉譯可比 PMID 清單大；先在資料庫檢查總量，避免分頁匯出
		// 為了附帶來源證據而載入不成比例的文字。原始證據仍完整保留。
		var provenanceBytes int64
		if err = tx.QueryRow(ctx, `SELECT COALESCE(sum(octet_length(c.translation)+octet_length(a.descriptor)),0)
FROM native_query_capture_stages c JOIN native_user_route_attempts a ON a.library_id=c.library_id AND a.request_id=c.attempt_id
WHERE c.library_id=$1 AND c.run_id=$2`, library, run).Scan(&provenanceBytes); err != nil {
			return d, nil, err
		}
		if provenanceBytes > 2<<20 {
			return d, nil, &planError{413, "Capture provenance exceeds the 2 MiB export bound. Saved evidence is retained; no incomplete manifest was returned."}
		}
		rows, e := tx.Query(ctx, `SELECT c.segment,c.provider_total,c.returned_count,c.added_count,c.disposition,c.translation,c.received_at,a.descriptor,a.body_sha256
FROM native_query_capture_stages c JOIN native_user_route_attempts a ON a.library_id=c.library_id AND a.request_id=c.attempt_id
WHERE c.library_id=$1 AND c.run_id=$2 ORDER BY c.received_at,c.segment LIMIT 257`, library, run)
		if e != nil {
			return d, nil, e
		}
		for rows.Next() {
			var stage captureStageExport
			var translation, descriptor, hash string
			var received time.Time
			if err = rows.Scan(&stage.Segment, &stage.ProviderTotal, &stage.Returned, &stage.Added, &stage.Disposition, &translation, &received, &descriptor, &hash); err != nil {
				break
			}
			stage.Provenance, err = captureStageProvenance(descriptor, hash, translation, received)
			if err != nil {
				break
			}
			stageBySegment[stage.Segment] = stage.Provenance
			d.Stages = append(d.Stages, stage)
		}
		rows.Close()
		if err != nil {
			return d, nil, err
		}
		if err = rows.Err(); err != nil {
			return d, nil, err
		}
		if len(d.Stages) > captureRequestLimit {
			return d, nil, errors.New("capture stage export bound exceeded")
		}
	}
	if manifest {
		d.Scope = "captured_identities"
		d.ScopeCount, d.Count, d.Complete = len(ids), len(ids), true
		rows, e := tx.Query(ctx, `SELECT x.rank,x.search_id,(r.metadata::jsonb->>'Pmid') FROM ld_results x JOIN ld_records r USING(library_id,search_id) WHERE x.library_id=$1 AND x.run_id=$2 ORDER BY x.rank LIMIT 20001`, library, run)
		if e != nil {
			return d, nil, e
		}
		savedIDs := map[int]string{}
		for rows.Next() {
			var rank int
			var id, pmid string
			if err = rows.Scan(&rank, &id, &pmid); err != nil {
				break
			}
			if rank < 1 || rank > len(ids) || ids[rank-1] != pmid || savedIDs[rank] != "" {
				err = errors.New("saved metadata does not match captured ordering")
				break
			}
			savedIDs[rank] = id
		}
		rows.Close()
		if err != nil {
			return d, nil, err
		}
		if err = rows.Err(); err != nil {
			return d, nil, err
		}
		if len(savedIDs) != selection.SavedCount {
			return d, nil, errors.New("saved metadata count changed")
		}
		membership := map[int]captureMember{}
		if p != nil {
			rows, e = tx.Query(ctx, "SELECT pmid,ordinal,segment,segment_rank FROM native_query_capture_members WHERE library_id=$1 AND run_id=$2 ORDER BY ordinal LIMIT 20001", library, run)
			if e != nil {
				return d, nil, e
			}
			for rows.Next() {
				var member captureMember
				if err = rows.Scan(&member.PMID, &member.Ordinal, &member.Segment, &member.SegmentRank); err != nil {
					break
				}
				if member.Ordinal < 1 || member.Ordinal > len(ids) || ids[member.Ordinal-1] != member.PMID {
					err = errors.New("capture member identity mismatch")
					break
				}
				membership[member.Ordinal] = member
			}
			rows.Close()
			if err != nil {
				return d, nil, err
			}
			if err = rows.Err(); err != nil {
				return d, nil, err
			}
			if len(membership) != len(ids) {
				return d, nil, errors.New("capture membership count mismatch")
			}
		}
		for index, id := range ids {
			member := membership[index+1]
			if p == nil {
				member = captureMember{PMID: id, Ordinal: index + 1, SegmentRank: index + 1}
			}
			member.URL = "https://pubmed.ncbi.nlm.nih.gov/" + id + "/"
			member.State = "pending"
			if index < d.ProcessedCount {
				member.State = "missing"
			}
			if savedIDs[index+1] != "" {
				member.State = "saved"
				member.SearchID = optionalText(savedIDs[index+1])
			}
			d.Members = append(d.Members, member)
		}
		return d, nil, finish()
	}
	d.ScopeCount = selection.SavedCount
	if scope == "selected" {
		d.ScopeCount = selection.SelectedCount
	}
	if offset >= d.ScopeCount {
		return d, nil, &planError{409, "This metadata part is empty; no incomplete file was returned."}
	}
	d.Count = min(limit, d.ScopeCount-offset)
	d.Remaining = d.ScopeCount - offset - d.Count
	d.Complete = offset == 0 && d.Remaining == 0
	from := ` FROM ld_records r JOIN ld_results x USING(library_id,search_id) WHERE x.library_id=$1 AND x.run_id=$2`
	args := []any{library, run}
	if scope == "selected" {
		from += " AND x.search_id=ANY($3::text[])"
		args = append(args, selection.SelectedIDs)
	}
	// 先以資料庫大小預檢限制單一匯出頁；格式轉換不應先把整份研究庫載入記憶體。
	base := `SELECT x.search_id,(r.metadata::jsonb-'RawXml'-'FullTextMetadataXml')::text AS metadata,x.rank` + from + fmt.Sprintf(" ORDER BY x.rank,x.search_id LIMIT %d OFFSET %d", d.Count, offset)
	var metadataBytes int64
	if err = tx.QueryRow(ctx, "SELECT COALESCE(sum(octet_length(metadata)),0) FROM ("+base+") p", args...).Scan(&metadataBytes); err != nil {
		return d, nil, err
	}
	if metadataBytes > 4<<20 {
		return d, nil, &planError{413, "This metadata part exceeds 4 MiB. Choose fewer records; no values or records were truncated."}
	}
	rows, err := tx.Query(ctx, base, args...)
	if err != nil {
		return d, nil, err
	}
	type savedRow struct {
		id, raw string
		rank    int
	}
	loaded := []savedRow{}
	for rows.Next() {
		var row savedRow
		if err = rows.Scan(&row.id, &row.raw, &row.rank); err != nil {
			break
		}
		loaded = append(loaded, row)
	}
	rows.Close()
	if err != nil {
		return d, nil, err
	}
	if err = rows.Err(); err != nil {
		return d, nil, err
	}
	if len(loaded) != d.Count {
		return d, nil, errors.New("export part membership count mismatch")
	}
	membersByRank := map[int]captureMember{}
	if p != nil {
		ranks := []int{}
		for _, row := range loaded {
			ranks = append(ranks, row.rank)
		}
		members, e := tx.Query(ctx, "SELECT pmid,ordinal,segment,segment_rank FROM native_query_capture_members WHERE library_id=$1 AND run_id=$2 AND ordinal=ANY($3::int[])", library, run, ranks)
		if e != nil {
			return d, nil, e
		}
		for members.Next() {
			var member captureMember
			if err = members.Scan(&member.PMID, &member.Ordinal, &member.Segment, &member.SegmentRank); err != nil {
				break
			}
			membersByRank[member.Ordinal] = member
		}
		members.Close()
		if err != nil {
			return d, nil, err
		}
		if err = members.Err(); err != nil {
			return d, nil, err
		}
		if len(membersByRank) != len(loaded) {
			return d, nil, errors.New("export capture membership missing")
		}
	}
	result := []map[string]any{}
	recordIDs := []string{}
	partBytes := metadataBytes
	for _, row := range loaded {
		record, e := structuredArticle(row.id, row.raw)
		if e != nil {
			return d, nil, e
		}
		if row.rank < 1 || row.rank > len(ids) || record.IDs.PMID == nil || *record.IDs.PMID != ids[row.rank-1] {
			return d, nil, errors.New("export part identity does not match captured order")
		}
		record.RunIDs = []string{run}
		member := captureMember{PMID: ids[row.rank-1], Ordinal: row.rank, State: "saved", SearchID: optionalText(row.id), URL: "https://pubmed.ncbi.nlm.nih.gov/" + ids[row.rank-1] + "/", SegmentRank: row.rank}
		if p != nil {
			observed := membersByRank[row.rank]
			if observed.PMID != member.PMID {
				return d, nil, errors.New("export capture identity changed")
			}
			member.Segment, member.SegmentRank = observed.Segment, observed.SegmentRank
		}
		provenance := d.InitialProvenance
		if member.Segment > 0 {
			provenance = stageBySegment[member.Segment]
			if provenance == nil {
				return d, nil, errors.New("captured member provenance missing")
			}
		}
		d.Records = append(d.Records, captureExportRecord{record, member, provenance})
		memberProvenance := ""
		if provenance != nil {
			encoded, _ := json.Marshal(provenance)
			memberProvenance = string(encoded)
		}
		// CSV/XLSX 另有逐欄來源資訊，保守計入三次來源文字以限制編碼
		// 前的記憶體；較小的明確分頁仍可匯出相同原始內容。
		partBytes += int64(3*len(memberProvenance) + len(d.OriginalQuery))
		if partBytes > 4<<20 {
			return d, nil, &planError{413, "Metadata and provenance exceed the 4 MiB part bound. Choose fewer records; no values were truncated."}
		}
		extra := []string{scope, strconv.Itoa(d.SelectionRevision), strconv.Itoa(d.CaptureRevision), strconv.Itoa(d.ScopeCount), strconv.Itoa(offset), strconv.Itoa(d.Count), strconv.Itoa(d.Remaining), d.OriginalQuery, strconv.Itoa(member.Ordinal), strconv.Itoa(member.Segment), strconv.Itoa(member.SegmentRank), memberProvenance}
		result = append(result, map[string]any{"metadata": row.raw, "run_ids": run, "batch_id": "", "snapshot_extra": extra, "queryRouteProvenance": provenance})
		recordIDs = append(recordIDs, row.id)
	}
	outcomes, err := sourceHistory(ctx, tx, library, recordIDs, "pdf")
	if err != nil {
		return d, nil, err
	}
	for index, id := range recordIDs {
		result[index]["sourceOutcome"] = outcomes[id]
		outcome := outcomes[id]
		d.Records[index].SourceOutcome = &outcome
	}
	return d, result, finish()
}

type captureArchiveBuffer struct{ bytes.Buffer }

func (b *captureArchiveBuffer) Write(p []byte) (int, error) {
	if len(p) > captureArchiveBytes-b.Len() {
		return 0, &planError{413, "The metadata archive exceeds 64 MiB. Use smaller explicit scopes; no partial archive was returned."}
	}
	return b.Buffer.Write(p)
}

// 以同一個 Repeatable Read 快照逐頁編碼，ZIP 不需要把所有文章或工作簿
// 同時載入記憶體。任何頁面失敗都在傳送標頭前放棄整份輸出。
func (s *server) captureArchive(ctx context.Context, library, run, scope, format string, revision, captureRevision, limit int) ([]byte, captureExportPart, error) {
	var info captureExportPart
	if (scope != "all" && scope != "selected") || revision < 1 || captureRevision < 1 || limit < 1 || limit > 1000 || !slicesContainsExport(format) {
		return nil, info, &planError{400, "Choose a supported archive format, exact revisions and part size 1–1000."}
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return nil, info, err
	}
	defer tx.Rollback(context.Background())
	info, _, err = s.captureExportSnapshot(ctx, library, run, scope, revision, captureRevision, 0, limit, true, tx)
	if err != nil {
		return nil, info, err
	}
	if info.SelectionRevision != revision || info.CaptureRevision != captureRevision {
		return nil, info, &planError{409, "Selection or capture progress changed. Reload before exporting the archive."}
	}
	selection, err := s.selectionStateFrom(ctx, tx, library, run)
	if err != nil {
		return nil, info, err
	}
	info.ScopeCount = selection.SavedCount
	if scope == "selected" {
		info.ScopeCount = selection.SelectedCount
		selected := make(map[string]bool, len(selection.SelectedIDs))
		for _, id := range selection.SelectedIDs {
			selected[id] = true
		}
		members := []captureMember{}
		for _, member := range info.Members {
			if member.SearchID != nil && selected[*member.SearchID] {
				members = append(members, member)
			}
		}
		info.Members = members
	}
	if info.ScopeCount < 1 {
		return nil, info, &planError{409, "No saved metadata belongs to this export scope."}
	}
	info.Scope, info.Count, info.Offset, info.Remaining, info.Complete = scope, info.ScopeCount, 0, 0, true
	var output captureArchiveBuffer
	archive := zip.NewWriter(&output)
	for offset := 0; offset < info.ScopeCount; offset += limit {
		if err = ctx.Err(); err != nil {
			return nil, info, err
		}
		part, rows, e := s.captureExportSnapshot(ctx, library, run, scope, revision, captureRevision, offset, limit, false, tx)
		if e != nil {
			return nil, info, e
		}
		data, _, e := encodeCapturePart(ctx, part, rows, format)
		if e != nil {
			return nil, info, e
		}
		name := fmt.Sprintf("metadata-%05d.%s", offset/limit+1, format)
		member, e := archive.Create(name)
		if e != nil {
			return nil, info, e
		}
		if _, e = member.Write(data); e != nil {
			return nil, info, e
		}
		hash := sha256.Sum256(data)
		info.Files = append(info.Files, captureExportFile{name, offset, part.Count, hex.EncodeToString(hash[:])})
	}
	manifest, _, err := encodeCapturePart(ctx, info, nil, "manifest")
	if err != nil {
		return nil, info, err
	}
	member, err := archive.Create("manifest.json")
	if err != nil {
		return nil, info, err
	}
	if _, err = member.Write(manifest); err != nil {
		return nil, info, err
	}
	if err = archive.Close(); err != nil {
		return nil, info, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, info, err
	}
	return output.Bytes(), info, nil
}

func slicesContainsExport(format string) bool {
	return format == "csv" || format == "xlsx" || format == "json" || format == "jsonl"
}

var captureExportColumns = []string{"Export scope", "Selection revision", "Capture revision", "Full scope count", "Part offset", "Part count", "Remaining count", "Original query", "Captured ordinal", "Capture segment", "Segment rank", "Membership provenance (JSON)"}

func encodeCapturePart(ctx context.Context, d captureExportPart, rows []map[string]any, format string) ([]byte, string, error) {
	var data []byte
	var err error
	media := "application/json"
	switch format {
	case "manifest", "json":
		data, err = json.Marshal(d)
	case "jsonl":
		var b bytes.Buffer
		records := d.Records
		d.Records = nil
		encoder := json.NewEncoder(&b)
		err = encoder.Encode(d)
		for _, record := range records {
			if err != nil {
				break
			}
			if ctx.Err() != nil {
				err = ctx.Err()
				break
			}
			err = encoder.Encode(record)
			if b.Len() > captureExportBytes {
				err = &planError{413, "This JSONL part exceeds 8 MiB. Choose fewer records; no partial file was returned."}
				break
			}
		}
		data = b.Bytes()
		media = "application/x-ndjson"
	case "csv":
		data, err = encodeRecordCSV(ctx, rows, captureExportColumns...)
		media = "text/csv; charset=utf-8"
	case "xlsx":
		data, err = encodeWorkbook(ctx, rows, d.RunID, "", captureExportColumns...)
		media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	default:
		err = &planError{400, "Supported parts are CSV, XLSX, JSON, JSONL or the captured-ID manifest."}
	}
	if err != nil {
		var stated *planError
		if (format == "csv" || format == "xlsx") && ctx.Err() == nil && !errors.As(err, &stated) {
			return nil, "", &planError{422, "This format cannot represent the metadata part within its text or byte limits. Choose fewer records or JSON; no partial file was returned."}
		}
		return nil, "", err
	}
	if len(data) > captureExportBytes {
		return nil, "", &planError{413, "This export exceeds 8 MiB. Choose a smaller metadata part; nothing was truncated."}
	}
	return data, media, nil
}

func (s *server) queryCaptureExportRoute(w http.ResponseWriter, r *http.Request, ctx context.Context, library string, parts []string) bool {
	if len(parts) != 6 || parts[3] != "runs" || parts[5] != "capture-export" {
		return false
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		reply(w, 405, nil)
		return true
	}
	q := r.URL.Query()
	format := q.Get("format")
	manifest := format == "manifest"
	// 不接受重複或未知參數，避免檢視/下載端對同一份範圍有不同解讀。
	for key, values := range q {
		if !strings.Contains("|format|scope|revision|captureRevision|offset|limit|", "|"+key+"|") || len(values) != 1 {
			runSelectionReply(w, nil, &planError{400, "Invalid export parameters."})
			return true
		}
	}
	parse := func(key string, def int) (int, error) {
		value := q.Get(key)
		if value == "" {
			return def, nil
		}
		n, e := strconv.Atoi(value)
		if e != nil || n < 0 {
			return 0, errors.New("invalid numeric export parameter")
		}
		return n, nil
	}
	values := map[string]int{}
	for _, key := range []string{"revision", "captureRevision", "offset", "limit"} {
		def := 0
		if key == "limit" {
			def = 100
		}
		n, e := parse(key, def)
		if e != nil {
			runSelectionReply(w, nil, &planError{400, "Invalid export bounds."})
			return true
		}
		values[key] = n
	}
	var d captureExportPart
	var rows []map[string]any
	var err error
	var data []byte
	var media string
	if strings.HasPrefix(format, "zip-") {
		if values["offset"] != 0 {
			runSelectionReply(w, nil, &planError{400, "Whole metadata archives start at offset zero."})
			return true
		}
		data, d, err = s.captureArchive(ctx, library, parts[4], q.Get("scope"), strings.TrimPrefix(format, "zip-"), values["revision"], values["captureRevision"], values["limit"])
		media = "application/zip"
	} else {
		d, rows, err = s.captureExportSnapshot(ctx, library, parts[4], q.Get("scope"), values["revision"], values["captureRevision"], values["offset"], values["limit"], manifest)
		if err == nil {
			data, media, err = encodeCapturePart(ctx, d, rows, format)
		}
	}
	if err != nil {
		var invalid *exportDataError
		if errors.As(err, &invalid) {
			err = &planError{409, "Metadata cannot be exported without loss. Choose a smaller supported part; no partial file was returned."}
		}
		runSelectionReply(w, nil, err)
		return true
	}
	release, allowed := s.snapshotResponseAdmission(w, r, ctx, library)
	if !allowed {
		return true
	}
	defer release()
	ext := format
	if manifest {
		ext = "json"
	}
	if strings.HasPrefix(format, "zip-") {
		ext = "zip"
	}
	w.Header().Set("Content-Type", media)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"litradock-%s-%d.%s\"", d.Scope, d.Offset, ext))
	for key, value := range map[string]int{"X-LitraDock-Export-Count": d.Count, "X-LitraDock-Scope-Count": d.ScopeCount, "X-LitraDock-Export-Offset": d.Offset, "X-LitraDock-Export-Remaining": d.Remaining, "X-LitraDock-Selection-Revision": d.SelectionRevision, "X-LitraDock-Capture-Revision": d.CaptureRevision} {
		w.Header().Set(key, strconv.Itoa(value))
	}
	w.Header().Set("X-LitraDock-Export-Scope", d.Scope)
	_, _ = w.Write(data)
	return true
}
