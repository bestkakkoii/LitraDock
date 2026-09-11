using System;
using System.Collections.Generic;
using System.Data;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Xml.Linq;

namespace LitraDock.Core
{
    public static class ExcelExport
    {
        public static readonly string[] LeadingHeaders = { "Search ID", "Title", "Authors", "Year", "DOI", "PMID", "PMCID", "Original URI" };
        private static readonly XNamespace Main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        private static readonly XNamespace Relations = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        private static readonly XNamespace Package = "http://schemas.openxmlformats.org/package/2006/relationships";

        private sealed class Sheet
        {
            public string Name { get; set; }
            public List<string[]> Rows { get; } = new List<string[]>();
        }

        public static void Write(Library library, IList<Article> records, string path)
        {
            var sheets = new List<Sheet>();
            var articles = new Sheet { Name = "Records" };
            articles.Rows.Add(LeadingHeaders.Concat(new[] { "Journal", "Publication date", "Article number", "Pages (source)", "Publication types", "Abstract", "DOI URL", "PMID URL", "PMCID URL", "Retrieval state", "Retrieved at", "Equal contribution", "License", "Local source files" }).ToArray());
            articles.Rows.AddRange(records.Select(a => new[] { a.SearchId, a.Title, a.Authors, a.Year, a.Doi, a.Pmid, a.Pmcid, a.OriginalUri, a.Journal, a.PublicationDate, a.ArticleNumber, a.Pages, a.PublicationTypes, a.Abstract, a.DoiUri, a.OriginalUri, a.PmcUri, a.RetrievalState, a.RetrievedAt, a.EqualContribution, a.License, string.Join("\n", library.FilePaths(a.SearchId)) }));
            sheets.Add(articles);
            var selectedIds = new HashSet<string>(records.Select(a => a.SearchId));
            var unresolved = new Sheet { Name = "Unresolved" };
            unresolved.Rows.Add(LeadingHeaders.Concat(new[] { "State", "Reason", "Next action", "DOI URL", "PMCID URL" }).ToArray());
            var jobs = library.ReadTable("jobs").Rows.Cast<DataRow>().Where(r => selectedIds.Contains((string)r["search_id"]))
                .GroupBy(r => (string)r["search_id"]).ToDictionary(g => g.Key, g => g.Last());
            foreach (var article in records)
            {
                if (article.RetrievalState == "completed" && Artifacts.HasVerifiedArtifact(library, article)) { continue; }
                DataRow job; jobs.TryGetValue(article.SearchId, out job);
                var state = article.RetrievalState == "completed" ? "failed" : article.RetrievalState;
                var reason = article.RetrievalState == "completed" ? "Previously completed file is missing or corrupt." : job?["reason"].ToString() ?? "No acquisition attempt recorded.";
                var action = state == "needs_login" ? "Open the public article link and use authorized access; authenticated app continuation is not implemented in this build."
                    : state == "unavailable" ? "Check public article/DOI links for a permitted version; no supported PMC artifact was acquired."
                    : state == "paused" || state == "cancelled" ? "Resume the paused batch or explicitly retry cancelled items in Downloads / Tasks."
                    : state == "not_requested" ? "Select the record and request full text." : "Inspect the saved task reason; retry when the source or storage issue is resolved.";
                unresolved.Rows.Add(new[] { article.SearchId, article.Title, article.Authors, article.Year, article.Doi, article.Pmid, article.Pmcid, article.OriginalUri, state, reason, action, article.DoiUri, article.PmcUri });
            }
            sheets.Add(unresolved);
            var associations = library.ReadTable("article_files").Rows.Cast<DataRow>().Where(r => selectedIds.Contains((string)r["search_id"])).ToList();
            var selectedHashes = new HashSet<string>(associations.Select(r => (string)r["hash"]));
            var memberships = library.ReadTable("search_results").Rows.Cast<DataRow>().ToList();
            var selectedRuns = new HashSet<string>(memberships.Where(r => selectedIds.Contains((string)r["search_id"])).Select(r => (string)r["run_id"]));
            // 選定紀錄匯出不得夾帶其他文獻的歷史。混合範圍搜尋保留 ID/數量，但不外洩原始查詢。
            foreach (var tableName in new[] { "search_runs", "search_results", "files", "article_files", "activity", "jobs", "identifiers", "revisions" })
            {
                var table = library.ReadTable(tableName);
                var sheet = new Sheet { Name = tableName };
                sheet.Rows.Add(table.Columns.Cast<DataColumn>().Select(c => c.ColumnName).ToArray());
                foreach (DataRow row in table.Rows)
                {
                    if (tableName == "files" && !selectedHashes.Contains((string)row["hash"])) { continue; }
                    if (table.Columns.Contains("search_id") && !selectedIds.Contains(Convert.ToString(row["search_id"]))) { continue; }
                    if (tableName == "search_runs")
                    {
                        var runId = (string)row["run_id"];
                        if (!selectedRuns.Contains(runId)) { continue; }
                        var mixed = memberships.Any(r => (string)r["run_id"] == runId && !selectedIds.Contains((string)r["search_id"]));
                        if (mixed || (long)row["fetched"] != (long)row["total"])
                        {
                            foreach (var field in new[] { "input", "submitted_query", "translation", "reason" })
                            { row[field] = "[Omitted: search coverage extends beyond this export scope.]"; }
                        }
                        var selectedPmids = new HashSet<string>(records.Select(a => a.Pmid));
                        row["source_ids"] = string.Join(",", ((string)row["source_ids"]).Split(',').Where(selectedPmids.Contains));
                    }
                    sheet.Rows.Add(row.ItemArray.Select(v => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)).ToArray());
                }
                sheets.Add(sheet);
            }
            var batchItems = library.BatchTable("batch_items");
            var queueSheet = new Sheet { Name = "Batch items" };
            queueSheet.Rows.Add(batchItems.Columns.Cast<DataColumn>().Select(c => c.ColumnName).ToArray());
            queueSheet.Rows.AddRange(batchItems.Rows.Cast<DataRow>().Where(r => selectedIds.Contains((string)r["search_id"]))
                .Select(r => r.ItemArray.Select(v => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)).ToArray()));
            sheets.Add(queueSheet);
            var about = new Sheet { Name = "Report scope" };
            about.Rows.Add(new[] { "Field", "Value" });
            about.Rows.Add(new[] { "Records", records.Count + " records in the chosen display scope." });
            about.Rows.Add(new[] { "History tables", "Only selected records and their linked history/files/metadata. Mixed or incomplete searches omit query text and non-selected source IDs; original total/fetched counts describe the original search, not export coverage." });
            about.Rows.Add(new[] { "Full text", "Complete source XML is an original API response. External media are not bundled. No rendered PDF fidelity is claimed." });
            about.Rows.Add(new[] { "Unresolved", "Subset of Records without a currently verified acquired artifact; public article/DOI links are landing locations, not guaranteed direct downloads. Original full scope remains in Records. Same-record manual import and authenticated continuation await the source milestone." });
            about.Rows.Add(new[] { "Long values", "Cells longer than 32767 UTF-16 units are losslessly split into the Long values worksheet in numbered parts; the original cell names that location." });
            about.Rows.Add(new[] { "NCBI notice", "https://www.ncbi.nlm.nih.gov/About/disclaimer.html" });
            sheets.Add(about);
            var longValues = new Sheet { Name = "Long values" };
            longValues.Rows.Add(new[] { "Worksheet", "Cell", "Part", "Value" });
            foreach (var sheet in sheets)
            {
                for (var r = 0; r < sheet.Rows.Count; r++)
                {
                    for (var c = 0; c < sheet.Rows[r].Length; c++)
                    {
                        var value = sheet.Rows[r][c] ?? "";
                        if (value.Length <= 32767) { continue; }
                        var address = Column(c) + (r + 1);
                        var part = 1;
                        for (var offset = 0; offset < value.Length;)
                        {
                            var length = Math.Min(32000, value.Length - offset);
                            if (char.IsHighSurrogate(value[offset + length - 1])) { length--; }
                            longValues.Rows.Add(new[] { sheet.Name, address, (part++).ToString(), value.Substring(offset, length) });
                            offset += length;
                        }
                        sheet.Rows[r][c] = "Full value: 'Long values' worksheet; " + sheet.Name + "!" + address + "; " + (part - 1) + " parts.";
                    }
                }
            }
            sheets.Add(longValues);
            if (sheets.Any(s => s.Rows.Count > 1048576)) { throw new InvalidOperationException("Excel row limit exceeded; narrow the export scope. Nothing was truncated."); }
            path = Path.GetFullPath(path);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            using (var zip = ZipFile.Open(temporary, ZipArchiveMode.Create))
            {
                XNamespace content = "http://schemas.openxmlformats.org/package/2006/content-types";
                Put(zip, "[Content_Types].xml", new XElement(content + "Types",
                    new XElement(content + "Default", new XAttribute("Extension", "rels"), new XAttribute("ContentType", "application/vnd.openxmlformats-package.relationships+xml")),
                    new XElement(content + "Default", new XAttribute("Extension", "xml"), new XAttribute("ContentType", "application/xml")),
                    new XElement(content + "Override", new XAttribute("PartName", "/xl/workbook.xml"), new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")),
                    sheets.Select((s, i) => new XElement(content + "Override", new XAttribute("PartName", "/xl/worksheets/sheet" + (i + 1) + ".xml"), new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml")))));
                Put(zip, "_rels/.rels", new XElement(Package + "Relationships", Relationship("rId1", "officeDocument", "xl/workbook.xml")));
                Put(zip, "xl/workbook.xml", new XElement(Main + "workbook", new XAttribute(XNamespace.Xmlns + "r", Relations), new XElement(Main + "sheets", sheets.Select((s, i) => new XElement(Main + "sheet", new XAttribute("name", s.Name), new XAttribute("sheetId", i + 1), new XAttribute(Relations + "id", "rId" + (i + 1)))))));
                Put(zip, "xl/_rels/workbook.xml.rels", new XElement(Package + "Relationships", sheets.Select((s, i) => Relationship("rId" + (i + 1), "worksheet", "worksheets/sheet" + (i + 1) + ".xml"))));
                for (var i = 0; i < sheets.Count; i++) { WriteSheet(zip, sheets[i], i + 1); }
            }
            // 匯出先完成新檔，再原子替換使用者指定的現有報告；建檔失敗不破壞舊報告。
            if (File.Exists(path)) { File.Replace(temporary, path, null); }
            else { File.Move(temporary, path); }
        }

        private static XElement Relationship(string id, string kind, string target) => new XElement(Package + "Relationship", new XAttribute("Id", id), new XAttribute("Type", Relations.NamespaceName + "/" + kind), new XAttribute("Target", target));

        private static void WriteSheet(ZipArchive zip, Sheet sheet, int number)
        {
            var links = new List<XElement>();
            var relationships = new List<XElement>();
            var data = new XElement(Main + "sheetData");
            for (var r = 0; r < sheet.Rows.Count; r++)
            {
                var row = new XElement(Main + "row", new XAttribute("r", r + 1));
                for (var c = 0; c < sheet.Rows[r].Length; c++)
                {
                    var value = sheet.Rows[r][c] ?? "";
                    var address = Column(c) + (r + 1);
                    // 全部使用 inlineStr，外來 '='、'+' 等文字不會轉成公式。
                    row.Add(new XElement(Main + "c", new XAttribute("r", address), new XAttribute("t", "inlineStr"), new XElement(Main + "is", new XElement(Main + "t", new XAttribute(XNamespace.Xml + "space", "preserve"), value))));
                    Uri link;
                    if (Uri.TryCreate(value, UriKind.Absolute, out link) && link.Scheme == "https" && link.UserInfo.Length == 0 &&
                        new[] { "doi.org", "pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov", "eutils.ncbi.nlm.nih.gov" }.Contains(link.Host))
                    {
                        var id = "rId" + (links.Count + 1);
                        links.Add(new XElement(Main + "hyperlink", new XAttribute("ref", address), new XAttribute(Relations + "id", id)));
                        var rel = Relationship(id, "hyperlink", value);
                        rel.Add(new XAttribute("TargetMode", "External"));
                        relationships.Add(rel);
                    }
                }
                data.Add(row);
            }
            var document = new XElement(Main + "worksheet", new XAttribute(XNamespace.Xmlns + "r", Relations),
                new XElement(Main + "sheetViews", new XElement(Main + "sheetView", new XAttribute("workbookViewId", 0), new XElement(Main + "pane", new XAttribute("ySplit", 1), new XAttribute("topLeftCell", "A2"), new XAttribute("activePane", "bottomLeft"), new XAttribute("state", "frozen")))), data);
            if (sheet.Rows.Count > 1) { document.Add(new XElement(Main + "autoFilter", new XAttribute("ref", "A1:" + Column(sheet.Rows[0].Length - 1) + sheet.Rows.Count))); }
            if (links.Count > 0) { document.Add(new XElement(Main + "hyperlinks", links)); }
            Put(zip, "xl/worksheets/sheet" + number + ".xml", document);
            if (relationships.Count > 0) { Put(zip, "xl/worksheets/_rels/sheet" + number + ".xml.rels", new XElement(Package + "Relationships", relationships)); }
        }

        private static string Column(int index)
        {
            var value = "";
            for (index++; index > 0; index = (index - 1) / 26) { value = (char)('A' + (index - 1) % 26) + value; }
            return value;
        }

        private static void Put(ZipArchive zip, string name, XElement document)
        { using (var stream = zip.CreateEntry(name).Open()) { new XDocument(new XDeclaration("1.0", "utf-8", "yes"), document).Save(stream); } }
    }
}
