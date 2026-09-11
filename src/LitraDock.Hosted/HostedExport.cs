using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using LitraDock.Core;

namespace Literature.Service;

public sealed partial class PgStore
{
    public async Task<byte[]> Export(Guid library, string scope)
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync(
            System.Data.IsolationLevel.RepeatableRead
        );
        var count = Convert.ToInt32(
            await Scalar(
                db,
                "SELECT count(*) FROM ld_members WHERE library_id=@p0 AND scope_id=@p1",
                library,
                scope
            )
        );
        if (count > 1000)
            throw new ArgumentException(
                "Hosted foundation export is limited to 1000 records; refine the scope."
            );
        var records = (
            await Rows(
                db,
                "SELECT r.metadata FROM ld_members m JOIN ld_records r USING(library_id,search_id) WHERE m.library_id=@p0 AND m.scope_id=@p1 ORDER BY m.rank",
                library,
                scope
            )
        )
            .Select(r => JsonSerializer.Deserialize<Article>((string)r["metadata"]))
            .ToArray();
        // 每個欄位超出 Excel 單格限制就明確拒絕，不靜默截斷；完整匯出規格留待後續保真階段。
        return HostedExport.Write(records);
    }
}

public static class HostedExport
{
    public static byte[] Write(IEnumerable<Article> records)
    {
        XNamespace sheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
            rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
            pkg = "http://schemas.openxmlformats.org/package/2006/relationships";
        var data = new XElement(sheet + "sheetData");
        var links = new XElement(sheet + "hyperlinks");
        var relationships = new XElement(pkg + "Relationships");
        var rows = new List<string[]>
        {
            ExcelExport
                .LeadingHeaders.Concat(
                    new[]
                    {
                        "Journal",
                        "Publication date",
                        "Article number",
                        "Pages (source)",
                        "Publication types",
                        "Abstract",
                        "DOI URL",
                        "PMID URL",
                        "PMCID URL",
                        "Retrieval state",
                        "Retrieved at",
                        "Equal contribution",
                        "License",
                        "Availability note",
                    }
                )
                .ToArray(),
        };
        rows.AddRange(
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
                    "Historical retrieval state; original bytes are hash-verified on download. Consult task history for unresolved attempts.",
                }
            )
        );
        for (var r = 0; r < rows.Count; r++)
        {
            var row = new XElement(sheet + "row", new XAttribute("r", r + 1));
            data.Add(row);
            for (var c = 0; c < rows[r].Length; c++)
            {
                var value = rows[r][c] ?? "";
                if (value.Length > 32767)
                    throw new ArgumentException(
                        "An exported field exceeds the Excel cell limit; no file was truncated."
                    );
                var cell = ((char)('A' + c)).ToString() + (r + 1);
                row.Add(
                    new XElement(
                        sheet + "c",
                        new XAttribute("r", cell),
                        new XAttribute("t", "inlineStr"),
                        new XElement(
                            sheet + "is",
                            new XElement(
                                sheet + "t",
                                new XAttribute(XNamespace.Xml + "space", "preserve"),
                                value
                            )
                        )
                    )
                );
                if (r == 0 || value.Length == 0 || c < 4)
                    continue;
                var url =
                    c == 4 ? "https://doi.org/" + Uri.EscapeDataString(value).Replace("%2F", "/")
                    : c == 5 ? "https://pubmed.ncbi.nlm.nih.gov/" + value + "/"
                    : c == 6 ? "https://pmc.ncbi.nlm.nih.gov/articles/" + value + "/"
                    : value;
                if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https")
                    continue;
                var id = "rId" + relationships.Elements().Count();
                links.Add(
                    new XElement(
                        sheet + "hyperlink",
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
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true))
        {
            void Add(string name, string value)
            {
                using var writer = new StreamWriter(
                    zip.CreateEntry(name).Open(),
                    new UTF8Encoding(false)
                );
                writer.Write(value);
            }
            Add(
                "[Content_Types].xml",
                "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/><Override PartName='/xl/workbook.xml' ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'/><Override PartName='/xl/worksheets/sheet1.xml' ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'/></Types>"
            );
            Add(
                "_rels/.rels",
                "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='xl/workbook.xml'/></Relationships>"
            );
            Add(
                "xl/workbook.xml",
                "<workbook xmlns='"
                    + sheet
                    + "' xmlns:r='"
                    + rel
                    + "'><sheets><sheet name='Records' sheetId='1' r:id='rId1'/></sheets></workbook>"
            );
            Add(
                "xl/_rels/workbook.xml.rels",
                "<Relationships xmlns='"
                    + pkg
                    + "'><Relationship Id='rId1' Type='"
                    + rel
                    + "/worksheet' Target='worksheets/sheet1.xml'/></Relationships>"
            );
            Add(
                "xl/worksheets/sheet1.xml",
                new XElement(sheet + "worksheet", data, links).ToString()
            );
            Add("xl/worksheets/_rels/sheet1.xml.rels", relationships.ToString());
        }
        return memory.ToArray();
    }
}
