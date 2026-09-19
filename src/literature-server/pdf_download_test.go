package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

func pdfPackageFixture(t *testing.T, kind, fault string, available bool) ([]byte, string) {
	t.Helper()
	id, search := "BAT-synthetic", "LD-00000000000000000000000000000001"
	pdf := []byte("%PDF-1.4\nSYNTHETIC final-package integrity fixture\n%%EOF\n")
	hash := sha256.Sum256(pdf)
	digest := hex.EncodeToString(hash[:])
	outcome := describeSource("pdf", "acquired", "", false, true, available, map[string]any{})
	file := "originals/" + search + "-" + digest + ".pdf"
	if kind == "plan" {
		id = "PLN-synthetic"
		file = "originals/" + digest + ".pdf"
	}
	var manifest any
	metadata := "records.csv"
	if kind == "batch" {
		item := map[string]any{"searchId": search, "sourceOutcome": outcome}
		if available {
			item["file"] = file
			item["sha256"] = digest
			item["bytes"] = len(pdf)
			item["format"] = "PDF"
			item["mediaType"] = "application/pdf"
		}
		items := []any{item}
		if fault == "duplicate" {
			items = append(items, item)
		}
		manifest = map[string]any{"batchId": id, "requestedFormat": "pdf", "items": items}
	} else {
		item := planExportItem{SearchID: search, Availability: "unavailable", SourceOutcome: &outcome}
		if available {
			item.Availability = "included"
			item.File = &file
			item.Original = &structuredOriginal{Format: "PDF", MediaType: "application/pdf", SHA256: digest, Bytes: int64(len(pdf))}
		}
		items := []planExportItem{item}
		if fault == "duplicate" {
			items = append(items, item)
		}
		manifest = planExportDocument{Plan: planSummary{PlanID: id, RunID: "RUN-synthetic", RequestedFormat: "pdf", SelectedCount: len(items)}, Revalidated: true, Items: items}
		metadata = "records.json"
	}
	raw, _ := json.Marshal(manifest)
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	write := func(name string, data []byte) {
		w, e := writer.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if e != nil {
			t.Fatal(e)
		}
		if _, e = w.Write(data); e != nil {
			t.Fatal(e)
		}
	}
	write("manifest.json", raw)
	write(metadata, []byte("SYNTHETIC metadata"))
	if available && fault != "missing PDF" {
		if fault == "corrupt PDF" {
			pdf[len(pdf)-1] = 'X'
		}
		write(file, pdf)
	}
	if fault == "foreign member" {
		write("originals/FOREIGN.pdf", pdf)
	}
	if fault == "duplicate ZIP name" {
		write("manifest.json", raw)
	}
	if e := writer.Close(); e != nil {
		t.Fatal(e)
	}
	return buffer.Bytes(), id
}

func TestPDFPackageFinalOutcomes(t *testing.T) {
	for _, kind := range []string{"batch", "plan"} {
		for _, available := range []bool{false, true} {
			archive, id := pdfPackageFixture(t, kind, "", available)
			header, file, e := pdfDownloadPackage(archive, kind, id)
			if e != nil {
				t.Fatal(kind, available, e)
			}
			var report pdfDownloadReport
			if json.Unmarshal(header, &report) != nil {
				t.Fatal("report")
			}
			if report.Selected != 1 || report.Items[0].Available != available || (len(file) > 0) != available {
				t.Fatal("final result")
			}
			if available {
				h := sha256.Sum256(file)
				if !bytes.Equal(file, archive) || report.ArchiveHash != hex.EncodeToString(h[:]) || report.Included != 1 || report.ArchiveBytes != len(file) {
					t.Fatal("changed archive")
				}
			} else if report.Included != 0 || report.Unresolved != 1 || report.ArchiveHash != "" || report.ArchiveBytes != 0 || report.Items[0].Outcome.Status != "restricted" {
				t.Fatal("empty package claimed success")
			}
		}
		for _, fault := range []string{"duplicate", "missing PDF", "corrupt PDF", "foreign member", "duplicate ZIP name"} {
			t.Run(kind+"/"+fault, func(t *testing.T) {
				archive, id := pdfPackageFixture(t, kind, fault, true)
				if _, _, e := pdfDownloadPackage(archive, kind, id); e == nil {
					t.Fatal("accepted invalid package")
				}
			})
		}
		archive, id := pdfPackageFixture(t, kind, "", true)
		if _, _, e := pdfDownloadPackage(archive, kind, id+"FOREIGN"); e == nil {
			t.Fatal("foreign scope accepted")
		}
	}
}
