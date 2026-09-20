package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

func syntheticCaptureXML(total, start, count int) []byte {
	var body strings.Builder
	fmt.Fprintf(&body, "<eSearchResult><Count>%d</Count><RetMax>%d</RetMax><RetStart>0</RetStart><IdList>", total, count)
	for i := 0; i < count; i++ {
		fmt.Fprintf(&body, "<Id>%d</Id>", start+i)
	}
	body.WriteString("</IdList><QueryTranslation>SYNTHETIC ONLY fixture translation</QueryTranslation></eSearchResult>")
	return []byte(body.String())
}

func TestCaptureSupportedBoundaryFixtures(t *testing.T) {
	for _, total := range []int{100, 1000, 9999, 10000, 10001, 20000, 20001} {
		t.Run(fmt.Sprint(total), func(t *testing.T) {
			body := syntheticCaptureXML(total, 900000001, min(total, 9999))
			observed, ids, _, err := parseCaptureSearchMetadata(body, 9999)
			if err != nil || observed != total || len(ids) != min(total, 9999) {
				t.Fatal("provider-boundary count lost", observed, len(ids), err)
			}
			if len(body) > 200000 {
				t.Fatal("fixture response unexpectedly unbounded")
			}
			if total > 9999 && observed == len(ids) {
				t.Fatal("beyond-boundary input falsely complete")
			}
		})
	}
	for _, body := range [][]byte{syntheticCaptureXML(10001, 1, 10001), []byte(`<eSearchResult><Count>2</Count><IdList><Id>1</Id><Id>1</Id></IdList></eSearchResult>`)} {
		if _, _, _, err := parseCaptureSearchMetadata(body, 9999); err == nil {
			t.Fatal("excess or duplicate source membership accepted")
		}
	}
}

func TestCaptureWarningAndTruncationControls(t *testing.T) {
	base := string(syntheticCaptureXML(1, 900000001, 1))
	warning := `<WarningList><OutputMessage>Restrictions achieved. start and count adjusted to 0, 9999</OutputMessage></WarningList>`
	known := strings.Replace(base, "</eSearchResult>", warning+"</eSearchResult>", 1)
	spaced := strings.ReplaceAll(strings.ReplaceAll(known, "<IdList>", "<IdList>\n  "), "<WarningList>", "<WarningList>\n  ")
	for _, body := range []string{base, known, spaced, string(syntheticCaptureXML(0, 900000001, 0))} {
		if _, _, _, err := parseCaptureSearchMetadata([]byte(body), 9999); err != nil {
			t.Fatal("complete supported response refused", err)
		}
	}
	for name, body := range map[string]string{
		"mixed warning text":        strings.Replace(known, "<WarningList>", "<WarningList>SYNTHETIC query terms were ignored.", 1),
		"mixed identifier text":     strings.Replace(known, "<IdList>", "<IdList>SYNTHETIC omitted identities.", 1),
		"mixed root text":           strings.Replace(known, "<eSearchResult>", "<eSearchResult>SYNTHETIC incomplete response.", 1),
		"nested translation":        strings.Replace(base, "<QueryTranslation>", "<QueryTranslation><Unknown>SYNTHETIC</Unknown>", 1),
		"unknown warning":           strings.Replace(known, "Restrictions achieved. start and count adjusted to 0, 9999", "SYNTHETIC query terms ignored", 1),
		"field warning":             strings.Replace(known, "OutputMessage", "FieldNotFound", -1),
		"multiple warnings":         strings.Replace(known, "</WarningList>", "<OutputMessage>SYNTHETIC other warning</OutputMessage></WarningList>", 1),
		"error list":                strings.Replace(base, "</eSearchResult>", "<ErrorList><FieldNotFound>SYNTHETIC</FieldNotFound></ErrorList></eSearchResult>", 1),
		"error message":             strings.Replace(base, "</eSearchResult>", "<ErrorMessage>SYNTHETIC error</ErrorMessage></eSearchResult>", 1),
		"api error":                 strings.Replace(base, "</eSearchResult>", "<ERROR>SYNTHETIC error</ERROR></eSearchResult>", 1),
		"wrong offset":              strings.Replace(base, "<RetStart>0</RetStart>", "<RetStart>1</RetStart>", 1),
		"wrong returned count":      strings.Replace(base, "<RetMax>1</RetMax>", "<RetMax>2</RetMax>", 1),
		"missing returned count":    strings.Replace(base, "<RetMax>1</RetMax>", "", 1),
		"ambiguous returned count":  strings.Replace(base, "<RetMax>1</RetMax>", "<RetMax>1</RetMax><RetMax>1</RetMax>", 1),
		"incomplete below boundary": string(syntheticCaptureXML(9999, 900000001, 9998)),
		"incomplete above boundary": string(syntheticCaptureXML(10000, 900000001, 9998)),
		"excessive IDs":             string(syntheticCaptureXML(10000, 900000001, 10000)),
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, _, err := parseCaptureSearchMetadata([]byte(body), 9999); err == nil {
				t.Fatal("unsupported response accepted")
			}
		})
	}
	// 這是隔離的反例：相同完整 9,999 筆回應在舊 10,000 假設下被拒絕，
	// 新界線保留 total=10,000，後续必須分段，不能把 9,999 筆前綴當完成。
	body := syntheticCaptureXML(10000, 900000001, 9999)
	if _, _, _, err := parseCaptureSearchMetadata(body, 10000); err == nil {
		t.Fatal("old incomplete-boundary control unexpectedly complete")
	}
	if total, ids, _, err := parseCaptureSearchMetadata(body, 9999); err != nil || total != 10000 || len(ids) != 9999 {
		t.Fatal("conservative boundary lost full provider count", total, len(ids), err)
	}
}

func TestCapturePartitionPreservesQueryAndAllDays(t *testing.T) {
	query := `("heart failure"[Title/Abstract] OR asthma[MeSH Terms]) NOT review[Publication Type] AND 2010:2026[dp]`
	plan := newCapturePlan(time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC))
	root := plan.Frontier[0]
	if got, _ := segmentQuery(query, root); got != query {
		t.Fatal("base query was rewritten")
	}
	children, err := splitCaptureSegment(plan, root)
	if err != nil {
		t.Fatal(err)
	}
	in, _ := segmentQuery(query, children[0])
	out, _ := segmentQuery(query, children[1])
	if in != "("+query+") AND (1800/01/01:2026/09/20[crdt])" || out != "("+query+") NOT (1800/01/01:2026/09/20[crdt])" {
		t.Fatal("range/complement did not preserve the exact operand")
	}
	// An independent calendar walk checks that repeated subdivision introduces
	// neither a gap nor overlap, including leap days and pre-Unix dates.
	parent := captureSegment{ID: 3, Kind: "range", Start: "1969-12-29", End: "1972-03-02"}
	frontier := []captureSegment{parent}
	covered := map[string]int{}
	for len(frontier) > 0 {
		segment := frontier[0]
		frontier = frontier[1:]
		if segment.Start == segment.End {
			covered[segment.Start]++
			continue
		}
		parts, e := splitCaptureSegment(plan, segment)
		if e != nil {
			t.Fatal(e)
		}
		frontier = append(frontier, parts...)
	}
	start, _ := time.Parse("2006-01-02", parent.Start)
	end, _ := time.Parse("2006-01-02", parent.End)
	days := 0
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		days++
		if covered[day.Format("2006-01-02")] != 1 {
			t.Fatal("partition gap/overlap", day)
		}
	}
	if len(covered) != days {
		t.Fatal("partition introduced outside days")
	}
	for _, segment := range []captureSegment{{Kind: "range", Start: "2026-09-20", End: "2026-09-20"}, children[1]} {
		if _, e := splitCaptureSegment(plan, segment); e == nil {
			t.Fatal("unsupported oversized leaf was paginated")
		}
	}
}

func TestCaptureExportPreservesInjectionAndScope(t *testing.T) {
	extra := []string{"selected", "11", "17", "2", "0", "1", "1", "=SYNTHETIC untrusted query", "1", "0", "1", ""}
	rows := []map[string]any{{"metadata": `{"SearchId":"SEARCH-fixture","Pmid":"900000001","Pmcid":"PMC900000001","Doi":"10.1234/fixture","Title":"=SYNTHETIC FORMULA","Authors":"王; =author","Year":"2026"}`, "run_ids": "RUN-fixture", "batch_id": "", "snapshot_extra": extra}}
	part := captureExportPart{Schema: "litradock.staged-query-export", Version: 1, Scope: "selected", Count: 1, ScopeCount: 2, Remaining: 1, RunID: "RUN-fixture"}
	data, _, err := encodeCapturePart(context.Background(), part, rows, "csv")
	if err != nil {
		t.Fatal(err)
	}
	table, err := csv.NewReader(strings.NewReader(string(data))).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	lookup := map[string]int{}
	for i, name := range table[0] {
		lookup[strings.TrimPrefix(name, "\ufeff")] = i
	}
	if table[1][lookup["Title"]] != "'=SYNTHETIC FORMULA" || table[1][lookup["Original query"]] != "'=SYNTHETIC untrusted query" || table[1][lookup["Remaining count"]] != "1" {
		t.Fatal("CSV changed exact scope or formula defense")
	}
	data, _, err = encodeCapturePart(context.Background(), part, rows, "xlsx")
	if err != nil {
		t.Fatal(err)
	}
	book, err := excelize.OpenReader(strings.NewReader(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	defer book.Close()
	for _, name := range []string{"Title", "Original query"} {
		cell, _ := excelize.CoordinatesToCellName(lookup[name]+1, 2)
		formula, e := book.GetCellFormula("Literature", cell)
		if e != nil || formula != "" {
			t.Fatal("XLSX exported an executable formula", formula, e)
		}
	}
	if _, _, err = encodeCapturePart(context.Background(), part, rows, "unsupported"); err == nil {
		t.Fatal("unsupported format accepted")
	}
}

func TestCaptureWorkbookCannotSilentlyShortenLongField(t *testing.T) {
	longTitle := strings.Repeat("研", 32768)
	raw, _ := json.Marshal(map[string]string{"SearchId": "LD-fixture", "Pmid": "900000001", "Title": longTitle})
	rows := []map[string]any{{"metadata": string(raw), "run_ids": "RUN-fixture", "batch_id": "", "snapshot_extra": make([]string, len(captureExportColumns))}}
	data, _, err := encodeCapturePart(context.Background(), captureExportPart{RunID: "RUN-fixture"}, rows, "xlsx")
	var unavailable *planError
	if len(data) != 0 || !errors.As(err, &unavailable) || unavailable.Status != 422 {
		t.Fatal("excessive workbook text must produce an explicit complete-file refusal", err)
	}
	record, err := structuredArticle("LD-fixture", string(raw))
	if err != nil {
		t.Fatal(err)
	}
	part := captureExportPart{Records: []captureExportRecord{{structuredRecord: record}}}
	data, _, err = encodeCapturePart(context.Background(), part, nil, "json")
	if err != nil {
		t.Fatal("lossless JSON positive control", err)
	}
	var got captureExportPart
	if json.Unmarshal(data, &got) != nil || len(got.Records) != 1 || got.Records[0].Publication.Title == nil || *got.Records[0].Publication.Title != longTitle {
		t.Fatal("JSON alternative lost the long title")
	}
}
