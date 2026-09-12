using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using LitraDock.Core;

namespace Literature.Service;

public static class CitationMetadata
{
    public static JsonObject Map(Article article)
    {
        var a = JsonSerializer.Deserialize<Article>(
            ExportPrivacy.Text(JsonSerializer.Serialize(article))
        );
        XDocument raw = null;
        if (a.RawXml.Length > 0)
            try
            {
                raw = Metadata.ParseXml(Encoding.UTF8.GetBytes(a.RawXml));
            }
            catch (System.Xml.XmlException) { }
        var root = raw?.Descendants("Article").FirstOrDefault();
        var authors = new JsonArray();
        foreach (
            var author in root?.Element("AuthorList")?.Elements("Author")
                ?? Enumerable.Empty<XElement>()
        )
        {
            if (author.Element("CollectiveName") is XElement corporate)
                authors.Add(new JsonObject { ["literal"] = corporate.Value });
            else
            {
                var name = new JsonObject();
                if (author.Element("LastName") is XElement family)
                    name["family"] = family.Value;
                if (author.Element("ForeName") is XElement given)
                    name["given"] = given.Value;
                else if (author.Element("Initials") is XElement initials)
                    name["given"] = initials.Value;
                if (author.Element("Suffix") is XElement suffix)
                    name["suffix"] = suffix.Value;
                if (name.Count > 0)
                    authors.Add(name);
            }
        }
        var missing = new JsonArray();
        if (authors.Count == 0)
        {
            if (a.Authors.Length > 0)
                authors.Add(new JsonObject { ["literal"] = a.Authors });
            missing.Add(
                "Structured authors unavailable; preserved display authors as a literal without splitting names."
            );
        }
        var item = new JsonObject
        {
            ["id"] = a.SearchId,
            ["type"] = "article-journal",
            ["title"] = a.Title,
            ["author"] = authors,
            ["container-title"] = a.Journal,
            ["DOI"] = a.Doi,
            ["PMID"] = a.Pmid,
            ["PMCID"] = a.Pmcid,
            ["URL"] = a.DoiUri.Length > 0 ? a.DoiUri : a.OriginalUri,
            ["abstract"] = a.Abstract,
            ["page"] = a.Pages,
            ["number"] = a.ArticleNumber,
            ["genre"] = a.PublicationTypes,
        };
        var issue = root?.Element("Journal")?.Element("JournalIssue");
        item["volume"] = Metadata.Value(issue, "Volume");
        item["issue"] = Metadata.Value(issue, "Issue");
        var date = new JsonArray();
        if (int.TryParse(a.Year, out var year) && year is > 0 and < 10000)
        {
            date.Add(year);
            var parts = a.PublicationDate.Split('-');
            if (
                parts.Length > 1
                && int.TryParse(parts[1], out var month)
                && month is >= 1 and <= 12
            )
            {
                date.Add(month);
                if (
                    parts.Length > 2
                    && int.TryParse(parts[2], out var day)
                    && day is >= 1 and <= 31
                )
                    date.Add(day);
            }
            item["issued"] = new JsonObject { ["date-parts"] = new JsonArray(date) };
        }
        else
            missing.Add("Publication year unavailable.");
        if (a.Title.Length == 0)
            missing.Add("Title unavailable.");
        if (a.Journal.Length == 0)
            missing.Add("Container title unavailable.");
        if (root == null)
            missing.Add(
                "Publication type mapping defaults to journal article; preserved source type is in genre."
            );
        item["custom"] = new JsonObject
        {
            ["searchId"] = a.SearchId,
            ["articleNumber"] = a.ArticleNumber,
            ["pages"] = a.Pages,
            ["publicationDate"] = a.PublicationDate,
            ["equalContribution"] = a.EqualContribution,
            ["missingMetadata"] = missing,
            ["sourceRawXml"] = a.RawXml,
        };
        return item;
    }

    private static string Line(string text) => Regex.Replace(text ?? "", @"[\r\n]+", " ");

    private static string Bib(string text)
    {
        var output = new StringBuilder();
        foreach (var c in Line(text))
            output.Append(
                c switch
                {
                    '\\' => "\\textbackslash{}",
                    '{' => "\\{",
                    '}' => "\\}",
                    '%' => "\\%",
                    '&' => "\\&",
                    '_' => "\\_",
                    '#' => "\\#",
                    '$' => "\\$",
                    '^' => "\\textasciicircum{}",
                    '~' => "\\textasciitilde{}",
                    _ => c.ToString(),
                }
            );
        return output.ToString();
    }

    public static string Ris(IEnumerable<JsonObject> items)
    {
        var result = new StringBuilder();
        foreach (var x in items)
        {
            void Field(string key, string value)
            {
                if (!string.IsNullOrEmpty(value))
                    result.Append(key).Append("  - ").Append(Line(value)).Append("\r\n");
            }
            Field("TY", "JOUR");
            Field("ID", x["id"]?.ToString());
            Field("TI", x["title"]?.ToString());
            foreach (var n in x["author"].AsArray())
                Field(
                    "AU",
                    n["literal"]?.ToString()
                        ?? string.Join(
                            ", ",
                            new[]
                            {
                                n["family"]?.ToString(),
                                n["suffix"]?.ToString(),
                                n["given"]?.ToString(),
                            }.Where(v => !string.IsNullOrEmpty(v))
                        )
                );
            foreach (
                var pair in new[]
                {
                    ("JO", "container-title"),
                    ("VL", "volume"),
                    ("IS", "issue"),
                    ("SP", "page"),
                    ("C7", "number"),
                    ("DO", "DOI"),
                    ("AN", "PMID"),
                    ("UR", "URL"),
                    ("AB", "abstract"),
                }
            )
                Field(pair.Item1, x[pair.Item2]?.ToString());
            Field("PY", x["issued"]?["date-parts"]?[0]?[0]?.ToString());
            Field("N1", "PMCID: " + x["PMCID"] + "; Search ID: " + x["id"]);
            Field("ER", " ");
            result.Append("\r\n");
        }
        return result.ToString();
    }

    public static string BibTex(IEnumerable<JsonObject> items)
    {
        var result = new StringBuilder();
        foreach (var x in items)
        {
            var key = Regex.Replace(x["id"].ToString(), "[^A-Za-z0-9_-]", "_");
            result.Append("@article{").Append(key).Append(",\n");
            void Field(string k, string v)
            {
                if (!string.IsNullOrEmpty(v))
                    result.Append("  ").Append(k).Append(" = {").Append(Bib(v)).Append("},\n");
            }
            Field("title", x["title"]?.ToString());
            Field("journal", x["container-title"]?.ToString());
            var names = x["author"]
                .AsArray()
                .Select(n =>
                    n["literal"] != null
                        ? "{" + Bib(n["literal"].ToString()) + "}"
                        : Bib(
                            string.Join(
                                ", ",
                                new[]
                                {
                                    n["family"]?.ToString(),
                                    n["suffix"]?.ToString(),
                                    n["given"]?.ToString(),
                                }.Where(v => !string.IsNullOrEmpty(v))
                            )
                        )
                );
            result.Append("  author = {").Append(string.Join(" and ", names)).Append("},\n");
            foreach (
                var p in new[]
                {
                    ("volume", "volume"),
                    ("number", "issue"),
                    ("pages", "page"),
                    ("eid", "number"),
                    ("doi", "DOI"),
                    ("pmid", "PMID"),
                    ("pmcid", "PMCID"),
                    ("url", "URL"),
                    ("abstract", "abstract"),
                }
            )
                Field(p.Item1, x[p.Item2]?.ToString());
            Field("year", x["issued"]?["date-parts"]?[0]?[0]?.ToString());
            Field("keywords", x["genre"]?.ToString());
            result.Append("}\n\n");
        }
        return result.ToString();
    }
}

public sealed partial class PgStore
{
    public async Task<JsonObject> CitationExport(
        Guid library,
        string scope,
        bool selected,
        string style,
        CancellationToken token
    )
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync(
            System.Data.IsolationLevel.RepeatableRead
        );
        await Exec(db, "SELECT pg_advisory_xact_lock(hashtextextended(@p0,0))", library.ToString());
        if (
            await Scalar(
                db,
                "SELECT scope_id FROM ld_scopes WHERE library_id=@p0 AND scope_id=@p1",
                library,
                scope
            ) == null
        )
            throw new KeyNotFoundException();
        var rows = await Rows(
            db,
            "SELECT r.metadata FROM ld_records r JOIN ld_members m USING(library_id,search_id) WHERE m.library_id=@p0 AND m.scope_id=@p1 AND (NOT @p2 OR m.selected) ORDER BY m.rank,r.search_id LIMIT 1001",
            library,
            scope,
            selected
        );
        if (
            rows.Count > 1000
            || rows.Sum(r => Encoding.UTF8.GetByteCount((string)r["metadata"])) > 8 * 1024 * 1024
        )
            throw new ArgumentException(
                "Citation processing supports at most 1000 records / 8 MiB metadata; refine the scope."
            );
        var items = rows.Select(r =>
                CitationMetadata.Map(JsonSerializer.Deserialize<Article>((string)r["metadata"]))
            )
            .ToArray();
        var result = await DocumentProcess.Run(
            new
            {
                operation = "citations",
                style,
                items,
            },
            token
        );
        for (var i = 0; i < items.Length; i++)
        {
            var position = result["entries"]
                .AsArray()
                .ToList()
                .FindIndex(x => x.AsArray().Any(id => id.ToString() == items[i]["id"].ToString()));
            var data = new JsonObject
            {
                ["item"] = items[i].DeepClone(),
                ["style"] = style,
                ["styleHash"] = result["styleHash"].DeepClone(),
                ["processor"] = result["processor"].DeepClone(),
                ["bibliography"] = position < 0 ? "" : result["bibliography"][position].ToString(),
                ["numberingNotice"] =
                    "Citation numbering belongs to this export order; canonical IDs remain unchanged.",
            };
            var key = "CITE-" + Digest(data.ToJsonString());
            if (
                Convert.ToInt64(
                    await Scalar(
                        db,
                        "SELECT count(*) FROM ld_citations WHERE library_id=@p0",
                        library
                    )
                ) >= 10000
                && await Scalar(
                    db,
                    "SELECT citation_id FROM ld_citations WHERE library_id=@p0 AND citation_id=@p1",
                    library,
                    key
                ) == null
            )
                throw new ArgumentException(
                    "Citation history limit reached; refine or transfer the library."
                );
            await Exec(
                db,
                "INSERT INTO ld_citations VALUES(@p0,@p1,@p2,@p3,now()) ON CONFLICT DO NOTHING",
                library,
                key,
                items[i]["id"].ToString(),
                data.ToJsonString()
            );
        }
        await tx.CommitAsync();
        result["items"] = new JsonArray(items.Select(x => (JsonNode)x).ToArray());
        result["ris"] = CitationMetadata.Ris(items);
        result["bibtex"] = CitationMetadata.BibTex(items);
        return result;
    }
}
