package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const planOriginalBytes = 32 * 1024 * 1024
const planZIPBytes = 37 * 1024 * 1024

type planExportItem struct {
	SearchID           string              `json:"searchId"`
	Rank               int                 `json:"rank"`
	ChildBatchID       *string             `json:"childBatchId"`
	AcquisitionState   *string             `json:"acquisitionState"`
	Phase              string              `json:"phase"`
	Reason             string              `json:"reason"`
	OriginalHash       *string             `json:"originalHash"`
	Availability       string              `json:"availability"`
	AvailabilityReason *string             `json:"availabilityReason"`
	File               *string             `json:"file"`
	Original           *structuredOriginal `json:"original"`
}
type planExportCounts struct {
	Members    int  `json:"members"`
	Included   *int `json:"includedRecords"`
	Unresolved *int `json:"unresolvedRecords"`
	Unique     *int `json:"uniqueOriginals"`
	Bytes      *int `json:"originalBytes"`
}
type planExportDocument struct {
	Schema      string             `json:"schema"`
	Version     int                `json:"schemaVersion"`
	Type        string             `json:"type"`
	GeneratedAt time.Time          `json:"generatedAt"`
	Plan        planSummary        `json:"plan"`
	Research    structuredDocument `json:"research"`
	Items       []planExportItem   `json:"items"`
	Revalidated bool               `json:"originalsRevalidated"`
	Counts      planExportCounts   `json:"counts"`
}

// One slot is held through HTTP response writing, shared with legacy child ZIPs.
func (s *server) admitBundle(w http.ResponseWriter) bool {
	if s.bundleBusy.CompareAndSwap(false, true) {
		return true
	}
	w.Header().Set("Retry-After", "2")
	reply(w, 429, map[string]string{"error": "Another original ZIP is being prepared. Retry explicitly after it finishes."})
	return false
}

func (s *server) planExportHTTP(w http.ResponseWriter, r *http.Request, ctx context.Context, library, plan string) {
	var input struct {
		Format string `json:"format"`
	}
	if !decode(w, r, &input) {
		return
	}
	if input.Format != "zip" && input.Format != "json" {
		reply(w, 400, map[string]string{"error": "Choose ZIP originals or JSON metadata for the whole saved plan."})
		return
	}
	if input.Format == "zip" {
		if !s.admitBundle(w) {
			return
		}
		defer s.bundleBusy.Store(false)
	}
	data, err := s.exportPlan(ctx, library, plan, input.Format)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			reply(w, 404, map[string]string{"error": "Plan is unavailable in this library."})
			return
		}
		var invalid *exportDataError
		if errors.As(err, &invalid) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			reply(w, 409, map[string]string{"error": "Plan export unavailable: saved data is inconsistent or the 32 MiB original / 37 MiB ZIP / metadata or time limit was reached. No partial file was returned. Export plan JSON metadata or save existing child bundles and individual originals."})
		} else {
			reply(w, 503, map[string]string{"error": "Plan export service is temporarily unavailable. No partial file was returned; retry explicitly later."})
		}
		return
	}
	media, name := "application/json; charset=utf-8", "litradock-plan.json"
	if input.Format == "zip" {
		media, name = "application/zip", "litradock-plan-originals.zip"
	}
	w.Header().Set("Content-Type", media)
	w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
	_, _ = w.Write(data)
}

type planZIPBuffer struct{ bytes.Buffer }

func (b *planZIPBuffer) Write(p []byte) (int, error) {
	if len(p) > planZIPBytes-b.Len() {
		return 0, exportInvalid("Plan ZIP output limit")
	}
	return b.Buffer.Write(p)
}
func encodePlanDocument(ctx context.Context, d planExportDocument) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var out structuredBuffer
	e := json.NewEncoder(&out)
	e.SetEscapeHTML(false)
	if err := e.Encode(d); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// Snapshot ownership includes plan phases, typed metadata, grants and actual
// bytes. Export does not reserve source requests or mutate scheduler state.
func (s *server) exportPlan(ctx context.Context, library, plan, format string) ([]byte, error) {
	if format != "zip" && format != "json" {
		return nil, exportInvalid("Invalid plan export format")
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())
	p, items, err := s.loadPlan(ctx, tx, library, plan)
	if err != nil {
		return nil, err
	}
	research, err := s.structuredResearchSnapshot(ctx, tx, library, "", "", plan, p.ScopeKind == "saved_set")
	if err != nil {
		return nil, err
	}
	var membership int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM native_plan_items WHERE library_id=$1 AND plan_id=$2", library, plan).Scan(&membership); err != nil {
		return nil, err
	}
	if membership != len(items) || membership != len(research.Records) {
		return nil, exportInvalid("Incomplete plan membership")
	}
	d := planExportDocument{Schema: "litradock.plan-export", Version: 1, Type: "document", GeneratedAt: research.GeneratedAt, Plan: p, Research: research, Items: []planExportItem{}, Revalidated: format == "zip", Counts: planExportCounts{Members: membership}}
	var out planZIPBuffer
	var z *zip.Writer
	included, unique, total, unresolved := 0, 0, 0, 0
	files := map[string]bool{}
	if d.Revalidated {
		// Aggregate unique stored bytes before any original allocation. Each
		// association is still validated below: a hash never transfers a grant.
		var bound int64
		err = tx.QueryRow(ctx, `SELECT COALESCE(sum(n),0) FROM (SELECT o.hash,o.format,max(octet_length(o.content)) n
 FROM native_plan_items m JOIN native_items i ON i.library_id=m.library_id AND i.batch_id=m.child_batch_id AND i.search_id=m.search_id
 JOIN native_originals o ON o.library_id=i.library_id AND o.search_id=i.search_id AND o.hash=i.original_hash
 WHERE m.library_id=$1 AND m.plan_id=$2 AND i.state='acquired' GROUP BY o.hash,o.format) v`, library, plan).Scan(&bound)
		if err != nil {
			return nil, err
		}
		if bound > planOriginalBytes {
			return nil, exportInvalid("Plan original-byte bound")
		}
		z = zip.NewWriter(&out)
	}
	for n, i := range items {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		if i.Rank != n+1 || i.SearchID != d.Research.Records[n].SearchID {
			return nil, exportInvalid("Plan order or identity mismatch")
		}
		r := &d.Research.Records[n]
		r.Acquisition = structuredAcquisition{i.AcquisitionState, optionalText(i.Reason), optionalText(p.RequestedFormat)}
		entry := planExportItem{SearchID: i.SearchID, Rank: i.Rank, ChildBatchID: i.ChildBatchID, AcquisitionState: i.AcquisitionState, Phase: i.Phase, Reason: i.Reason, OriginalHash: optionalText(i.OriginalHash), Availability: "not_acquired", AvailabilityReason: optionalText(i.Reason)}
		if i.AcquisitionState != nil && *i.AcquisitionState == "acquired" {
			entry.Availability = "not_revalidated"
			entry.AvailabilityReason = optionalText("Historical original descriptor only; use ZIP or individual Save for current validation.")
			if d.Revalidated {
				b, info, available, e := s.planOriginal(ctx, tx, library, i, p.RequestedFormat)
				if e != nil {
					return nil, e
				}
				entry.Availability = "unavailable"
				entry.AvailabilityReason = optionalText("Historical original is missing, restricted, or failed current rights/integrity validation. Open the record's source links.")
				if available {
					filename := "originals/" + info.SHA256 + "." + strings.ToLower(info.Format)
					if !files[filename] {
						if len(b) > planOriginalBytes-total {
							return nil, exportInvalid("Plan original-byte bound")
						}
						w, e := z.CreateHeader(&zip.FileHeader{Name: filename, Method: zip.Store})
						if e != nil {
							return nil, e
						}
						if _, e = w.Write(b); e != nil {
							return nil, e
						}
						total += len(b)
						unique++
						files[filename] = true
					}
					included++
					entry.Availability = "included"
					entry.AvailabilityReason = nil
					entry.File = &filename
					entry.Original = &info
				}
			}
		}
		if entry.AvailabilityReason == nil && entry.Availability != "included" {
			entry.AvailabilityReason = optionalText("No acquired original in this snapshot. Review the saved item status and source links.")
		}
		d.Items = append(d.Items, entry)
	}
	if d.Revalidated {
		unresolved = membership - included
		d.Counts = planExportCounts{membership, &included, &unresolved, &unique, &total}
	}
	manifest, err := encodePlanDocument(ctx, d)
	if err != nil {
		return nil, err
	}
	if d.Revalidated {
		records, e := encodeStructured(ctx, d.Research, "json")
		if e != nil {
			return nil, e
		}
		for _, entry := range []struct {
			name string
			data []byte
		}{{"manifest.json", manifest}, {"records.json", records}} {
			w, e := z.CreateHeader(&zip.FileHeader{Name: entry.name, Method: zip.Store})
			if e != nil {
				return nil, e
			}
			if _, e = w.Write(entry.data); e != nil {
				return nil, e
			}
		}
		if err = z.Close(); err != nil {
			return nil, err
		}
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	if d.Revalidated {
		return out.Bytes(), nil
	}
	return manifest, nil
}

func (s *server) planOriginal(ctx context.Context, tx pgx.Tx, library string, i planItem, requested string) ([]byte, structuredOriginal, bool, error) {
	var descriptor structuredOriginal
	var a map[string]any
	if json.Unmarshal([]byte(i.raw), &a) != nil {
		return nil, descriptor, false, exportInvalid("Invalid plan metadata")
	}
	if !s.cfg.AcquisitionEnabled || requested == "pdf" && !s.cfg.PDFEnabled || slices.Contains(s.cfg.BlockedPMCIDs, articleString(a, "Pmcid")) {
		return nil, descriptor, false, nil
	}
	var size, proofSize int64
	err := tx.QueryRow(ctx, "SELECT octet_length(content),octet_length(proof) FROM native_originals WHERE library_id=$1 AND search_id=$2 AND hash=$3", library, i.SearchID, i.OriginalHash).Scan(&size, &proofSize)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, descriptor, false, nil
	}
	if err != nil {
		return nil, descriptor, false, err
	}
	if size < 1 || size > originalLimit || proofSize > proofLimit {
		return nil, descriptor, false, nil
	}
	var b, proof []byte
	var format, source, rights string
	var acquired time.Time
	err = tx.QueryRow(ctx, "SELECT content,proof,format,source_uri,rights_uri,acquired_at FROM native_originals WHERE library_id=$1 AND search_id=$2 AND hash=$3", library, i.SearchID, i.OriginalHash).Scan(&b, &proof, &format, &source, &rights, &acquired)
	if err != nil {
		return nil, descriptor, false, err
	}
	if format != requested {
		return nil, descriptor, false, nil
	}
	info, err := validateStored(b, proof, format, a)
	if e := ctx.Err(); e != nil {
		return nil, descriptor, false, e
	}
	if err != nil || info.Hash != i.OriginalHash || info.Source != source || info.Rights != rights {
		return nil, descriptor, false, nil
	}
	descriptor = structuredOriginal{Kind: "source_original", Format: info.Format, MediaType: info.MediaType, Deposit: optionalText(info.DepositVersion), Version: optionalText(info.Version), SHA256: info.Hash, Bytes: int64(len(b)), Source: optionalText(info.Source), Rights: optionalText(info.Rights), Stamp: optionalText(info.Stamp), AcquiredAt: acquired, Availability: "included"}
	return b, descriptor, true, nil
}
