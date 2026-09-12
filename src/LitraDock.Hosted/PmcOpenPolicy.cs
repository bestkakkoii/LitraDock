using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using LitraDock.Core;

namespace Literature.Service;

// 政策版本是程式碼契約；擴充來源／授權需新增版本並重新驗證，不接受任意 URL 或管理端授權清單。
public static class PmcOpenPolicy
{
    public const string Id = "pmc-oai-cc-v1";
    public const string Endpoint = "https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/";
    public const string Description = "PMC OAI-PMH XML with matching identifiers and an explicit CC BY 4.0 or CC0 1.0 article grant. Repository snapshots are preserved; publisher PDF, media and requested numbered versions are not supported.";
    private static readonly XNamespace Oai = "http://www.openarchives.org/OAI/2.0/";

    public static string Location(Article article)
    {
        if (article == null || !Regex.IsMatch(article.Pmcid ?? "", @"^PMC[1-9][0-9]*$"))
            throw new SourceException("unsupported", "This policy requires an unversioned PMCID; identifier discovery and requested numbered versions are not supported. Open the record source links.");
        if (!Regex.IsMatch(article.Pmid ?? "", @"^(?:[1-9][0-9]*)?$")
            || (article.Doi ?? "") != Metadata.NormalizeDoi(article.Doi ?? ""))
            throw new SourceException("failed", "Record identifiers are malformed; review the record before acquisition.");
        return Endpoint + "?verb=GetRecord&metadataPrefix=pmc&identifier=oai:pubmedcentral.nih.gov:" + article.Pmcid[3..];
    }

    public static ArtifactInfo Validate(byte[] bytes, Article expected, string expectedSnapshot = null)
    {
        Location(expected);
        if (bytes == null || bytes.Length is < 10 or > NcbiTransport.MaximumBytes)
            Fail("Source must contain 10 bytes to 32 MiB; nothing was truncated.");
        try
        {
            var doc = Metadata.ParseXml(bytes);
            var root = doc.Root;
            if (root?.Name != Oai + "OAI-PMH") Fail("Expected a PMC OAI-PMH envelope.");
            var errors = root.Elements(Oai + "error").ToArray();
            if (errors.Length > 0)
            {
                if (root.Elements(Oai + "GetRecord").Any() || errors.Length != 1)
                    Fail("Conflicting OAI error and record response.");
                var code = (string)errors[0].Attribute("code");
                throw new SourceException(code is "idDoesNotExist" or "cannotDisseminateFormat" ? "unavailable" : "failed",
                    code is "idDoesNotExist" or "cannotDisseminateFormat"
                        ? "PMC does not provide reusable full-text XML for this record. Open the record source links."
                        : "PMC returned an unsupported OAI error; no original accepted.");
            }
            var request = One(root, Oai + "request");
            if (request.Value != Endpoint || (string)request.Attribute("verb") != "GetRecord"
                || (string)request.Attribute("metadataPrefix") != "pmc"
                || (string)request.Attribute("identifier") != "oai:pubmedcentral.nih.gov:" + expected.Pmcid[3..])
                Fail("OAI response request does not match the selected route and identity.");
            var record = One(One(root, Oai + "GetRecord"), Oai + "record");
            var header = One(record, Oai + "header");
            if (One(header, Oai + "identifier").Value != "oai:pubmedcentral.nih.gov:" + expected.Pmcid[3..])
                Fail("OAI header identity mismatch.");
            if ((string)header.Attribute("status") == "deleted")
                throw new SourceException("unavailable", "PMC reports this repository record deleted; no original accepted. Open the record source links.");
            if (header.Attribute("status") != null) Fail("Unknown OAI record status.");
            var stamp = One(header, Oai + "datestamp").Value;
            if (!DateTimeOffset.TryParseExact(stamp, ["yyyy-MM-dd", "yyyy-MM-dd'T'HH:mm:ss'Z'"], CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out _))
                Fail("Invalid OAI repository datestamp.");
            var metadata = One(record, Oai + "metadata");
            var articles = metadata.Elements().ToArray();
            if (articles.Length != 1 || articles[0].Name.LocalName != "article"
                || doc.Descendants().Count(x => x.Name.LocalName == "article") != 1)
                Fail("Expected exactly one JATS article in the OAI metadata container.");
            var article = articles[0];
            var front = OneLocal(article, "front");
            var identity = OneLocal(front, "article-meta");
            foreach (var (kind, value) in new[] { ("pmc", expected.Pmcid[3..]), ("pmid", expected.Pmid), ("doi", expected.Doi) })
            {
                var ids = identity.Elements().Where(e => e.Name.LocalName == "article-id"
                    && ((string)e.Attribute("pub-id-type") == kind || kind == "pmc" && (string)e.Attribute("pub-id-type") == "pmcid"))
                    .Select(e => kind == "doi" ? Metadata.NormalizeDoi(e.Value) : kind == "pmc" ? e.Value.Trim().Replace("PMC", "") : e.Value.Trim()).ToArray();
                if (ids.Length > 1 || (!string.IsNullOrEmpty(value) && (ids.Length != 1 || ids[0] != value)))
                    Fail("Article-level " + kind + " identity missing, duplicated or mismatched.");
            }
            var rights = ArticleRights.Assess(bytes);
            if (!rights.Permitted)
                throw new SourceException("unavailable", "Full-text rights " + rights.Status + ": " + rights.Reason + " Open the record source links.");
            var info = OriginalValidation.Validate(bytes, expected);
            // OAI datestamp 是 repository metadata 更新時間，不冒充期刊版本；SHA-256 識別實際保存的完整回應。
            if (expectedSnapshot != null && expectedSnapshot != info.Hash)
                Fail("Requested repository snapshot hash differs; no substitute version accepted.");
            info.Validation += " Policy " + Id + "; OAI datestamp " + stamp + "; repository response SHA-256 " + info.Hash
                + "; publication version unspecified; XML envelope retained unchanged; no external media acquired.";
            return info;
        }
        catch (System.Xml.XmlException)
        {
            throw new SourceException("failed", "Malformed source XML; no original accepted.");
        }
    }

    private static XElement One(XElement parent, XName name)
    {
        var children = parent.Elements(name).ToArray();
        if (children.Length != 1) Fail("Missing or ambiguous OAI response structure.");
        return children[0];
    }
    private static XElement OneLocal(XElement parent, string name)
    {
        var children = parent.Elements().Where(x => x.Name.LocalName == name).ToArray();
        if (children.Length != 1) Fail("Missing or ambiguous article structure.");
        return children[0];
    }
    [System.Diagnostics.CodeAnalysis.DoesNotReturn]
    private static void Fail(string reason) => throw new SourceException("failed", reason + " No original accepted.");
}

public sealed class PmcOpenSource(PubMedSource metadata, SourceAcquisition transport) : ICheckpointSource, IProgressSource
{
    public string Name => "PubMed metadata / " + PmcOpenPolicy.Id;
    public Task SearchAsync(SearchSnapshot run, CancellationToken token) => metadata.SearchAsync(run, token);
    public Task SearchAsync(SearchSnapshot run, CancellationToken token, Action<SearchSnapshot> checkpoint) => metadata.SearchAsync(run, token, checkpoint);
    public Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken token) => FetchFullTextAsync(article, token, null);
    public async Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken token, Action<string, string> progress)
    {
        var location = PmcOpenPolicy.Location(article);
        // 本政策拒绝轉址，不讓同一 transport 的其他已支援供應商成為權限或版本替代路由。
        var response = await transport.Request(location, token, progress, allowRedirects: false);
        PmcOpenPolicy.Validate(response.Bytes, article);
        return response;
    }
}
