package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"
)

var workbookColumns = []string{"Search ID", "Title", "Authors", "Year", "PMID", "PMCID", "DOI", "PubMed URL", "PMC URL", "DOI URL", "Current item state", "Reason", "Rights URI", "Original SHA256", "Acquisition URL", "Repository datestamp", "Original format", "Original version", "Original bytes", "Search Run ID", "Batch ID", "DOI link status"}

func workbookLink(value string) bool {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Port() != "" || len(value) > 2048 {
		return false
	}
	switch u.Host {
	case "pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov", "doi.org", "creativecommons.org":
		return true
	}
	return false
}

func workbookText(value string) bool {
	if !utf8.ValidString(value) {
		return false
	}
	units := 0
	for _, r := range value {
		// Refuse values the workbook format cannot represent without loss or truncation.
		if r < 0x20 && r != '\t' && r != '\n' && r != '\r' || r == 0xfffe || r == 0xffff {
			return false
		}
		units++
		if r > 0xffff {
			units++
		}
		if units > 32767 {
			return false
		}
	}
	return true
}

func (s *server) exportXLSX(ctx context.Context, library, run, batch string) ([]byte, error) {
	rows, e := s.exportRows(ctx, library, run, batch)
	if e != nil {
		return nil, e
	}
	return encodeWorkbook(ctx, rows, run, batch)
}

func encodeWorkbook(ctx context.Context, rows []map[string]any, run, batch string, extraColumns ...string) ([]byte, error) {
	if len(rows) == 0 || len(rows) > 1000 {
		return nil, errors.New("XLSX supports 1–1000 saved records; nothing truncated")
	}
	columns := append(append(append([]string{}, workbookColumns...), extraColumns...), sourceOutcomeColumns...)
	values := make([][]string, 0, len(rows))
	totalBytes := 0
	for _, row := range rows {
		if e := ctx.Err(); e != nil {
			return nil, e
		}
		raw, ok := row["metadata"].(string)
		if !ok {
			return nil, errors.New("invalid stored metadata")
		}
		var a map[string]any
		if json.Unmarshal([]byte(raw), &a) != nil || a == nil {
			return nil, errors.New("invalid stored metadata")
		}
		links(a)
		v := []string{}
		for _, key := range []string{"SearchId", "Title", "Authors", "Year", "Pmid", "Pmcid", "Doi", "OriginalUri", "PmcUri", "DoiUri"} {
			v = append(v, articleString(a, key))
		}
		for _, key := range []string{"state", "reason", "rights_uri", "original_hash", "source_uri", "repository_stamp", "format", "version", "bytes"} {
			value := ""
			if x := row[key]; x != nil {
				value = fmt.Sprint(x)
			}
			v = append(v, value)
		}
		rowRun := run
		if x, ok := row["run_ids"].(string); ok {
			rowRun = x
		}
		v = append(v, rowRun, batch, articleString(a, "DoiLinkState"))
		if len(extraColumns) > 0 {
			extra, ok := row["snapshot_extra"].([]string)
			if !ok || len(extra) != len(extraColumns) {
				return nil, errors.New("Incomplete snapshot workbook metadata")
			}
			v = append(v, extra...)
		}
		v = append(v, outcomeValues(row)...)
		for _, x := range v {
			if !workbookText(x) {
				return nil, errors.New("XLSX cell contains unsupported or excessive text; use source records, no truncated workbook returned")
			}
			totalBytes += len(x)
		}
		if totalBytes > 4*1024*1024 {
			return nil, errors.New("XLSX text limit reached; no partial export returned")
		}
		values = append(values, v)
	}
	f := excelize.NewFile()
	defer f.Close()
	const sheet = "Literature"
	if e := f.SetSheetName("Sheet1", sheet); e != nil {
		return nil, e
	}
	textStyle, e := f.NewStyle(&excelize.Style{NumFmt: 49})
	if e != nil {
		return nil, e
	}
	headerStyle, e := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}, NumFmt: 49})
	if e != nil {
		return nil, e
	}
	for rowIndex, v := range append([][]string{columns}, values...) {
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		for col, value := range v {
			cell, e := excelize.CoordinatesToCellName(col+1, rowIndex+1)
			if e != nil {
				return nil, e
			}
			// Strings never pass through formula or numeric inference; preserve exact identifier text.
			if e = f.SetCellStr(sheet, cell, value); e != nil {
				return nil, e
			}
			style := textStyle
			if rowIndex == 0 {
				style = headerStyle
			}
			if e = f.SetCellStyle(sheet, cell, cell, style); e != nil {
				return nil, e
			}
			if rowIndex > 0 && (col == 7 || col == 8 || col == 9 || col == 12 || col == 14) && workbookLink(value) {
				if e = f.SetCellHyperLink(sheet, cell, value, "External"); e != nil {
					return nil, e
				}
			}
		}
	}
	if e = f.SetColWidth(sheet, "A", "V", 24); e != nil {
		return nil, e
	}
	if e = f.SetColWidth(sheet, "B", "C", 48); e != nil {
		return nil, e
	}
	if e = f.SetPanes(sheet, &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"}); e != nil {
		return nil, e
	}
	end, _ := excelize.CoordinatesToCellName(len(columns), len(rows)+1)
	if e = f.AutoFilter(sheet, "A1:"+end, nil); e != nil {
		return nil, e
	}
	b, e := f.WriteToBuffer()
	if e != nil {
		return nil, e
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	if b.Len() > 8*1024*1024 {
		return nil, errors.New("XLSX file limit reached; no partial export returned")
	}
	return b.Bytes(), nil
}
