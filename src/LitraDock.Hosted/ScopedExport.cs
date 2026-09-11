using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using LitraDock.Core;

namespace Literature.Service;

public sealed partial class PgStore
{
    public async Task<byte[]> ExportComplete(
        Guid library,
        string scope,
        bool selectedOnly = false,
        bool csv = false
    )
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync(
            System.Data.IsolationLevel.RepeatableRead
        );
        if (
            !(bool)
                await Scalar(
                    db,
                    "SELECT EXISTS(SELECT 1 FROM ld_scopes WHERE library_id=@p0 AND scope_id=@p1)",
                    library,
                    scope
                )
        )
            throw new KeyNotFoundException();
        var size = await Rows(
            db,
            "SELECT count(*) AS count,coalesce(sum(octet_length(r.metadata)),0) AS bytes FROM ld_members m JOIN ld_records r USING(library_id,search_id) WHERE m.library_id=@p0 AND m.scope_id=@p1 AND (NOT @p2 OR m.selected)",
            library,
            scope,
            selectedOnly
        );
        if (
            Convert.ToInt64(size[0]["count"]) > 10000
            || Convert.ToInt64(size[0]["bytes"]) > 32 * 1024 * 1024
        )
            throw new ArgumentException(
                "Export supports up to 10000 records and 32 MiB of metadata per scope; refine or split this scope explicitly."
            );
        await Exec(
            db,
            "CREATE TEMP TABLE export_members ON COMMIT DROP AS SELECT search_id,rank FROM ld_members WHERE library_id=@p0 AND scope_id=@p1 AND (NOT @p2 OR selected)",
            library,
            scope,
            selectedOnly
        );
        var records = (
            await Rows(
                db,
                "SELECT metadata FROM ld_records JOIN export_members USING(search_id) WHERE library_id=@p0 ORDER BY rank",
                library
            )
        )
            .Select(r =>
                JsonSerializer.Deserialize<Article>(ExportPrivacy.Text((string)r["metadata"]))
            )
            .ToArray();
        var sheets = new Dictionary<string, List<string[]>>();
        sheets["Records"] =
        [
            ExcelExport
                .LeadingHeaders.Concat(
                    new[]
                    {
                        "Journal",
                        "Publication date",
                        "Article number",
                        "Pages",
                        "Publication types",
                        "Abstract",
                        "DOI URL",
                        "PMID URL",
                        "PMCID URL",
                        "Retrieval state (historical)",
                        "Retrieved at",
                        "Equal contribution",
                        "License",
                        "Next action",
                    }
                )
                .ToArray(),
        ];
        sheets["Records"]
            .AddRange(
                records.Select(a =>
                    new[]
                    {
                        a.SearchId,
                        a.Title,
                        a.Authors,
                        a.Year,
                        a.Doi,
                        a.Pmid,
                        a.Pmcid,
                        a.OriginalUri,
                        a.Journal,
                        a.PublicationDate,
                        a.ArticleNumber,
                        a.Pages,
                        a.PublicationTypes,
                        a.Abstract,
                        a.DoiUri,
                        a.OriginalUri,
                        a.PmcUri,
                        a.RetrievalState,
                        a.RetrievedAt,
                        a.EqualContribution,
                        a.License,
                        SourceAcquisition.Locations(a).NextAction,
                    }
                )
            );
        sheets["Metadata"] =
        [
            new[] { "Search ID", "Part", "Complete Article JSON (concatenate parts in order)" },
        ];
        foreach (var record in records)
        {
            var json = JsonSerializer.Serialize(record);
            for (var part = 0; part * 30000 < json.Length; part++)
                sheets["Metadata"]
                    .Add([
                        record.SearchId,
                        (part + 1).ToString(),
                        json.Substring(part * 30000, Math.Min(30000, json.Length - part * 30000)),
                    ]);
        }
        async Task Detail(string name, string sql)
        {
            var rows = await Rows(db, sql, library, scope);
            if (
                rows.Count > 10000
                || rows.Sum(r => JsonSerializer.Serialize(r).Length) > 32 * 1024 * 1024
            )
                throw new ArgumentException(
                    "Export detail resource limit exceeded; refine scope. No partial file was returned."
                );
            sheets[name] =
                rows.Count == 0 ? [new[] { "No matching rows" }] : [rows[0].Keys.ToArray()];
            sheets[name]
                .AddRange(
                    rows.Select(r =>
                        r.Values.Select(v =>
                                ExportPrivacy.Text(
                                    Convert.ToString(
                                        v,
                                        System.Globalization.CultureInfo.InvariantCulture
                                    ) ?? ""
                                )
                            )
                            .ToArray()
                    )
                );
        }
        await Detail(
            "Unresolved",
            "SELECT i.search_id,r.title,i.state,i.reason,i.item_id,i.batch_id,i.last_job_id,'Open stable record links or upload an authorized original; retry only when appropriate' AS next_action FROM ld_items i JOIN ld_records r USING(library_id,search_id) JOIN export_members USING(search_id) WHERE i.library_id=@p0 AND i.batch_id IN (SELECT batch_id FROM ld_batches WHERE library_id=@p0 AND scope_id=@p1) AND i.state<>'completed' ORDER BY i.state,i.rank LIMIT 10001"
        );
        // 未解決工作保留文字識別碼及連結，而不是從空欄臆造下載 URL。
        if (sheets["Unresolved"][0][0] != "No matching rows")
        {
            sheets["Unresolved"][0] = sheets["Unresolved"]
                [0]
                .Concat(new[] { "DOI", "PMID", "PMCID", "DOI URL", "PubMed URL", "PMC URL" })
                .ToArray();
            var lookup = records.ToDictionary(a => a.SearchId);
            for (var i = 1; i < sheets["Unresolved"].Count; i++)
            {
                var a = lookup[sheets["Unresolved"][i][0]];
                sheets["Unresolved"][i] = sheets["Unresolved"]
                    [i]
                    .Concat(new[] { a.Doi, a.Pmid, a.Pmcid, a.DoiUri, a.OriginalUri, a.PmcUri })
                    .ToArray();
            }
        }
        await Detail(
            "Files",
            "SELECT a.*,f.kind,f.bytes,f.validation FROM ld_article_files a JOIN ld_files f USING(library_id,hash) JOIN export_members USING(search_id) WHERE a.library_id=@p0 AND @p1 IS NOT NULL LIMIT 10001"
        );
        await Detail(
            "Provenance",
            "SELECT p.* FROM ld_object_provenance p JOIN export_members USING(search_id) WHERE p.library_id=@p0 AND @p1 IS NOT NULL LIMIT 10001"
        );
        await Detail(
            "Items",
            "SELECT i.* FROM ld_items i JOIN export_members USING(search_id) JOIN ld_batches b USING(library_id,batch_id) WHERE i.library_id=@p0 AND b.scope_id=@p1 LIMIT 10001"
        );
        await Detail(
            "Jobs",
            "SELECT j.library_id,j.job_id,j.kind,j.run_id,j.item_id,j.search_id,j.state,j.reason,j.created_at FROM ld_jobs j JOIN export_members USING(search_id) WHERE j.library_id=@p0 AND @p1 IS NOT NULL LIMIT 10001"
        );
        await Detail(
            "Activity",
            "SELECT e.* FROM ld_events e JOIN ld_jobs j USING(library_id,job_id) JOIN export_members USING(search_id) WHERE e.library_id=@p0 AND @p1 IS NOT NULL LIMIT 10001"
        );
        await Detail(
            "Search Runs",
            "SELECT r.run_id,r.total,r.fetched,r.requested_limit,r.state,CASE WHEN (SELECT count(*) FROM ld_results x WHERE x.library_id=r.library_id AND x.run_id=r.run_id)=(SELECT count(*) FROM ld_results x JOIN export_members USING(search_id) WHERE x.library_id=r.library_id AND x.run_id=r.run_id) THEN r.input ELSE '[Query omitted for partial export scope]' END AS input FROM ld_runs r WHERE r.library_id=@p0 AND r.run_id IN (SELECT x.run_id FROM ld_results x JOIN export_members USING(search_id) WHERE x.library_id=@p0) AND @p1 IS NOT NULL LIMIT 10001"
        );
        await Detail(
            "Search Results",
            "SELECT x.* FROM ld_results x JOIN export_members USING(search_id) WHERE x.library_id=@p0 AND @p1 IS NOT NULL LIMIT 10001"
        );
        sheets["Export Notes"] =
        [
            new[] { "Projection", "Original preservation" },
            new[]
            {
                "Shareable metadata removes URL credentials, non-public query strings and fragments, including URLs nested in raw XML/JSON. Ordered metadata chunks otherwise retain complete fields.",
                "Private canonical metadata and original file bytes remain unchanged. This report is not a portable backup.",
            },
        ];
        foreach (var rows in sheets.Values)
        foreach (var row in rows)
            for (var column = 0; column < row.Length; column++)
                row[column] = ExportPrivacy.Text(row[column]);
        return ScopedWorkbook.Write(sheets, csv);
    }
}

public static class ScopedWorkbook
{
    public static byte[] Write(Dictionary<string, List<string[]>> tables, bool csv)
    {
        // 超長欄位移到有順序的細節表，完整內容仍可重組；不得默默丟掉尾段。
        var overflow = new List<string[]>
        {
            new[] { "Worksheet", "Row", "Column", "Part", "Text" },
        };
        foreach (var table in tables)
            for (var r = 1; r < table.Value.Count; r++)
            for (var c = 0; c < table.Value[r].Length; c++)
            {
                var text = table.Value[r][c] ?? "";
                if (csv || text.Length <= 32767)
                    continue;
                var part = 0;
                for (var offset = 0; offset < text.Length; )
                {
                    var length = Math.Min(30000, text.Length - offset);
                    if (
                        offset + length < text.Length
                        && char.IsHighSurrogate(text[offset + length - 1])
                    )
                        length--;
                    overflow.Add([
                        table.Key,
                        (r + 1).ToString(),
                        (c + 1).ToString(),
                        (++part).ToString(),
                        text.Substring(offset, length),
                    ]);
                    offset += length;
                }
                table.Value[r][c] =
                    "Complete value in Long Fields: row " + (r + 1) + ", column " + (c + 1) + ".";
            }
        if (overflow.Count > 1)
            tables["Long Fields"] = overflow;
        XNamespace ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
            rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
            pkg = "http://schemas.openxmlformats.org/package/2006/relationships",
            types = "http://schemas.openxmlformats.org/package/2006/content-types";
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true))
        {
            void Add(string path, string value)
            {
                using var writer = new StreamWriter(
                    zip.CreateEntry(path).Open(),
                    new UTF8Encoding(false)
                );
                writer.Write(value);
            }
            var workbook = new XElement(ns + "sheets");
            var workbookRels = new XElement(pkg + "Relationships");
            var content = new XElement(
                types + "Types",
                new XElement(
                    types + "Default",
                    new XAttribute("Extension", "rels"),
                    new XAttribute(
                        "ContentType",
                        "application/vnd.openxmlformats-package.relationships+xml"
                    )
                ),
                new XElement(
                    types + "Default",
                    new XAttribute("Extension", "xml"),
                    new XAttribute("ContentType", "application/xml")
                ),
                new XElement(
                    types + "Override",
                    new XAttribute("PartName", "/xl/workbook.xml"),
                    new XAttribute(
                        "ContentType",
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
                    )
                )
            );
            var number = 0;
            foreach (var table in tables)
            {
                number++;
                if (csv)
                {
                    string Cell(string v)
                    {
                        v ??= "";
                        if (v.Length > 0 && (char.IsWhiteSpace(v[0]) || "=+-@".Contains(v[0])))
                            v = "'" + v;
                        return "\"" + v.Replace("\"", "\"\"") + "\"";
                    }
                    Add(
                        table.Key + ".csv",
                        string.Join(
                            "\r\n",
                            table.Value.Select(row => string.Join(",", row.Select(Cell)))
                        )
                    );
                    continue;
                }
                var data = new XElement(ns + "sheetData");
                var links = new XElement(ns + "hyperlinks");
                var relationships = new XElement(pkg + "Relationships");
                for (var r = 0; r < table.Value.Count; r++)
                {
                    var row = new XElement(ns + "row", new XAttribute("r", r + 1));
                    data.Add(row);
                    for (var c = 0; c < table.Value[r].Length; c++)
                    {
                        var value = table.Value[r][c] ?? "";
                        var cell = Column(c) + (r + 1);
                        row.Add(
                            new XElement(
                                ns + "c",
                                new XAttribute("r", cell),
                                new XAttribute("t", "inlineStr"),
                                new XElement(
                                    ns + "is",
                                    new XElement(
                                        ns + "t",
                                        new XAttribute(XNamespace.Xml + "space", "preserve"),
                                        value
                                    )
                                )
                            )
                        );
                        var url = value;
                        if (table.Key == "Records" && r > 0)
                            url =
                                c == 4 && value != ""
                                    ? "https://doi.org/"
                                        + Uri.EscapeDataString(value).Replace("%2F", "/")
                                : c == 5 && value != ""
                                    ? "https://pubmed.ncbi.nlm.nih.gov/" + value + "/"
                                : c == 6 && value != ""
                                    ? "https://pmc.ncbi.nlm.nih.gov/articles/" + value + "/"
                                : value;
                        if (
                            r == 0
                            || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
                            || uri.Scheme != "https"
                            || uri.UserInfo != ""
                            || uri.Query != ""
                            || uri.Fragment != ""
                        )
                            continue;
                        var id = "rId" + (relationships.Elements().Count() + 1);
                        links.Add(
                            new XElement(
                                ns + "hyperlink",
                                new XAttribute("ref", cell),
                                new XAttribute(rel + "id", id)
                            )
                        );
                        relationships.Add(
                            new XElement(
                                pkg + "Relationship",
                                new XAttribute("Id", id),
                                new XAttribute("Type", rel.NamespaceName + "/hyperlink"),
                                new XAttribute("Target", url),
                                new XAttribute("TargetMode", "External")
                            )
                        );
                    }
                }
                workbook.Add(
                    new XElement(
                        ns + "sheet",
                        new XAttribute("name", table.Key),
                        new XAttribute("sheetId", number),
                        new XAttribute(rel + "id", "rId" + number)
                    )
                );
                workbookRels.Add(
                    new XElement(
                        pkg + "Relationship",
                        new XAttribute("Id", "rId" + number),
                        new XAttribute("Type", rel.NamespaceName + "/worksheet"),
                        new XAttribute("Target", "worksheets/sheet" + number + ".xml")
                    )
                );
                content.Add(
                    new XElement(
                        types + "Override",
                        new XAttribute("PartName", "/xl/worksheets/sheet" + number + ".xml"),
                        new XAttribute(
                            "ContentType",
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
                        )
                    )
                );
                Add(
                    "xl/worksheets/sheet" + number + ".xml",
                    new XElement(ns + "worksheet", data, links).ToString()
                );
                Add("xl/worksheets/_rels/sheet" + number + ".xml.rels", relationships.ToString());
            }
            if (!csv)
            {
                Add("[Content_Types].xml", content.ToString());
                Add(
                    "_rels/.rels",
                    new XElement(
                        pkg + "Relationships",
                        new XElement(
                            pkg + "Relationship",
                            new XAttribute("Id", "rId1"),
                            new XAttribute("Type", rel.NamespaceName + "/officeDocument"),
                            new XAttribute("Target", "xl/workbook.xml")
                        )
                    ).ToString()
                );
                Add("xl/workbook.xml", new XElement(ns + "workbook", workbook).ToString());
                Add("xl/_rels/workbook.xml.rels", workbookRels.ToString());
            }
            else
                Add(
                    "README.txt",
                    "UTF-8 CSV report, not a backup. Leading formula-triggering cells receive an apostrophe for spreadsheet safety; original metadata values remain in the complete JSON parts in Metadata.csv. No originals are included."
                );
        }
        return memory.ToArray();
    }

    private static string Column(int c)
    {
        var result = "";
        do
        {
            result = (char)('A' + c % 26) + result;
            c = c / 26 - 1;
        } while (c >= 0);
        return result;
    }
}
