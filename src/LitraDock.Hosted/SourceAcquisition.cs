using System.Text.RegularExpressions;
using LitraDock.Core;

namespace Literature.Service;

public sealed record SourceCapability(
    string Id,
    string Metadata,
    string FullText,
    string Access,
    string Policy
);

public sealed record ArticleLocations(
    string Doi,
    string PubMed,
    string Pmc,
    string Publisher,
    string Landing,
    string NextAction
);

// 公開位置與下載位置分開保存；不將任意網頁 URL 當成已授權全文下載端點。
public sealed class SourceAcquisition(PubMedSource metadata, HttpClient ncbi, HttpClient europe)
    : ICheckpointSource,
        IProgressSource
{
    public string Name => "PubMed metadata / PMC OAI-PMH / Europe PMC open-access XML";
    public static readonly SourceCapability[] Capabilities =
    [
        new(
            "pubmed",
            "Search and batched records",
            "Not a full-text host",
            "Public E-utilities",
            "https://www.ncbi.nlm.nih.gov/books/NBK25497/"
        ),
        new(
            "pmc",
            "PMCID mapping",
            "Reusable OAI-PMH article XML",
            "Per-article terms retained",
            "https://pmc.ncbi.nlm.nih.gov/tools/oai/"
        ),
        new(
            "europepmc",
            "Identifier discovery",
            "Open-access REST XML",
            "Per-article terms retained",
            "https://europepmc.org/RestfulWebService"
        ),
        new(
            "publisher",
            "Stable DOI landing",
            "Manual continuation",
            "Publisher/institution access is separate from product login",
            "https://pubmed.ncbi.nlm.nih.gov/help/#finding-the-full-text-article"
        ),
        new(
            "scihub",
            "Unsupported",
            "No configured permitted route",
            "No mirror, credentials or access-control bypass configured",
            ""
        ),
    ];

    public static ArticleLocations Locations(Article article) =>
        new(
            article.DoiUri,
            article.OriginalUri,
            article.PmcUri,
            "",
            article.OriginalUri.Length > 0 ? article.OriginalUri : article.DoiUri,
            "Try the supported public routes, or open a stable article link and upload an authorized original to this record."
        );

    public Task SearchAsync(SearchSnapshot snapshot, CancellationToken cancellation) =>
        metadata.SearchAsync(snapshot, cancellation);

    public Task SearchAsync(
        SearchSnapshot snapshot,
        CancellationToken cancellation,
        Action<SearchSnapshot> checkpoint
    ) => metadata.SearchAsync(snapshot, cancellation, checkpoint);

    public Task<SourceResponse> FetchFullTextAsync(
        Article article,
        CancellationToken cancellation
    ) => FetchFullTextAsync(article, cancellation, null);

    public async Task<SourceResponse> FetchFullTextAsync(
        Article article,
        CancellationToken cancellation,
        Action<string, string> progress
    )
    {
        var pmcid = article.Pmcid;
        if (!Regex.IsMatch(pmcid, "^PMC[0-9]+$"))
        {
            if (article.Pmid.Length == 0 && article.Doi.Length == 0)
                throw new SourceException(
                    "unsupported",
                    "No supported identifier route; open the source landing page and upload an authorized original."
                );
            var query =
                article.Pmid.Length > 0
                    ? "EXT_ID:" + article.Pmid + " AND SRC:MED"
                    : "DOI:\"" + article.Doi.Replace("\"", "") + "\"";
            var found = await Request(
                "https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=xml&resultType=core&pageSize=2&query="
                    + Uri.EscapeDataString(query),
                cancellation,
                progress
            );
            var records = Metadata.ParseXml(found.Bytes).Descendants("result").ToArray();
            if (records.Length != 1)
                throw new SourceException(
                    "unavailable",
                    "No unique open-access repository mapping; use the stable article links for manual continuation."
                );
            var record = records[0];
            var doi = Metadata.NormalizeDoi(Metadata.Value(record, "doi"));
            if (article.Doi.Length > 0 && doi.Length > 0 && doi != article.Doi)
                throw new SourceException(
                    "failed",
                    "Repository discovery returned a conflicting DOI; review required."
                );
            pmcid = Metadata.Value(record, "pmcid");
            if (
                !Regex.IsMatch(pmcid, "^PMC[0-9]+$")
                || Metadata.Value(record, "isOpenAccess") != "Y"
            )
                throw new SourceException(
                    "unavailable",
                    "No supported open-access full text; publisher access may require login or manual acquisition."
                );
        }
        var failures = new List<SourceException>();
        foreach (
            var route in new[]
            {
                "https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/?verb=GetRecord&metadataPrefix=pmc&identifier=oai:pubmedcentral.nih.gov:"
                    + pmcid[3..],
                "https://www.ebi.ac.uk/europepmc/webservices/rest/" + pmcid + "/fullTextXML",
            }
        )
        {
            try
            {
                progress?.Invoke(
                    "resolving",
                    "Trying "
                        + SourceEndpoints.Provider(new Uri(route))
                        + " permitted full-text route."
                );
                var response = await Request(route, cancellation, progress);
                // 路由找到的 PMCID 僅供驗證此份全文；不在背景偷偷變更 canonical identifiers。
                var expected = System.Text.Json.JsonSerializer.Deserialize<Article>(
                    System.Text.Json.JsonSerializer.Serialize(article)
                );
                expected.Pmcid = pmcid;
                var info = OriginalValidation.Validate(response.Bytes, expected);
                if (string.IsNullOrWhiteSpace(info.License))
                    throw new SourceException(
                        "unavailable",
                        "Full-text rights evidence is missing."
                    );
                return response;
            }
            catch (SourceException error)
            {
                failures.Add(error);
                progress?.Invoke(
                    "resolving",
                    SourceEndpoints.Provider(new Uri(route))
                        + " returned "
                        + error.State
                        + ": "
                        + error.Message
                );
            }
            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
            {
                failures.Add(
                    new SourceException("failed", "Source attempt timed out; retry explicitly.")
                );
            }
            catch (System.Xml.XmlException)
            {
                failures.Add(
                    new SourceException("failed", "Source XML is malformed; no original accepted.")
                );
            }
            catch (HttpRequestException)
            {
                failures.Add(
                    new SourceException(
                        "failed",
                        "Source network or TLS failed; certificate validation retained."
                    )
                );
            }
        }
        var state =
            failures.Any(f => f.State == "rate_wait") ? "rate_wait"
            : failures.Any(f => f.State == "needs_login") ? "needs_login"
            : failures.Any(f => f.State == "challenge") ? "challenge"
            : failures.Any(f => f.State == "failed") ? "failed"
            : "unavailable";
        throw new SourceException(
            state,
            string.Join(" | ", failures.Select(f => f.Message))
                + " Open a stable article link or upload an authorized original; other items continue."
        );
    }

    public static string PublicLocation(string location)
    {
        if (
            !Uri.TryCreate(location, UriKind.Absolute, out var uri)
            || uri.Scheme != "https"
            || uri.UserInfo != ""
        )
            return "";
        var clean = new UriBuilder(uri) { Fragment = "" };
        var fields = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(uri.Query);
        if (
            fields.Count != 3
            || uri.Host != "pmc.ncbi.nlm.nih.gov"
            || uri.AbsolutePath != "/api/oai/v1/mh/"
            || fields["verb"].ToString() != "GetRecord"
            || fields["metadataPrefix"].ToString() != "pmc"
            || !Regex.IsMatch(
                fields["identifier"].ToString(),
                @"^oai:pubmedcentral\.nih\.gov:[0-9]+$"
            )
        )
            clean.Query = "";
        return clean.Uri.AbsoluteUri;
    }

    public async Task<SourceResponse> Request(
        string location,
        CancellationToken cancellation,
        Action<string, string> progress = null
    )
    {
        try
        {
            return await RequestCore(location, cancellation, progress);
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        {
            throw new SourceException(
                "failed",
                "Source request timed out; retry explicitly; no deliberate pause inferred."
            );
        }
    }

    private async Task<SourceResponse> RequestCore(
        string location,
        CancellationToken cancellation,
        Action<string, string> progress = null
    )
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(TimeSpan.FromSeconds(90));
        var token = deadline.Token;
        var current = new Uri(location);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var redirects = 0;
        var retries = 0;
        while (true)
        {
            var provider = SourceEndpoints.Provider(current);
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            request.Headers.UserAgent.ParseAdd("LitraDock/0.3-source-preview");
            using var response = await (provider == "ncbi" ? ncbi : europe).SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                token
            );
            var status = (int)response.StatusCode;
            if (status >= 300 && status < 400)
            {
                if (
                    ++redirects > 5
                    || !seen.Add(current.AbsoluteUri)
                    || response.Headers.Location == null
                )
                    throw new SourceException("failed", "Redirect loop or five-hop limit reached.");
                current = new Uri(current, response.Headers.Location);
                SourceEndpoints.Provider(current);
                progress?.Invoke(
                    "redirecting",
                    "Following validated redirect " + redirects + " of at most 5."
                );
                continue;
            }
            if (status is 429 or 502 or 503)
            {
                var delay =
                    response.Headers.RetryAfter?.Delta
                    ?? (response.Headers.RetryAfter?.Date - DateTimeOffset.UtcNow)
                    ?? TimeSpan.FromSeconds(2 * (retries + 1));
                if (retries++ >= 2 || delay > TimeSpan.FromSeconds(10))
                    throw new SourceException(
                        status == 429 ? "rate_wait" : "failed",
                        "Source cooldown or retry budget reached; retry later."
                    );
                progress?.Invoke(
                    "waiting",
                    "Source HTTP " + status + "; bounded retry " + retries + " of 2."
                );
                await Task.Delay(delay < TimeSpan.Zero ? TimeSpan.Zero : delay, token);
                continue;
            }
            if (status is 401 or 403)
                throw new SourceException(
                    "needs_login",
                    "Source denied access; a user-authorized access route may be required."
                );
            if (status == 404)
                throw new SourceException(
                    "unavailable",
                    "Source does not provide this full-text record."
                );
            if (!response.IsSuccessStatusCode)
                throw new SourceException("failed", "Source HTTP " + status + ".");
            var type = response.Content.Headers.ContentType?.MediaType ?? "";
            if (type.Contains("html", StringComparison.OrdinalIgnoreCase))
                throw new SourceException(
                    "challenge",
                    "Source returned an HTML page or access challenge, not full-text XML."
                );
            if (!type.Contains("xml", StringComparison.OrdinalIgnoreCase) && type != "text/plain")
                throw new SourceException(
                    "failed",
                    "Unexpected source content type; no full text accepted."
                );
            if (response.Content.Headers.ContentLength > NcbiTransport.MaximumBytes)
                throw new SourceException("failed", "Source exceeds 32 MiB; no truncation.");
            await using var stream = await response.Content.ReadAsStreamAsync(token);
            using var buffer = new MemoryStream();
            var chunk = new byte[65536];
            progress?.Invoke(
                "validating",
                "Reading bounded source response; identity validation is still pending."
            );
            int count;
            while ((count = await stream.ReadAsync(chunk, token)) != 0)
            {
                if (buffer.Length + count > NcbiTransport.MaximumBytes)
                    throw new SourceException(
                        "failed",
                        "Decoded source exceeds 32 MiB; no truncation."
                    );
                buffer.Write(chunk, 0, count);
            }
            return new SourceResponse
            {
                Bytes = buffer.ToArray(),
                OriginalUri = PublicLocation(location),
                FinalUri = PublicLocation(current.AbsoluteUri),
                ContentType = type,
            };
        }
    }
}
