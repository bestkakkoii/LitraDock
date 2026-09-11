using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;

namespace LitraDock.Core
{
    public sealed class SourceResponse
    {
        public byte[] Bytes { get; set; }
        public string OriginalUri { get; set; }
        public string FinalUri { get; set; }
        public string ContentType { get; set; }
    }

    public interface ILiteratureSource
    {
        string Name { get; }
        Task SearchAsync(SearchSnapshot snapshot, CancellationToken cancellation);
        Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken cancellation);
    }

    public interface ICheckpointSource : ILiteratureSource
    {
        Task SearchAsync(SearchSnapshot snapshot, CancellationToken cancellation, Action<SearchSnapshot> checkpoint);
    }

    public interface IProgressSource : ILiteratureSource
    {
        Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken cancellation, Action<string, string> progress);
    }

    public sealed class NcbiTransport : IDisposable
    {
        private static readonly SemaphoreSlim RequestGate = new SemaphoreSlim(1, 1);
        private readonly HttpClient client;
        public const int MaximumBytes = 32 * 1024 * 1024;

        public NcbiTransport(HttpMessageHandler handler = null)
        {
            client = new HttpClient(handler ?? new HttpClientHandler
            {
                AllowAutoRedirect = false,
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
                UseCookies = false
            });
            client.Timeout = TimeSpan.FromSeconds(60);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("LitraDock/0.2-local");
            client.DefaultRequestHeaders.Accept.ParseAdd("application/xml");
        }

        public static void ValidateUri(Uri uri)
        {
            if (uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length > 0 ||
                !(uri.Host == "eutils.ncbi.nlm.nih.gov" || uri.Host == "pmc.ncbi.nlm.nih.gov" || uri.Host == "www.ncbi.nlm.nih.gov"))
            { throw new SourceException("failed", "Source location is outside the permitted HTTPS endpoints."); }
        }

        public async Task<SourceResponse> GetAsync(string url, CancellationToken cancellation, Action<string, string> progress = null)
        {
            await RequestGate.WaitAsync(cancellation).ConfigureAwait(false);
            try
            {
                var uri = new Uri(url);
                var visited = new HashSet<string>();
                var retries = 0;
                var redirects = 0;
                while (true)
                {
                    ValidateUri(uri);
                    // 所有 NCBI 要求共用單一序列閘門；重試與轉址亦計入頻率限制。
                    progress?.Invoke("waiting", "Waiting for NCBI request pacing; next request after 400 ms.");
                    await Task.Delay(400, cancellation).ConfigureAwait(false);
                    using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
                    {
                        deadline.CancelAfter(TimeSpan.FromSeconds(60));
                        progress?.Invoke("resolving", "Requesting permitted NCBI endpoint; waiting for response headers.");
                        using (var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, deadline.Token).ConfigureAwait(false))
                        {
                            var status = (int)response.StatusCode;
                            if (status >= 300 && status < 400)
                            {
                                if (++redirects > 5 || !visited.Add(uri.AbsoluteUri) || response.Headers.Location == null)
                                { throw new SourceException("failed", "Redirect loop or limit reached."); }
                                uri = new Uri(uri, response.Headers.Location);
                                progress?.Invoke("redirecting", "Following source redirect " + redirects + " of at most 5; HTTPS destination is checked before request.");
                                continue;
                            }
                            if (status == 429 || status == 503 || status == 502)
                            {
                                var retry = response.Headers.RetryAfter;
                                var delay = retry?.Delta ?? (retry?.Date - DateTimeOffset.UtcNow) ?? TimeSpan.FromSeconds(2 * (retries + 1));
                                if (retries++ >= 2 || delay > TimeSpan.FromSeconds(30))
                                { throw new SourceException("failed", "Source rate limit or temporary failure; retry later."); }
                                progress?.Invoke("waiting", "Source HTTP " + status + "; bounded backoff " + Math.Max(0, delay.TotalSeconds).ToString("0") + " seconds; attempt " + (retries + 1) + " of 3.");
                                await Task.Delay(delay < TimeSpan.Zero ? TimeSpan.Zero : delay, cancellation).ConfigureAwait(false);
                                continue;
                            }
                            if (status == 401 || status == 403) { throw new SourceException("needs_login", "Source access was denied; authorized access may be required."); }
                            if (status == 404) { throw new SourceException("unavailable", "Source content is unavailable."); }
                            if (!response.IsSuccessStatusCode) { throw new SourceException("failed", "Source HTTP status " + status + "."); }
                            var contentType = response.Content.Headers.ContentType?.MediaType ?? "";
                            if (!(contentType.Contains("xml") || contentType == "text/plain"))
                            { throw new SourceException("failed", "Expected XML; source returned another content type."); }
                            if (response.Content.Headers.ContentLength > MaximumBytes)
                            { throw new SourceException("failed", "Source document exceeds the 32 MiB safety limit; nothing was truncated."); }
                            using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                            using (var buffer = new MemoryStream())
                            {
                                var chunk = new byte[65536];
                                progress?.Invoke("downloading", "Receiving source XML; total decoded bytes unknown; completion requires validation and durable publication.");
                                long reported = 0;
                                int count;
                                while ((count = await stream.ReadAsync(chunk, 0, chunk.Length, deadline.Token).ConfigureAwait(false)) > 0)
                                {
                                    if (buffer.Length + count > MaximumBytes)
                                    { throw new SourceException("failed", "Source document exceeds the 32 MiB safety limit; nothing was truncated."); }
                                    buffer.Write(chunk, 0, count);
                                    if (buffer.Length - reported >= 1024 * 1024)
                                    { reported = buffer.Length; progress?.Invoke("downloading", "Received " + reported + " decoded bytes; total unknown; validation pending."); }
                                }
                                return new SourceResponse { Bytes = buffer.ToArray(), OriginalUri = url, FinalUri = uri.AbsoluteUri, ContentType = contentType };
                            }
                        }
                    }
                }
            }
            finally { RequestGate.Release(); }
        }

        public void Dispose() { client.Dispose(); }
    }

    public sealed class PubMedSource : ICheckpointSource, IProgressSource
    {
        private readonly NcbiTransport transport;
        public string Name => "PubMed / PMC OAI-PMH";
        public PubMedSource(NcbiTransport transport) { this.transport = transport; }

        public Task SearchAsync(SearchSnapshot snapshot, CancellationToken cancellation) => SearchAsync(snapshot, cancellation, null);

        public async Task SearchAsync(SearchSnapshot snapshot, CancellationToken cancellation, Action<SearchSnapshot> checkpoint)
        {
            if (snapshot.Limit < 1 || snapshot.Limit > 10000) { throw new ArgumentOutOfRangeException(nameof(snapshot.Limit), "Choose a retrieval limit from 1 to 10000; larger PubMed searches require refinement."); }
            var query = snapshot.Input.Trim();
            if (query.Length == 0) { throw new ArgumentException("Enter a query or identifier."); }
            if (Regex.IsMatch(query, @"^PMC\d+$", RegexOptions.IgnoreCase))
            {
                var mapping = await transport.GetAsync("https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?tool=LitraDock&format=xml&ids=" + Uri.EscapeDataString(query), cancellation).ConfigureAwait(false);
                var pmid = (string)Metadata.ParseXml(mapping.Bytes).Descendants("record").FirstOrDefault()?.Attribute("pmid");
                if (string.IsNullOrEmpty(pmid)) { throw new SourceException("unavailable", "PMCID has no available PubMed mapping."); }
                query = pmid + "[uid]";
            }
            else if (Regex.IsMatch(query, @"^(PMID\s*:?\s*)?\d+$", RegexOptions.IgnoreCase))
            { query = Regex.Match(query, @"\d+$").Value + "[uid]"; }
            else if (Metadata.NormalizeDoi(query).StartsWith("10.", StringComparison.Ordinal))
            { query = "\"" + Metadata.NormalizeDoi(query).Replace("\"", "") + "\"[AID]"; }
            snapshot.SubmittedQuery = query;
            var search = await transport.GetAsync("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&tool=LitraDock&retmode=xml&sort=relevance&retmax=" + snapshot.Limit + "&term=" + Uri.EscapeDataString(query), cancellation).ConfigureAwait(false);
            var doc = Metadata.ParseXml(search.Bytes);
            if (doc.Root?.Name.LocalName != "eSearchResult" || doc.Descendants("ERROR").Any())
            { throw new SourceException("failed", "PubMed search returned an invalid response."); }
            snapshot.Total = int.Parse(Metadata.Value(doc, "Count"), System.Globalization.CultureInfo.InvariantCulture);
            snapshot.Translation = Metadata.Value(doc, "QueryTranslation");
            snapshot.SourceIds.AddRange(doc.Descendants("IdList").Elements("Id").Select(e => e.Value));
            if (snapshot.SourceIds.Count > snapshot.Limit || snapshot.SourceIds.Distinct().Count() != snapshot.SourceIds.Count || snapshot.SourceIds.Any(id => !Regex.IsMatch(id, @"^\d+$")))
            { throw new SourceException("failed", "PubMed search returned invalid or excessive record identities."); }
            snapshot.Reason = string.Join("; ", doc.Descendants("WarningList").Select(e => e.Value));
            checkpoint?.Invoke(snapshot);
            for (var start = 0; start < snapshot.SourceIds.Count; start += 100)
            {
                var ids = snapshot.SourceIds.Skip(start).Take(100).ToList();
                var fetched = await transport.GetAsync("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&tool=LitraDock&retmode=xml&id=" + string.Join(",", ids), cancellation).ConfigureAwait(false);
                var records = Metadata.ParsePubMed(fetched.Bytes);
                if (records.Any(a => !ids.Contains(a.Pmid)) || records.Select(a => a.Pmid).Distinct().Count() != records.Count)
                { throw new SourceException("failed", "PubMed metadata did not match the requested record identities."); }
                snapshot.Articles.AddRange(records.OrderBy(a => ids.IndexOf(a.Pmid)));
                checkpoint?.Invoke(snapshot);
            }
            snapshot.State = snapshot.Articles.Count == snapshot.Total ? "complete" : "partial";
            if (snapshot.State == "partial")
            { snapshot.Reason += " Retrieved " + snapshot.Articles.Count + " of " + snapshot.Total + "; requested limit " + snapshot.Limit + ". Refine the query; this slice does not retrieve the remaining records automatically."; }
        }

        public Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken cancellation) => FetchFullTextAsync(article, cancellation, null);

        public Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken cancellation, Action<string, string> progress)
        {
            if (!Regex.IsMatch(article.Pmcid, @"^PMC\d+$"))
            { throw new SourceException("unavailable", "No supported PMCID full-text route is available for this record."); }
            return transport.GetAsync("https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/?verb=GetRecord&metadataPrefix=pmc&identifier=oai:pubmedcentral.nih.gov:" + article.Pmcid.Substring(3), cancellation, progress);
        }
    }
}
