package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStructuredEncoding(t *testing.T) {
	const id = "0000123456789012345678901234567890"
	const title = "SYNTHETIC 醫學 😀 العربية \"quoted\"\nnext line\u0085NEL"
	input := map[string]any{"SearchId": id, "Title": title, "Pmid": "0000123", "Pmcid": "PMC990000001", "Doi": "10.0000/synthetic", "Abstract": "=HYPERLINK(\"not executed\")\n" + strings.Repeat("資料", 100), "password": "PRIVATE_SENTINEL", "csrf": "PRIVATE_SENTINEL", "RawXml": "PRIVATE_SENTINEL", "admin": map[string]string{"token": "PRIVATE_SENTINEL"}}
	raw, _ := json.Marshal(input)
	record, err := structuredArticle(id, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if record.SearchID != id || record.Publication.Title == nil || *record.Publication.Title != title || record.Publication.Authors != nil || *record.IDs.PMID != "0000123" {
		t.Fatal("text or missing-value fidelity")
	}
	outcome := describeSource("pdf", "", "", false, false, false, sourceArticle(record))
	record.SourceOutcome = &outcome
	d := structuredDocument{Schema: structuredSchema, Version: 1, Type: "document", GeneratedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), Scope: structuredScope{Kind: "run", RunID: optionalText("RUN-SYNTHETIC"), Selection: "all_saved_scope"}, Counts: structuredCounts{Exported: 1000, Scope: 1000}, Queries: []structuredQuery{{RunID: "RUN-SYNTHETIC", Query: "SYNTHETIC Boolean AND 醫學", State: "partial", Provider: 25001, Retrieved: 1000, Limit: 1000}}, Records: make([]structuredRecord, 1000)}
	for i := range d.Records {
		r := record
		r.SearchID = id + "-" + strings.Repeat("0", i%3) + string(rune(0x400+i))
		r.RunIDs = []string{"RUN-SYNTHETIC"}
		d.Records[i] = r
	}
	for _, format := range []string{"json", "jsonl"} {
		b, e := encodeStructured(context.Background(), d, format)
		if e != nil || bytes.Contains(b, []byte("PRIVATE_SENTINEL")) {
			t.Fatal("export or private allowlist", e)
		}
		if format == "jsonl" && bytes.Count(b, []byte{'\n'}) != 1001 {
			t.Fatal("embedded newline became a record separator")
		}
		if output := os.Getenv("NATIVE_STRUCTURED_TEST_OUTPUT"); output != "" {
			if e = os.MkdirAll(output, 0700); e != nil {
				t.Fatal(e)
			}
			if e = os.WriteFile(filepath.Join(output, "synthetic."+format), b, 0600); e != nil {
				t.Fatal(e)
			}
		}
	}
	t.Run("invalid-text-is-not-replaced-or-truncated", func(t *testing.T) {
		for _, raw := range []string{
			`{"SearchId":"x","Title":"\ud800"}`, `{"SearchId":"x","Title":"\udc00"}`,
			`{"SearchId":"x","Title":"a","Title":"b"}`, `{"SearchId":"x","Pmid":123}`,
			`{"SearchId":"other"}`, `{"SearchId":"x","Title":"` + strings.Repeat("a", 256*1024+1) + `"}`,
		} {
			if _, e := structuredArticle("x", raw); e == nil {
				t.Fatal("invalid metadata accepted")
			}
		}
		valid, e := structuredArticle("x", `{"SearchId":"x","Title":"\ud83d\ude00"}`)
		if e != nil || *valid.Publication.Title != "😀" {
			t.Fatal("valid Unicode pair rejected", e)
		}
	})
	t.Run("no-partial-file-on-count-size-or-cancellation", func(t *testing.T) {
		bad := d
		bad.Counts.Exported--
		if b, e := encodeStructured(context.Background(), bad, "json"); e == nil || b != nil {
			t.Fatal("inconsistent document exported")
		}
		bad = d
		bad.Records = []structuredRecord{record}
		bad.Counts = structuredCounts{Exported: 1, Scope: 1}
		bad.Records[0].Publication.Abstract = optionalText(strings.Repeat("x", structuredBytes))
		if b, e := encodeStructured(context.Background(), bad, "jsonl"); e == nil || b != nil {
			t.Fatal("partial over-limit JSONL escaped")
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if b, e := encodeStructured(ctx, d, "json"); e == nil || b != nil {
			t.Fatal("cancelled export escaped")
		}
	})
}
