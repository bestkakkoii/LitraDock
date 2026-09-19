package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

func TestSelectionRequestIdentityAndValidation(t *testing.T) {
	run, request := newID("RUN-"), newUUID()
	yes := true
	ids := []string{newID("LD-"), newID("LD-")}
	originalIDs := slices.Clone(ids)
	a := runSelectionAction{RequestID: request, Revision: 18, Action: "set", IDs: ids, Selected: &yes}
	first, err := selectionIntent(run, a)
	if err != nil {
		t.Fatal(err)
	}
	reversed := slices.Clone(ids)
	slices.Reverse(reversed)
	a.IDs = reversed
	second, err := selectionIntent(run, a)
	if err != nil || first != second || !slices.Equal(ids, originalIDs) {
		t.Fatal("order changed durable request intent", err)
	}
	a.Revision++
	changed, err := selectionIntent(run, a)
	if err != nil || changed == first {
		t.Fatal("a different expected revision reused the same intent", err)
	}
	for _, invalid := range []runSelectionAction{
		{RequestID: request, Revision: 0, Action: "all"},
		{RequestID: "not-a-uuid", Revision: 1, Action: "all"},
		{RequestID: request, Revision: 1, Action: "toggle"},
		{RequestID: request, Revision: 1, Action: "none", IDs: []string{}},
		{RequestID: request, Revision: 1, Action: "all", Selected: &yes},
		{RequestID: request, Revision: 1, Action: "set", IDs: ids},
		{RequestID: request, Revision: 1, Action: "set", IDs: []string{ids[0], ids[0]}, Selected: &yes},
		{RequestID: request, Revision: 1, Action: "set", IDs: []string{"foreign syntax"}, Selected: &yes},
		{RequestID: request, Revision: 1, Action: "set", IDs: make([]string, 101), Selected: &yes},
	} {
		if _, err = selectionIntent(run, invalid); err == nil {
			t.Fatalf("invalid intent admitted: %#v", invalid)
		}
	}
	if _, err = selectionIntent("not-a-run", a); err == nil {
		t.Fatal("invalid run admitted")
	}
}

func TestSelectedSpreadsheetScopeAndUntrustedCells(t *testing.T) {
	article := syntheticArticle()
	article["Title"] = "=HYPERLINK(\"https://invalid.example\",\"SYNTHETIC ONLY\")"
	article["Authors"] = "SYNTHETIC 中文 α\nSecond, author"
	raw, err := json.Marshal(article)
	if err != nil {
		t.Fatal(err)
	}
	run := newID("RUN-")
	rows := []map[string]any{{"metadata": string(raw), "run_ids": run, "batch_id": "", "snapshot_extra": []string{"selected_saved_records", "102", "1000"}}}
	csvData, err := encodeRecordCSV(context.Background(), rows, runSelectionExportColumns...)
	if err != nil {
		t.Fatal(err)
	}
	table, err := csv.NewReader(bytes.NewReader(csvData)).ReadAll()
	if err != nil || len(table) != 2 {
		t.Fatal("CSV structure", err)
	}
	values := map[string]string{}
	for i, name := range table[0] {
		values[name] = table[1][i]
	}
	if !strings.HasPrefix(values["Title"], "'=HYPERLINK") || values["Authors"] != article["Authors"] || values["Search Run ID"] != run || values["Export scope"] != "selected_saved_records" || values["Selection revision"] != "102" || values["Saved record count"] != "1000" || values["PMID"] != "990000001" || values["PMCID"] != "PMC990000001" || values["DOI"] != "10.0000/synthetic" {
		t.Fatal("CSV lost scope, identifiers, Unicode or formula protection", values)
	}
	xlsx, err := encodeWorkbook(context.Background(), rows, run, "", runSelectionExportColumns...)
	if err != nil {
		t.Fatal(err)
	}
	book, err := excelize.OpenReader(bytes.NewReader(xlsx))
	if err != nil {
		t.Fatal(err)
	}
	defer book.Close()
	sheet := book.GetSheetName(0)
	if formula, err := book.GetCellFormula(sheet, "B2"); err != nil || formula != "" {
		t.Fatal("untrusted title became an Excel formula", err)
	}
	if title, err := book.GetCellValue(sheet, "B2"); err != nil || title != article["Title"] {
		t.Fatal("XLSX changed the stored title", err)
	}
	if _, err = encodeRecordCSV(context.Background(), nil); err == nil {
		t.Fatal("empty export admitted")
	}
	if _, err = encodeRecordCSV(context.Background(), make([]map[string]any, 1001)); err == nil {
		t.Fatal("oversized export was silently cut")
	}
	delete(rows[0], "snapshot_extra")
	if _, err = encodeRecordCSV(context.Background(), rows, runSelectionExportColumns...); err == nil {
		t.Fatal("missing scope labels admitted")
	}
}

func TestSelectionErrorDoesNotDiscloseInternalDetails(t *testing.T) {
	w := httptest.NewRecorder()
	runSelectionReply(w, nil, errors.New("SYNTHETIC PRIVATE DSN must not appear"))
	if w.Code != 503 || strings.Contains(w.Body.String(), "PRIVATE") || strings.Contains(w.Body.String(), "Plan") {
		t.Fatal("wrong selection failure boundary", w.Code, w.Body.String())
	}
}
