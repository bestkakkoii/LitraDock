package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
)

const pdfDownloadMedia = "application/vnd.litradock.pdf-download"
const pdfReportBytes = 1024 * 1024

type pdfDownloadItem struct {
	SearchID  string         `json:"searchId"`
	Available bool           `json:"available"`
	File      string         `json:"file,omitempty"`
	SHA256    string         `json:"sha256,omitempty"`
	Bytes     int64          `json:"bytes,omitempty"`
	Outcome   *sourceOutcome `json:"sourceOutcome"`
}

type pdfDownloadReport struct {
	Schema       string            `json:"schema"`
	Version      int               `json:"schemaVersion"`
	Kind         string            `json:"kind"`
	ID           string            `json:"id"`
	RunID        string            `json:"runID,omitempty"`
	Format       string            `json:"requestedFormat"`
	Selected     int               `json:"selectedCount"`
	Included     int               `json:"includedRecords"`
	Unresolved   int               `json:"unresolvedRecords"`
	ArchiveBytes int               `json:"archiveBytes"`
	ArchiveHash  string            `json:"archiveSha256"`
	Items        []pdfDownloadItem `json:"items"`
}

// The primary PDF action consumes the final archive's manifest, never an earlier
// ready count. Ordinary ZIP exports remain useful even with metadata alone.
// Framing is a four-byte big-endian JSON length, bounded JSON, then exact ZIP
// bytes; zero included PDFs returns only the outcome report and no archive.
func pdfDownloadPackage(archive []byte, kind, id string) ([]byte, []byte, error) {
	bad := func() ([]byte, []byte, error) {
		return nil, nil, exportInvalid("PDF package scope or integrity mismatch")
	}
	if len(archive) > planZIPBytes {
		return bad()
	}
	z, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil || len(z.File) > 102 {
		return bad()
	}
	files := map[string]*zip.File{}
	for _, f := range z.File {
		if files[f.Name] != nil {
			return bad()
		}
		files[f.Name] = f
	}
	f := files["manifest.json"]
	if f == nil || f.UncompressedSize64 > 8*1024*1024 {
		return bad()
	}
	r, err := f.Open()
	if err != nil {
		return bad()
	}
	manifest, err := io.ReadAll(io.LimitReader(r, 8*1024*1024+1))
	r.Close()
	if err != nil || len(manifest) > 8*1024*1024 {
		return bad()
	}
	d := pdfDownloadReport{Schema: "litradock.pdf-download", Version: 1, Kind: kind, ID: id, Format: "pdf", Items: []pdfDownloadItem{}}
	metadata := "records.csv"
	if kind == "batch" {
		var m struct {
			ID     string `json:"batchId"`
			Format string `json:"requestedFormat"`
			Items  []struct {
				SearchID string         `json:"searchId"`
				File     string         `json:"file"`
				SHA256   string         `json:"sha256"`
				Bytes    int64          `json:"bytes"`
				Format   string         `json:"format"`
				Media    string         `json:"mediaType"`
				Outcome  *sourceOutcome `json:"sourceOutcome"`
			} `json:"items"`
		}
		if json.Unmarshal(manifest, &m) != nil || m.ID != id || m.Format != "pdf" {
			return bad()
		}
		for _, i := range m.Items {
			if i.File != "" && (i.Format != "PDF" || i.Media != "application/pdf" || i.File != "originals/"+i.SearchID+"-"+i.SHA256+".pdf") {
				return bad()
			}
			d.Items = append(d.Items, pdfDownloadItem{i.SearchID, i.File != "", i.File, i.SHA256, i.Bytes, i.Outcome})
		}
	} else if kind == "plan" {
		var m planExportDocument
		if json.Unmarshal(manifest, &m) != nil || m.Plan.PlanID != id || m.Plan.RequestedFormat != "pdf" || m.Plan.ScopeKind != "" || !m.Revalidated || m.Plan.SelectedCount != len(m.Items) {
			return bad()
		}
		d.RunID = m.Plan.RunID
		metadata = "records.json"
		for _, i := range m.Items {
			entry := pdfDownloadItem{SearchID: i.SearchID, Available: i.Availability == "included", Outcome: i.SourceOutcome}
			if entry.Available {
				if i.Original == nil || i.File == nil || i.Original.Format != "PDF" || i.Original.MediaType != "application/pdf" || *i.File != "originals/"+i.Original.SHA256+".pdf" {
					return bad()
				}
				entry.File, entry.SHA256, entry.Bytes = *i.File, i.Original.SHA256, i.Original.Bytes
			} else if i.File != nil || i.Original != nil {
				return bad()
			}
			d.Items = append(d.Items, entry)
		}
	} else {
		return bad()
	}
	if len(d.Items) < 1 || len(d.Items) > 100 || files[metadata] == nil || files[metadata].UncompressedSize64 > 8*1024*1024 {
		return bad()
	}
	used := map[string]bool{"manifest.json": true, metadata: true}
	selected := map[string]bool{}
	var total int64
	for _, i := range d.Items {
		if !savedIDPattern.MatchString(i.SearchID) || selected[i.SearchID] || i.Outcome == nil || i.Outcome.RequestedFormat != "pdf" || (i.Outcome.Status == "ready") != i.Available {
			return bad()
		}
		selected[i.SearchID] = true
		if !i.Available {
			continue
		}
		d.Included++
		f := files[i.File]
		expected, e := hex.DecodeString(i.SHA256)
		if e != nil || len(expected) != 32 || i.Bytes < 1 || i.Bytes > 8*1024*1024 || f == nil || f.UncompressedSize64 != uint64(i.Bytes) || f.Method != zip.Store {
			return bad()
		}
		if used[i.File] {
			continue
		}
		used[i.File] = true
		total += i.Bytes
		if total > planOriginalBytes {
			return bad()
		}
		r, e := f.Open()
		if e != nil {
			return bad()
		}
		h := sha256.New()
		prefix := make([]byte, 5)
		_, e = io.ReadFull(r, prefix)
		if e != nil || string(prefix) != "%PDF-" {
			r.Close()
			return bad()
		}
		h.Write(prefix)
		n, e := io.Copy(h, io.LimitReader(r, 8*1024*1024))
		r.Close()
		if e != nil || n+5 != i.Bytes || !bytes.Equal(h.Sum(nil), expected) {
			return bad()
		}
	}
	if len(files) != len(used) {
		return bad()
	}
	d.Selected = len(d.Items)
	d.Unresolved = d.Selected - d.Included
	if d.Included == 0 {
		archive = nil
	} else {
		d.ArchiveBytes = len(archive)
		hash := sha256.Sum256(archive)
		d.ArchiveHash = hex.EncodeToString(hash[:])
	}
	header, err := json.Marshal(d)
	if err != nil || len(header) > pdfReportBytes {
		return bad()
	}
	return header, archive, nil
}

func writePDFDownload(w http.ResponseWriter, report, archive []byte) {
	w.Header().Set("Content-Type", pdfDownloadMedia)
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(report)))
	if _, err := w.Write(length[:]); err != nil {
		return
	}
	if _, err := w.Write(report); err != nil {
		return
	}
	_, _ = w.Write(archive)
}
