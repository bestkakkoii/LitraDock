package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func workbookFixture(t *testing.T) []map[string]any {
	t.Helper()
	b, e := os.ReadFile("testdata/workbook-synthetic.json")
	if e != nil {
		t.Fatal(e)
	}
	var v struct{ Rows []map[string]any }
	if json.Unmarshal(b, &v) != nil {
		t.Fatal("fixture JSON")
	}
	for _, r := range v.Rows {
		raw, e := json.Marshal(r["article"])
		if e != nil {
			t.Fatal(e)
		}
		r["metadata"] = string(raw)
	}
	return v.Rows
}

func TestWorkbookConcurrentBound(t *testing.T) {
	// Synthetic near-limit text, two concurrent exports matching the handler slot cap.
	rows := make([]map[string]any, 1000)
	for i := range rows {
		article := map[string]any{"SearchId": fmt.Sprintf("%025d", i), "Title": strings.Repeat("x", 3000), "Authors": "SYNTHETIC α 中文", "Pmid": "00001"}
		b, _ := json.Marshal(article)
		rows[i] = map[string]any{"metadata": string(b), "reason": "SYNTHETIC workload, no source data"}
	}
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			if b, e := encodeWorkbook(context.Background(), rows, "RUN-SYNTHETIC-LOAD", ""); e != nil || len(b) == 0 {
				t.Errorf("concurrent bounded workbook: %v", e)
			}
		})
	}
	wg.Wait()
	for i := range rows {
		rows[i]["reason"] = strings.Repeat("y", 2000)
	}
	if b, e := encodeWorkbook(context.Background(), rows, "RUN-SYNTHETIC-EXCESS", ""); e == nil || len(b) != 0 {
		t.Fatal("text byte limit accepted a partial workbook")
	}
}
func TestWorkbookFidelityAndBounds(t *testing.T) {
	rows := workbookFixture(t)
	b, e := encodeWorkbook(context.Background(), rows, "RUN-SYNTHETIC-0001", "")
	if e != nil {
		t.Fatal(e)
	}
	z, e := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if e != nil {
		t.Fatal(e)
	}
	cells, linksCount := 0, 0
	for _, f := range z.File {
		r, e := f.Open()
		if e != nil {
			t.Fatal(e)
		}
		data, e := io.ReadAll(r)
		r.Close()
		if e != nil {
			t.Fatal(e)
		}
		if f.Name == "xl/worksheets/sheet1.xml" {
			d := xml.NewDecoder(bytes.NewReader(data))
			for {
				token, e := d.Token()
				if e == io.EOF {
					break
				}
				if e != nil {
					t.Fatal(e)
				}
				n, ok := token.(xml.StartElement)
				if !ok {
					continue
				}
				if n.Name.Local == "f" {
					t.Fatal("formula emitted")
				}
				if n.Name.Local == "c" {
					cells++
					typ := ""
					for _, a := range n.Attr {
						if a.Name.Local == "t" {
							typ = a.Value
						}
					}
					if typ != "s" && typ != "inlineStr" {
						t.Fatalf("nontext cell %s", typ)
					}
				}
				if n.Name.Local == "hyperlink" {
					linksCount++
				}
			}
		}
	}
	if cells != 84 || linksCount != 7 {
		t.Fatalf("unexpected cells/links %d/%d", cells, linksCount)
	}
	if output := os.Getenv("NATIVE_WORKBOOK_TEST_OUTPUT"); output != "" {
		if e = os.MkdirAll(output, 0700); e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(output, "synthetic.xlsx"), b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	for _, size := range []int{1000, 10000, 25001} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			many := make([]map[string]any, size)
			for i := range many {
				many[i] = rows[0]
			}
			out, e := encodeWorkbook(context.Background(), many, "RUN-SYNTHETIC-LARGE", "")
			if size == 1000 {
				if e != nil || len(out) == 0 {
					t.Fatal("bounded1000 fixture", e)
				}
			} else if e == nil || len(out) != 0 {
				t.Fatal("oversized workbook not rejected")
			}
		})
	}
	for _, value := range []string{strings.Repeat("x", 32768), strings.Repeat("😀", 16384), "invalid\x00XML", string([]byte{0xff})} {
		a := workbookFixture(t)
		var m map[string]any
		json.Unmarshal([]byte(a[0]["metadata"].(string)), &m)
		m["Title"] = value
		raw, _ := json.Marshal(m)
		a[0]["metadata"] = string(raw)
		// encoding/json replaces invalid UTF-8 during construction; test that input directly instead.
		if value == string([]byte{0xff}) {
			if workbookText(value) {
				t.Fatal("invalid UTF-8 admitted")
			}
			continue
		}
		if out, e := encodeWorkbook(context.Background(), a, "RUN", ""); e == nil || len(out) != 0 {
			t.Fatal("unrepresentable/truncated text accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if out, e := encodeWorkbook(ctx, rows, "RUN", ""); e == nil || len(out) != 0 {
		t.Fatal("cancelled export")
	}
	for _, bad := range []string{"https://untrusted.invalid/a", "javascript:alert(1)", "https://u:p@doi.org/a", "https://doi.org:443/a", "https://doi.org/a#secret", "file:///tmp/x"} {
		if workbookLink(bad) {
			t.Fatal("unsafe workbook hyperlink", bad)
		}
	}
}
