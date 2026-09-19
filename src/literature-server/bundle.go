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
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const bundleOriginalLimit = 128 * 1024 * 1024
const bundlePartOriginalLimit = 8 * 1024 * 1024
const bundlePartLimit = 17 * 1024 * 1024
const bundleDocumentLimit = 8 * 1024 * 1024

var bundleIDPattern = regexp.MustCompile(`^BND-[0-9a-f]{32}$`)
var bundleRangePattern = regexp.MustCompile(`^bytes=[0-9]+-[0-9]+$`)

const bundleSchema = `CREATE TABLE native_bundles(
 library_id uuid NOT NULL,plan_id text NOT NULL,snapshot_id text NOT NULL,request_id uuid NOT NULL,
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,document text,
 part_count integer NOT NULL,member_count integer NOT NULL,original_bytes bigint NOT NULL,
 PRIMARY KEY(library_id,snapshot_id),UNIQUE(library_id,request_id),
 FOREIGN KEY(library_id,plan_id) REFERENCES native_plans,
 CHECK(part_count BETWEEN 0 AND 100),CHECK(member_count BETWEEN 1 AND 100),
 CHECK(original_bytes BETWEEN 0 AND 134217728),CHECK(octet_length(document)<=8388608));
INSERT INTO native_schema(version) VALUES(6);`

func migrateBundles(ctx context.Context, tx pgx.Tx, rollback bool) error {
	var version int
	if e := tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); e != nil {
		return e
	}
	if !rollback {
		if version == 6 {
			return nil
		}
		if version != 5 {
			return errors.New("bundle migration requires schema 5")
		}
		_, e := tx.Exec(ctx, bundleSchema)
		return e
	}
	if version != 6 {
		return errors.New("bundle rollback requires schema 6")
	}
	var used bool
	if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM native_bundles)").Scan(&used); e != nil {
		return e
	}
	if used {
		return errors.New("bundle receipts exist; retain compatible schema 6")
	}
	_, e := tx.Exec(ctx, "DROP TABLE native_bundles; DELETE FROM native_schema WHERE version=6")
	return e
}

type bundleFile struct {
	File      string   `json:"file"`
	SHA256    string   `json:"sha256"`
	Format    string   `json:"format"`
	Bytes     int64    `json:"bytes"`
	SearchIDs []string `json:"searchIDs"`
}
type bundlePart struct {
	Number        int          `json:"number"`
	Filename      string       `json:"filename"`
	Bytes         int          `json:"bytes"`
	SHA256        string       `json:"sha256"`
	OriginalBytes int64        `json:"originalBytes"`
	Files         []bundleFile `json:"files"`
}
type bundleDocument struct {
	Schema     string             `json:"schema"`
	Version    int                `json:"schemaVersion"`
	SnapshotID string             `json:"snapshotID"`
	CreatedAt  time.Time          `json:"createdAt"`
	ExpiresAt  time.Time          `json:"expiresAt"`
	PlanID     string             `json:"planID"`
	Manifest   planExportDocument `json:"manifest"`
	Parts      []bundlePart       `json:"parts"`
}
type bundleSummary struct {
	SnapshotID    string    `json:"snapshotID"`
	CreatedAt     time.Time `json:"createdAt"`
	ExpiresAt     time.Time `json:"expiresAt"`
	PlanID        string    `json:"planID"`
	PartCount     int       `json:"partCount"`
	Members       int       `json:"members"`
	OriginalBytes int64     `json:"originalBytes"`
}

func bundleDigest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func bundleError(status int, message string) error {
	return &planError{Status: status, Message: message}
}

// Greedy stable partitioning never splits a source file or loses its aliases.
func partitionBundle(files []bundleFile) ([]bundlePart, error) {
	parts := []bundlePart{}
	var total int64
	for _, f := range files {
		if f.Bytes < 1 || f.Bytes > bundlePartOriginalLimit || len(f.SearchIDs) == 0 {
			return nil, exportInvalid("Invalid bundle original size or membership")
		}
		total += f.Bytes
		if total > bundleOriginalLimit {
			return nil, bundleError(409, "The saved plan exceeds 128 MiB of originals. Use existing smaller child bundles or a smaller saved selection.")
		}
		if len(parts) == 0 || parts[len(parts)-1].OriginalBytes+f.Bytes > bundlePartOriginalLimit {
			n := len(parts) + 1
			parts = append(parts, bundlePart{Number: n, Filename: fmt.Sprintf("litradock-originals-part-%03d.zip", n), Files: []bundleFile{}})
		}
		p := &parts[len(parts)-1]
		p.Files = append(p.Files, f)
		p.OriginalBytes += f.Bytes
	}
	return parts, nil
}

type bundleBuffer struct{ bytes.Buffer }

func (b *bundleBuffer) Write(p []byte) (int, error) {
	if len(p) > bundlePartLimit-b.Len() {
		return 0, exportInvalid("Bundle part output exceeds 17 MiB")
	}
	return b.Buffer.Write(p)
}

func (s *server) buildBundlePart(ctx context.Context, tx pgx.Tx, library string, d bundleDocument, part bundlePart) ([]byte, error) {
	var out bundleBuffer
	z := zip.NewWriter(&out)
	for _, f := range part.Files {
		var content []byte
		for _, id := range f.SearchIDs {
			var item *planExportItem
			for n := range d.Manifest.Items {
				if d.Manifest.Items[n].SearchID == id {
					item = &d.Manifest.Items[n]
					break
				}
			}
			if item == nil || item.Original == nil || item.File == nil || *item.File != f.File || item.Original.SHA256 != f.SHA256 {
				return nil, exportInvalid("Inconsistent frozen file association")
			}
			// Current record identity/rights are checked for every alias, before dedup.
			var rawSize int
			if e := tx.QueryRow(ctx, "SELECT octet_length(metadata) FROM ld_records WHERE library_id=$1 AND search_id=$2", library, id).Scan(&rawSize); e != nil {
				return nil, e
			}
			if rawSize > 4*1024*1024 {
				return nil, exportInvalid("Record metadata exceeds bundle read budget")
			}
			var raw string
			if e := tx.QueryRow(ctx, "SELECT metadata FROM ld_records WHERE library_id=$1 AND search_id=$2", library, id).Scan(&raw); e != nil {
				return nil, e
			}
			b, info, ok, e := s.planOriginal(ctx, tx, library, planItem{SearchID: id, OriginalHash: f.SHA256, raw: raw}, d.Manifest.Plan.RequestedFormat)
			if e != nil {
				return nil, e
			}
			a, _ := json.Marshal(info)
			want, _ := json.Marshal(item.Original)
			if !ok || !bytes.Equal(a, want) || int64(len(b)) != f.Bytes {
				return nil, bundleError(409, "A prepared original is now unavailable or its rights, provenance or bytes changed. No part was returned; prepare a new snapshot to review current reasons.")
			}
			if content == nil {
				content = b
			}
		}
		if content == nil {
			return nil, exportInvalid("Empty bundle original")
		}
		w, e := z.CreateHeader(&zip.FileHeader{Name: f.File, Method: zip.Store})
		if e != nil {
			return nil, e
		}
		if _, e = w.Write(content); e != nil {
			return nil, e
		}
	}
	meta := struct {
		Schema   string           `json:"schema"`
		Version  int              `json:"schemaVersion"`
		Snapshot string           `json:"snapshotID"`
		Number   int              `json:"partNumber"`
		Files    []bundleFile     `json:"files"`
		Members  []planExportItem `json:"members"`
	}{"litradock.bundle-part", 1, d.SnapshotID, part.Number, part.Files, []planExportItem{}}
	ids := map[string]bool{}
	for _, f := range part.Files {
		for _, id := range f.SearchIDs {
			ids[id] = true
		}
	}
	for _, i := range d.Manifest.Items {
		if ids[i.SearchID] {
			meta.Members = append(meta.Members, i)
		}
	}
	b, e := json.Marshal(meta)
	if e != nil {
		return nil, e
	}
	if len(b) > bundleDocumentLimit {
		return nil, exportInvalid("Part manifest limit")
	}
	w, e := z.CreateHeader(&zip.FileHeader{Name: "manifest.json", Method: zip.Store})
	if e != nil {
		return nil, e
	}
	if _, e = w.Write(b); e != nil {
		return nil, e
	}
	if e = z.Close(); e != nil {
		return nil, e
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	return out.Bytes(), nil
}

func (s *server) prepareBundle(ctx context.Context, library, plan, request string) (bundleDocument, error) {
	var empty bundleDocument
	if !uuidPattern.MatchString(request) {
		return empty, bundleError(400, "A request UUID is required.")
	}
	// Lock before beginning repeatable read: no stale quota snapshot after waiting.
	c, e := s.db.Acquire(ctx)
	if e != nil {
		return empty, e
	}
	defer c.Release()
	var locked bool
	if e = c.QueryRow(ctx, "SELECT pg_try_advisory_lock(724913016)").Scan(&locked); e != nil {
		return empty, e
	}
	if !locked {
		return empty, bundleError(429, "Another bundle snapshot is being prepared; retry the same request explicitly.")
	}
	defer func() {
		clean, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, e := c.Exec(clean, "SELECT pg_advisory_unlock(724913016)"); e != nil {
			_ = c.Conn().Close(clean)
		}
	}()
	tx, e := c.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return empty, e
	}
	defer tx.Rollback(context.Background())
	var oldPlan string
	var oldDoc *string
	var expiry time.Time
	e = tx.QueryRow(ctx, "SELECT plan_id,document,expires_at FROM native_bundles WHERE library_id=$1 AND request_id=$2", library, request).Scan(&oldPlan, &oldDoc, &expiry)
	if e == nil {
		if oldPlan != plan {
			return empty, bundleError(409, "This request UUID belongs to a different saved plan.")
		}
		if oldDoc == nil || !expiry.After(time.Now()) {
			return empty, bundleError(410, "This prepared bundle expired. Prepare a new snapshot with a new request UUID.")
		}
		if e = json.Unmarshal([]byte(*oldDoc), &empty); e != nil {
			return empty, e
		}
		return empty, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return empty, e
	}
	if !s.cfg.BundleDeliveryEnabled {
		return empty, bundleError(409, "New bundle preparation is disabled; existing saved research remains available.")
	}
	if _, e = tx.Exec(ctx, "UPDATE native_bundles SET document=NULL WHERE expires_at<=now() AND document IS NOT NULL"); e != nil {
		return empty, e
	}
	var ledger, active int
	if e = tx.QueryRow(ctx, "SELECT count(*),count(*) FILTER(WHERE library_id=$1 AND plan_id=$2 AND document IS NOT NULL) FROM native_bundles", library, plan).Scan(&ledger, &active); e != nil {
		return empty, e
	}
	if ledger >= 4096 || active >= 20 {
		return empty, bundleError(429, "Prepared-bundle receipt capacity is full. Use an existing snapshot or contact the operator; no new snapshot was created.")
	}
	var rawBudget int64
	if e = tx.QueryRow(ctx, `SELECT COALESCE(sum(octet_length(r.metadata)),0) FROM native_plan_items i JOIN ld_records r ON r.library_id=i.library_id AND r.search_id=i.search_id WHERE i.library_id=$1 AND i.plan_id=$2`, library, plan).Scan(&rawBudget); e != nil {
		return empty, e
	}
	if rawBudget > 4*1024*1024 {
		return empty, bundleError(409, "Saved record metadata exceeds the 4 MiB preparation read budget. Use smaller saved selections; no snapshot was created.")
	}
	p, items, e := s.loadPlan(ctx, tx, library, plan)
	if e != nil {
		return empty, e
	}
	research, e := s.structuredResearchSnapshot(ctx, tx, library, "", "", plan, p.ScopeKind == "saved_set")
	if e != nil {
		return empty, e
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM native_plan_items WHERE library_id=$1 AND plan_id=$2", library, plan).Scan(&count); e != nil {
		return empty, e
	}
	if count != len(items) || count != len(research.Records) || count < 1 || count > 100 {
		return empty, exportInvalid("Incomplete bundle membership")
	}
	now := time.Now().UTC()
	d := bundleDocument{Schema: "litradock.bundle", Version: 1, SnapshotID: "BND-" + strings.ReplaceAll(newUUID(), "-", ""), CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour), PlanID: plan, Manifest: planExportDocument{Schema: "litradock.plan-export", Version: 1, Type: "document", GeneratedAt: research.GeneratedAt, Plan: p, Research: research, Items: []planExportItem{}, Revalidated: true}}
	files := []bundleFile{}
	index := map[string]int{}
	included, total := 0, 0
	for n, i := range items {
		if i.Rank != n+1 || i.SearchID != research.Records[n].SearchID {
			return empty, exportInvalid("Bundle membership order changed")
		}
		d.Manifest.Research.Records[n].Acquisition = structuredAcquisition{i.AcquisitionState, optionalText(i.Reason), optionalText(p.RequestedFormat)}
		entry := planExportItem{SearchID: i.SearchID, Rank: i.Rank, ChildBatchID: i.ChildBatchID, AcquisitionState: i.AcquisitionState, Phase: i.Phase, Reason: i.Reason, OriginalHash: optionalText(i.OriginalHash), Availability: "not_acquired", AvailabilityReason: optionalText(i.Reason)}
		if i.AcquisitionState != nil && *i.AcquisitionState == "acquired" {
			b, info, ok, e := s.planOriginal(ctx, tx, library, i, p.RequestedFormat)
			if e != nil {
				return empty, e
			}
			entry.Availability = "unavailable"
			entry.AvailabilityReason = optionalText("Original is missing, restricted, or failed current rights/integrity validation. Open the record source links.")
			if ok {
				name := "originals/" + info.SHA256 + "." + strings.ToLower(info.Format)
				if at, exists := index[name]; exists {
					files[at].SearchIDs = append(files[at].SearchIDs, i.SearchID)
				} else {
					index[name] = len(files)
					files = append(files, bundleFile{name, info.SHA256, info.Format, int64(len(b)), []string{i.SearchID}})
					total += len(b)
				}
				if total > bundleOriginalLimit {
					return empty, bundleError(409, "The plan exceeds 128 MiB of unique originals. Use smaller saved selections or child bundles.")
				}
				included++
				entry.Availability = "included"
				entry.AvailabilityReason = nil
				entry.File = &name
				entry.Original = &info
			}
		}
		if entry.Availability != "included" && entry.AvailabilityReason == nil {
			entry.AvailabilityReason = optionalText("No original acquired in this snapshot. Review the saved state and source links.")
		}
		outcome := describeSource(p.RequestedFormat, sourceText(i.AcquisitionState), i.Reason, false, true, entry.Availability == "included", sourceArticle(research.Records[n]))
		entry.SourceOutcome = &outcome
		d.Manifest.Research.Records[n].SourceOutcome = &outcome
		d.Manifest.Items = append(d.Manifest.Items, entry)
	}
	unresolved, unique := count-included, len(files)
	d.Manifest.Counts = planExportCounts{count, &included, &unresolved, &unique, &total}
	d.Parts, e = partitionBundle(files)
	if e != nil {
		return empty, e
	}
	for n := range d.Parts {
		b, e := s.buildBundlePart(ctx, tx, library, d, d.Parts[n])
		if e != nil {
			return empty, e
		}
		d.Parts[n].Bytes = len(b)
		d.Parts[n].SHA256 = bundleDigest(b)
	}
	encoded, e := json.Marshal(d)
	if e != nil {
		return empty, e
	}
	if len(encoded) > bundleDocumentLimit {
		return empty, exportInvalid("Bundle metadata exceeds 8 MiB")
	}
	var global, local int64
	if e = tx.QueryRow(ctx, "SELECT COALESCE(sum(octet_length(document)),0),COALESCE(sum(octet_length(document)) FILTER(WHERE library_id=$1),0) FROM native_bundles", library).Scan(&global, &local); e != nil {
		return empty, e
	}
	if global+int64(len(encoded)) > 64*1024*1024 || local+int64(len(encoded)) > 16*1024*1024 {
		return empty, bundleError(429, "Prepared metadata storage is full; existing snapshots remain intact. Retry after expiration or contact the operator.")
	}
	_, e = tx.Exec(ctx, "INSERT INTO native_bundles(library_id,plan_id,snapshot_id,request_id,created_at,expires_at,document,part_count,member_count,original_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", library, plan, d.SnapshotID, request, d.CreatedAt, d.ExpiresAt, string(encoded), len(d.Parts), count, total)
	if e != nil {
		return empty, e
	}
	if e = tx.Commit(ctx); e != nil {
		return empty, e
	}
	return d, nil
}

func loadBundle(ctx context.Context, tx pgx.Tx, library, plan, id string) (bundleDocument, error) {
	var d bundleDocument
	var doc *string
	var expires time.Time
	e := tx.QueryRow(ctx, "SELECT document,expires_at FROM native_bundles WHERE library_id=$1 AND plan_id=$2 AND snapshot_id=$3", library, plan, id).Scan(&doc, &expires)
	if e != nil {
		return d, e
	}
	if doc == nil || !expires.After(time.Now()) {
		return d, bundleError(410, "Prepared bundle expired; its original research remains saved. Prepare a new snapshot explicitly.")
	}
	if len(*doc) > bundleDocumentLimit {
		return d, exportInvalid("Bundle document size")
	}
	if e = json.Unmarshal([]byte(*doc), &d); e != nil {
		return d, e
	}
	if d.Schema != "litradock.bundle" || d.Version != 1 || d.SnapshotID != id || d.PlanID != plan {
		return d, exportInvalid("Bundle identity mismatch")
	}
	return d, nil
}

// Require a single explicit bounded range and validator for resumable reads.
func bundleRange(header, match, etag string, size int) (int, int, int) {
	if match != "" && match != etag {
		return 0, 0, 412
	}
	if header == "" {
		return 0, size, 200
	}
	if match != etag {
		return 0, 0, 412
	}
	if !bundleRangePattern.MatchString(header) {
		return 0, 0, 416
	}
	a := strings.Split(strings.TrimPrefix(header, "bytes="), "-")
	if len(a) != 2 || a[0] == "" || a[1] == "" {
		return 0, 0, 416
	}
	start, e1 := strconv.Atoi(a[0])
	end, e2 := strconv.Atoi(a[1])
	if e1 != nil || e2 != nil || start < 0 || end < start || start >= size || end >= size {
		return 0, 0, 416
	}
	return start, end + 1, 206
}

func (s *server) bundleRoutes(w http.ResponseWriter, r *http.Request, ctx context.Context, library, plan string, parts []string) {
	if !s.bundles {
		reply(w, 404, nil)
		return
	}
	if len(parts) == 6 && r.Method == "POST" {
		var input struct {
			RequestID string `json:"requestID"`
		}
		if !decode(w, r, &input) {
			return
		}
		if !s.admitBundle(w) {
			return
		}
		defer s.bundleBusy.Store(false)
		d, e := s.prepareBundle(ctx, library, plan, input.RequestID)
		if e == nil && !s.bundleSessionCurrent(w, r, ctx, library) {
			return
		}
		bundleReply(w, d, e)
		return
	}
	if r.Method != "GET" {
		reply(w, 404, nil)
		return
	}
	if len(parts) == 6 {
		var exists bool
		if e := s.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM native_plans WHERE library_id=$1 AND plan_id=$2)", library, plan).Scan(&exists); e != nil {
			bundleReply(w, nil, e)
			return
		}
		if !exists {
			reply(w, 404, nil)
			return
		}
		rows, e := s.db.Query(ctx, "SELECT snapshot_id,created_at,expires_at,plan_id,part_count,member_count,original_bytes FROM native_bundles WHERE library_id=$1 AND plan_id=$2 AND expires_at>now() AND document IS NOT NULL ORDER BY created_at DESC,snapshot_id LIMIT 21", library, plan)
		if e != nil {
			bundleReply(w, nil, e)
			return
		}
		defer rows.Close()
		items := []bundleSummary{}
		for rows.Next() {
			var x bundleSummary
			if e = rows.Scan(&x.SnapshotID, &x.CreatedAt, &x.ExpiresAt, &x.PlanID, &x.PartCount, &x.Members, &x.OriginalBytes); e != nil {
				bundleReply(w, nil, e)
				return
			}
			items = append(items, x)
		}
		if rows.Err() != nil || len(items) > 20 {
			bundleReply(w, nil, exportInvalid("Bundle list bounds"))
			return
		}
		if !s.bundleSessionCurrent(w, r, ctx, library) {
			return
		}
		reply(w, 200, map[string]any{"items": items, "total": len(items)})
		return
	}
	if len(parts) != 7 && !(len(parts) == 9 && parts[7] == "parts") {
		reply(w, 404, nil)
		return
	}
	if !bundleIDPattern.MatchString(parts[6]) {
		reply(w, 404, nil)
		return
	}
	if len(parts) == 9 {
		if len(r.Header.Values("Range")) > 1 {
			reply(w, 416, map[string]string{"error": "Exactly one byte range header is supported."})
			return
		}
		if len(r.Header.Values("If-Match")) > 1 {
			reply(w, 412, map[string]string{"error": "Exactly one matching bundle validator is required."})
			return
		}
		if !s.admitBundle(w) {
			return
		}
		defer s.bundleBusy.Store(false)
	}
	tx, e := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		bundleReply(w, nil, e)
		return
	}
	defer tx.Rollback(context.Background())
	d, e := loadBundle(ctx, tx, library, plan, parts[6])
	if e != nil {
		bundleReply(w, nil, e)
		return
	}
	if len(parts) == 7 {
		if !s.bundleSessionCurrent(w, r, ctx, library) {
			return
		}
		w.Header().Set("Content-Disposition", "attachment; filename=\"litradock-bundle-manifest.json\"")
		reply(w, 200, d)
		return
	}
	n, e := strconv.Atoi(parts[8])
	if e != nil || n < 1 || n > len(d.Parts) {
		reply(w, 404, nil)
		return
	}
	part := d.Parts[n-1]
	etag := "\"" + part.SHA256 + "\""
	start, end, status := bundleRange(r.Header.Get("Range"), r.Header.Get("If-Match"), etag, part.Bytes)
	if status >= 400 {
		if status == 416 {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", part.Bytes))
		}
		reply(w, status, map[string]string{"error": "Invalid resume range or mismatched bundle checksum."})
		return
	}
	b, e := s.buildBundlePart(ctx, tx, library, d, part)
	if e != nil {
		bundleReply(w, nil, e)
		return
	}
	if len(b) != part.Bytes || bundleDigest(b) != part.SHA256 {
		bundleReply(w, nil, bundleError(409, "Prepared part bytes changed; no partial or replacement file was returned."))
		return
	}
	if e = ctx.Err(); e != nil {
		bundleReply(w, nil, e)
		return
	}
	if !s.bundleSessionCurrent(w, r, ctx, library) {
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", part.Filename))
	w.Header().Set("ETag", etag)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.Itoa(end-start))
	if status == 206 {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end-1, len(b)))
	}
	w.WriteHeader(status)
	_, _ = w.Write(b[start:end])
}

func bundleReply(w http.ResponseWriter, v any, e error) {
	var invalid *exportDataError
	if errors.As(e, &invalid) {
		reply(w, 409, map[string]string{"error": "Bundle metadata or bytes exceed the safe limit or are inconsistent. No partial snapshot or part was returned; use existing smaller exports."})
		return
	}
	var pe *planError
	if errors.As(e, &pe) && pe.Status == 429 {
		w.Header().Set("Retry-After", "2")
	}
	planReply(w, v, e)
}

// Revalidate outside the immutable data snapshot immediately before bytes leave.
// Revocation during preparation/build cannot publish a new response body.
func (s *server) bundleSessionCurrent(w http.ResponseWriter, r *http.Request, ctx context.Context, library string) bool {
	cookie, e := r.Cookie(s.cookieName())
	if e != nil {
		reply(w, 401, nil)
		return false
	}
	sess, e := s.authenticate(ctx, cookie.Value)
	if e != nil {
		reply(w, 503, nil)
		return false
	}
	if sess == nil {
		reply(w, 401, nil)
		return false
	}
	var owns bool
	if e = s.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM ld_libraries WHERE library_id=$1 AND owner_id=$2 AND ready)", library, sess.Account).Scan(&owns); e != nil {
		reply(w, 503, nil)
		return false
	}
	if !owns {
		reply(w, 404, nil)
		return false
	}
	return true
}
