using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace LitraDock.Core
{
    public sealed class Article
    {
        public string SearchId { get; set; }
        public string Title { get; set; } = "";
        public string Authors { get; set; } = "";
        public string Year { get; set; } = "";
        public string Doi { get; set; } = "";
        public string Pmid { get; set; } = "";
        public string Pmcid { get; set; } = "";
        public string OriginalUri => Pmid.Length == 0 ? "" : "https://pubmed.ncbi.nlm.nih.gov/" + Pmid + "/";
        public string DoiUri => Doi.Length == 0 ? "" : "https://doi.org/" + Uri.EscapeDataString(Doi).Replace("%2F", "/");
        public string PmcUri => Pmcid.Length == 0 ? "" : "https://pmc.ncbi.nlm.nih.gov/articles/" + Pmcid + "/";
        public string Journal { get; set; } = "";
        public string PublicationDate { get; set; } = "";
        public string ArticleNumber { get; set; } = "";
        public string Pages { get; set; } = "";
        public string Abstract { get; set; } = "";
        public string PublicationTypes { get; set; } = "";
        public string RawXml { get; set; } = "";
        public string FullTextMetadataXml { get; set; } = "";
        public string EqualContribution { get; set; } = "";
        public string License { get; set; } = "";
        public string RetrievedAt { get; set; } = "";
        public string RetrievalState { get; set; } = "not_requested";
    }

    public sealed class SearchSnapshot
    {
        public string RunId { get; set; } = "RUN-" + Guid.NewGuid().ToString("N");
        public string Input { get; set; } = "";
        public string SubmittedQuery { get; set; } = "";
        public string Translation { get; set; } = "";
        public string StartedAt { get; set; } = DateTime.UtcNow.ToString("o");
        public int Total { get; set; }
        public int Limit { get; set; }
        public string State { get; set; } = "searching";
        public string Reason { get; set; } = "";
        public List<string> SourceIds { get; } = new List<string>();
        public List<Article> Articles { get; } = new List<Article>();
    }

    public sealed class SourceException : Exception
    {
        public string State { get; }
        public SourceException(string state, string message) : base(message) { State = state; }
    }

    public static class Metadata
    {
        public static XDocument ParseXml(byte[] bytes)
        {
            // 保留原始位元組於資料層；解析時禁止外部實體與網路解析，限制展開量。
            using (var stream = new MemoryStream(bytes))
            using (var reader = XmlReader.Create(stream, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Ignore, XmlResolver = null,
                MaxCharactersInDocument = 32 * 1024 * 1024, MaxCharactersFromEntities = 1024
            }))
            {
                return XDocument.Load(reader, LoadOptions.PreserveWhitespace);
            }
        }

        public static string Value(XContainer element, string name) =>
            element?.Descendants().FirstOrDefault(e => e.Name.LocalName == name)?.Value.Trim() ?? "";

        public static string NormalizeDoi(string value)
        {
            value = Regex.Replace(value.Trim(), @"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", RegexOptions.IgnoreCase);
            return value.ToLowerInvariant();
        }

        public static List<Article> ParsePubMed(byte[] xml)
        {
            var doc = ParseXml(xml);
            var error = doc.Descendants("ERROR").FirstOrDefault();
            if (error != null) { throw new SourceException("failed", "PubMed returned an API error."); }
            var result = new List<Article>();
            foreach (var record in doc.Descendants("PubmedArticle"))
            {
                var node = record.Element("MedlineCitation")?.Element("Article");
                if (node == null) { continue; }
                var article = new Article
                {
                    Pmid = Value(record.Element("MedlineCitation"), "PMID"),
                    Title = Value(node, "ArticleTitle"),
                    Journal = Value(node.Element("Journal"), "Title"),
                    PublicationTypes = string.Join("; ", node.Descendants("PublicationType").Select(e => e.Value)),
                    Abstract = string.Join("\n", node.Descendants("AbstractText").Select(e =>
                        (e.Attribute("Label") == null ? "" : e.Attribute("Label").Value + ": ") + e.Value)),
                    RawXml = record.ToString(SaveOptions.DisableFormatting),
                    RetrievedAt = DateTime.UtcNow.ToString("o")
                };
                article.Authors = string.Join("; ", node.Descendants("Author").Select(a =>
                    a.Element("CollectiveName")?.Value ?? string.Join(" ", new[] { Value(a, "ForeName"), Value(a, "LastName"), Value(a, "Suffix") }.Where(v => v.Length > 0))));
                foreach (var id in record.Element("PubmedData")?.Element("ArticleIdList")?.Elements("ArticleId") ?? Enumerable.Empty<XElement>())
                {
                    switch ((string)id.Attribute("IdType"))
                    {
                        case "doi": article.Doi = NormalizeDoi(id.Value); break;
                        case "pmc": article.Pmcid = id.Value.Trim().ToUpperInvariant(); break;
                    }
                }
                if (article.Doi.Length == 0)
                {
                    article.Doi = NormalizeDoi(node.Elements("ELocationID").FirstOrDefault(e => (string)e.Attribute("EIdType") == "doi")?.Value ?? "");
                }
                var date = node.Elements("ArticleDate").FirstOrDefault() ?? node.Element("Journal")?.Element("JournalIssue")?.Element("PubDate");
                article.Year = Value(date, "Year");
                if (article.Year.Length == 0) { article.Year = Regex.Match(Value(date, "MedlineDate"), @"\d{4}").Value; }
                article.PublicationDate = string.Join("-", new[] { article.Year, Value(date, "Month"), Value(date, "Day") }.Where(v => v.Length > 0));
                article.Pages = Value(node.Element("Pagination"), "MedlinePgn");
                // 單一數字頁碼與 PII 不能證明文章編號；保留來源頁欄，待 JATS elocation-id 補充。
                if (!Regex.IsMatch(article.Pmid, @"^\d+$") || article.Title.Length == 0)
                { throw new SourceException("failed", "PubMed record lacks required identity or title."); }
                result.Add(article);
            }
            return result;
        }
    }
}
