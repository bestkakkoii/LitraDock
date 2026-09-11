using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using LitraDock.Core;
using UglyToad.PdfPig;

namespace Literature.Service;

public static class OriginalValidation
{
    public const string XmlKind = "Source XML";
    public const string PdfKind = "Original PDF";

    public static string Kind(byte[] bytes) =>
        bytes.AsSpan().StartsWith("%PDF-"u8) ? PdfKind : XmlKind;

    public static string Extension(string kind) => kind == PdfKind ? ".pdf" : ".xml";

    public static ArtifactInfo Validate(byte[] bytes, Article article, bool confirmed = false)
    {
        if (bytes.Length is < 10 or > NcbiTransport.MaximumBytes)
            throw new SourceException(
                "failed",
                "Original must contain 10 bytes to 32 MiB; nothing was truncated."
            );
        if (Kind(bytes) == PdfKind)
            return PdfInspection.Inspect(bytes, article, confirmed).GetAwaiter().GetResult();
        var doc = Metadata.ParseXml(bytes);
        if (doc.Root?.Name.LocalName.Equals("html", StringComparison.OrdinalIgnoreCase) == true)
            throw new SourceException(
                "challenge",
                "HTML/login/challenge pages are not accepted as source XML."
            );
        var articles = doc.Descendants().Where(e => e.Name.LocalName == "article").ToArray();
        if (articles.Length != 1)
            throw new SourceException("failed", "Expected exactly one source article.");
        var front = articles[0].Elements().FirstOrDefault(e => e.Name.LocalName == "front");
        var identity =
            front?.Descendants().Where(e => e.Name.LocalName == "article-id").ToArray() ?? [];
        foreach (var kind in new[] { "doi", "pmid", "pmc" })
        {
            var values = identity
                .Where(e =>
                    (string)e.Attribute("pub-id-type") == kind
                    || kind == "pmc" && (string)e.Attribute("pub-id-type") == "pmcid"
                )
                .Select(e =>
                    kind == "doi" ? Metadata.NormalizeDoi(e.Value)
                    : kind == "pmc" ? e.Value.Trim().ToUpperInvariant().Replace("PMC", "")
                    : e.Value.Trim()
                )
                .Where(v => v.Length > 0)
                .Distinct()
                .ToArray();
            if (values.Length > 1)
                throw new SourceException(
                    "failed",
                    "Source article contains conflicting " + kind + " identifiers; review required."
                );
        }
        var expected = JsonSerializer.Deserialize<Article>(JsonSerializer.Serialize(article));
        if (expected.Pmcid.Length == 0)
        {
            var ids = doc.Descendants().Where(e => e.Name.LocalName == "article-id").ToArray();
            var doi = Metadata.NormalizeDoi(
                ids.FirstOrDefault(e => (string)e.Attribute("pub-id-type") == "doi")?.Value ?? ""
            );
            var pmid =
                ids.FirstOrDefault(e => (string)e.Attribute("pub-id-type") == "pmid")?.Value.Trim()
                ?? "";
            if (
                !(article.Doi.Length > 0 && doi == article.Doi)
                && !(article.Pmid.Length > 0 && pmid == article.Pmid)
            )
                throw new SourceException(
                    "failed",
                    "Original identity cannot be matched to this record; no association created."
                );
            var pmc =
                ids.FirstOrDefault(e => (string)e.Attribute("pub-id-type") is "pmc" or "pmcid")
                    ?.Value.Trim()
                    .ToUpperInvariant()
                ?? "";
            expected.Pmcid = pmc.StartsWith("PMC", StringComparison.Ordinal) ? pmc : "PMC" + pmc;
        }
        var info = Artifacts.ValidateXml(bytes, expected);
        if (!doc.Descendants().Any(e => e.Name.LocalName == "license"))
            info.License =
                "No article license statement supplied; no redistribution permission inferred. Access route recorded separately.";
        return info;
    }

    // 只接受可讀且前兩頁包含選定作品 DOI 的 PDF；掃描件/身分不明檔不會自動冒充匹配。
    // 這是身分與容器驗證，不是視覺保真、惡意程式掃描或授權判決。
    public static ArtifactInfo ValidatePdf(byte[] bytes, Article article, bool confirmed = false)
    {
        try
        {
            using var pdf = PdfDocument.Open(bytes);
            if (pdf.NumberOfPages is < 1 or > 300)
                throw new SourceException(
                    "failed",
                    "PDF page count is outside the supported 1–300 page validation limit."
                );
            var firstPage = pdf.GetPage(1).Text;
            var text = string.Join(
                " ",
                Enumerable.Range(1, Math.Min(2, pdf.NumberOfPages)).Select(n => pdf.GetPage(n).Text)
            );
            var doiTokens = Regex
                .Matches(text, @"10\.[0-9]{4,9}/[-._;()/:A-Z0-9]+", RegexOptions.IgnoreCase)
                .Select(m => m.Value.TrimEnd('.', ',', ';').ToLowerInvariant())
                .ToArray();
            static string NormalizeTitle(string value) =>
                Regex.Replace(value, @"[^\p{L}\p{N}]", "").ToLowerInvariant();
            var title = NormalizeTitle(article.Title);
            var titleMatches =
                title.Length >= 15
                && NormalizeTitle(firstPage.Length > 2000 ? firstPage[..2000] : firstPage)
                    .Contains(title, StringComparison.Ordinal);
            var identified =
                article.Doi.Length > 0
                && doiTokens.Contains(article.Doi.ToLowerInvariant())
                && titleMatches;
            if (!identified && !confirmed)
                throw new SourceException(
                    "needs_review",
                    "PDF container is readable but its exact DOI and title were not jointly verified; review the original before confirming its relationship to this record."
                );
            return new ArtifactInfo
            {
                Hash = Artifacts.Hash(bytes),
                Bytes = bytes.Length,
                RelativePath = "objects/" + Artifacts.Hash(bytes) + ".pdf",
                License = "User-supplied original; no redistribution license inferred.",
                Validation =
                    "PdfPig 0.1.14 parsed "
                    + pdf.NumberOfPages
                    + " pages; "
                    + (
                        identified
                            ? "exact DOI token and title jointly matched"
                            : "identity explicitly confirmed by the uploading account; not machine verified"
                    )
                    + "; original bytes preserved; visual fidelity and malware scan not established.",
                MetadataXml = "",
                ArticleNumber = "",
                EqualContribution = "",
            };
        }
        catch (SourceException)
        {
            throw;
        }
        catch (Exception)
        {
            throw new SourceException(
                "failed",
                "PDF could not be safely parsed; no original association created."
            );
        }
    }
}
