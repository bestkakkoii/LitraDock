using System.Net;
using System.Text;
using Literature.Service;
using LitraDock.Core;
using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.Core;
using UglyToad.PdfPig.Fonts.Standard14Fonts;
using UglyToad.PdfPig.Writer;

public static class SourceChecks
{
    public static Article Record() =>
        new()
        {
            SearchId = "LD-synthetic-source",
            Pmid = "31719837",
            Pmcid = "PMC6836491",
            Doi = "10.1186/s13020-019-0270-9",
            Title = "Synthetic source validation",
            Authors = "Example 群組",
            Year = "2019",
        };

    public static byte[] Xml(Article a, string body = "Synthetic β 測試") =>
        Encoding.UTF8.GetBytes(
            "<article><front><article-meta><article-id pub-id-type='pmc'>"
                + a.Pmcid
                + "</article-id><article-id pub-id-type='pmid'>"
                + a.Pmid
                + "</article-id><article-id pub-id-type='doi'>"
                + a.Doi
                + "</article-id><permissions><license>CC BY 4.0 synthetic fixture only</license></permissions></article-meta></front><body><p>"
                + body
                + "</p></body></article>"
        );

    public static byte[] Pdf(Article a, string version = "One")
    {
        var builder = new PdfDocumentBuilder();
        var page = builder.AddPage(PageSize.A4);
        var font = builder.AddStandard14Font(Standard14Font.Helvetica);
        page.AddText(a.Title + " " + version, 12, new PdfPoint(20, 700), font);
        page.AddText(a.Doi, 12, new PdfPoint(20, 675), font);
        return builder.Build();
    }

    public static async Task Run(Action<bool, string> check)
    {
        var sensitive = System.Text.Json.JsonSerializer.Serialize(
            new
            {
                RawXml = "<ext-link href='https://user:SECRET@example.invalid/paper?token=SECRET#SECRET'>title</ext-link>",
            }
        );
        var shareable = ExportPrivacy.Text(sensitive);
        check(
            !shareable.Contains("SECRET") && shareable.Contains("example.invalid/paper"),
            "Shareable metadata projection redacts credentials and temporary URLs nested in XML/JSON"
        );
        var longUnicode = new string('a', 29999) + "😀繁體中文" + new string('b', 4000);
        var workbook = ScopedWorkbook.Write(
            new() { ["Records"] = [new[] { "Title" }, new[] { longUnicode }] },
            false
        );
        using (var archive = new System.IO.Compression.ZipArchive(new MemoryStream(workbook)))
        {
            var doc = System.Xml.Linq.XDocument.Load(
                archive.GetEntry("xl/worksheets/sheet2.xml").Open()
            );
            var parts = doc.Descendants()
                .Where(e => e.Name.LocalName == "row")
                .Skip(1)
                .Select(row => row.Elements().Last().Value);
            check(
                string.Concat(parts) == longUnicode,
                "Excel overflow preserves surrogate pairs and complete multilingual field"
            );
        }
        var csv = ScopedWorkbook.Write(
            new()
            {
                ["Records"] =
                [
                    new[] { "Title" },
                    new[] { " \n=HYPERLINK(\"https://example.invalid\")" },
                ],
            },
            true
        );
        using (var archive = new System.IO.Compression.ZipArchive(new MemoryStream(csv)))
        using (var text = new StreamReader(archive.GetEntry("Records.csv").Open()))
            check(
                text.ReadToEnd().Contains("\"' \n=HYPERLINK"),
                "CSV neutralizes formula payload after leading whitespace"
            );
        check(
            SourceAcquisition.PublicLocation(
                "https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/?verb=secret&metadataPrefix=pmc&identifier=token#secret"
            ) == "https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/",
            "Export provenance strips query secrets even under allowed field names"
        );
        foreach (
            var address in new[]
            {
                "127.0.0.1",
                "10.0.0.1",
                "172.16.0.1",
                "192.168.1.1",
                "169.254.169.254",
                "100.64.0.1",
                "::1",
                "::ffff:127.0.0.1",
                "fc00::1",
                "fe80::1",
                "2001:db8::1",
                "2001:2::1",
                "3fff::1",
                "2002:7f00:1::",
            }
        )
            check(
                !SourceEndpoints.IsPublic(IPAddress.Parse(address)),
                "Source rejects private/reserved address " + address
            );
        check(
            SourceEndpoints.IsPublic(IPAddress.Parse("8.8.8.8"))
                && SourceEndpoints.IsPublic(IPAddress.Parse("2606:4700::1111")),
            "Public v4/v6 classification"
        );
        foreach (
            var url in new[]
            {
                "http://pmc.ncbi.nlm.nih.gov/api/oai/",
                "https://user:password@pmc.ncbi.nlm.nih.gov/api/oai/",
                "https://pmc.ncbi.nlm.nih.gov:444/api/oai/",
                "https://127.0.0.1/",
                "https://pmc.ncbi.nlm.nih.gov/articles/PMC1/",
                "https://pmc.ncbi.nlm.nih.gov.evil.invalid/api/oai/",
            }
        )
        {
            var denied = false;
            try
            {
                SourceEndpoints.Provider(new Uri(url));
            }
            catch (SourceException)
            {
                denied = true;
            }
            check(denied, "Source endpoint denied " + new Uri(url).Host);
        }
        var article = Record();
        var xml = Xml(article);
        check(
            OriginalValidation.Validate(xml, article).Hash == Artifacts.Hash(xml),
            "Original XML identity and bytes preserved"
        );
        var pdf = Pdf(article);
        check(
            OriginalValidation.Validate(pdf, article).Hash == Artifacts.Hash(pdf)
                && OriginalValidation.Kind(pdf) == "Original PDF",
            "Real synthetic PDF parsed with DOI evidence"
        );
        check(
            Artifacts.Hash(Pdf(article, "Two")) != Artifacts.Hash(pdf),
            "Legitimate PDF versions remain distinct"
        );
        var other = Record();
        other.Doi = "10.5555/wrong";
        foreach (
            var bytes in new[]
            {
                Pdf(other),
                Encoding.UTF8.GetBytes("<html><body>Sign in</body></html>"),
                Encoding.UTF8.GetBytes("%PDF-1.7 corrupt bytes"),
            }
        )
        {
            var denied = false;
            try
            {
                OriginalValidation.Validate(bytes, article);
            }
            catch (Exception)
            {
                denied = true;
            }
            check(denied, "Mismatch/challenge/corrupt original rejected");
        }
        var conflictXml = Encoding.UTF8.GetBytes(
            Encoding
                .UTF8.GetString(xml)
                .Replace(
                    "</article-meta>",
                    "<article-id pub-id-type='doi'>10.5555/conflicting</article-id></article-meta>"
                )
        );
        var rejectedConflict = false;
        try
        {
            OriginalValidation.Validate(conflictXml, article);
        }
        catch (SourceException)
        {
            rejectedConflict = true;
        }
        check(rejectedConflict, "Duplicate conflicting XML identifiers rejected");
        var prefixRecord = Record();
        prefixRecord.Doi = "10.1000/abc";
        var prefixFile = Record();
        prefixFile.Doi = "10.1000/abcd";
        var review = false;
        try
        {
            OriginalValidation.Validate(Pdf(prefixFile), prefixRecord);
        }
        catch (SourceException error)
        {
            review = error.State == "needs_review";
        }
        check(review, "PDF DOI prefix collision requires identity review");
        var citation = Record();
        citation.Title = "A different article citing the selected work";
        review = false;
        try
        {
            OriginalValidation.Validate(Pdf(citation), article);
        }
        catch (SourceException error)
        {
            review = error.State == "needs_review";
        }
        check(review, "DOI citation without matching article title requires review");
        check(
            OriginalValidation
                .Validate(Pdf(citation), article, true)
                .Validation.Contains("not machine verified"),
            "Explicit user identity attestation remains distinct from automatic verification"
        );
        var stages = new List<string>();
        var reasons = new List<string>();
        using var ncbi = new HttpClient(
            new Routes((_, _) => new HttpResponseMessage(HttpStatusCode.NotFound))
        );
        using var europe = new HttpClient(new Routes((_, _) => XmlResponse(xml)));
        using var transport = new NcbiTransport(new Routes((_, _) => XmlResponse(xml)));
        var source = new SourceAcquisition(new PubMedSource(transport), ncbi, europe);
        var result = await source.FetchFullTextAsync(
            article,
            CancellationToken.None,
            (state, reason) =>
            {
                stages.Add(state);
                reasons.Add(reason);
            }
        );
        check(
            result.FinalUri.Contains("ebi.ac.uk")
                && !stages.Contains("unavailable")
                && reasons.Any(r => r.Contains("returned unavailable"))
                && result.Bytes.SequenceEqual(xml),
            "Unavailable PMC falls back to validated Europe PMC XML"
        );
        var root = "https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/?verb=Identify";
        foreach (
            var scenario in new[]
            {
                "hops",
                "loop",
                "unsafe",
                "login",
                "challenge",
                "rate",
                "transient",
                "large",
            }
        )
        {
            var calls = 0;
            using var client = new HttpClient(
                new Routes(
                    (request, _) =>
                    {
                        calls++;
                        if (scenario is "hops" or "loop" or "unsafe")
                        {
                            if (scenario == "hops" && calls == 3)
                                return XmlResponse(xml);
                            var redirect = new HttpResponseMessage(HttpStatusCode.Found);
                            redirect.Headers.Location = new Uri(
                                scenario == "unsafe" ? "http://127.0.0.1/private"
                                : scenario == "loop" ? root
                                : root + calls
                            );
                            return redirect;
                        }
                        if (scenario == "login")
                            return new HttpResponseMessage(HttpStatusCode.Unauthorized);
                        if (scenario == "challenge")
                            return new HttpResponseMessage(HttpStatusCode.OK)
                            {
                                Content = new StringContent(
                                    "Login challenge",
                                    Encoding.UTF8,
                                    "text/html"
                                ),
                            };
                        if (scenario is "rate" or "transient")
                        {
                            if (scenario == "transient" && calls == 2)
                                return XmlResponse(xml);
                            var limited = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
                            limited.Headers.RetryAfter =
                                new System.Net.Http.Headers.RetryConditionHeaderValue(
                                    TimeSpan.FromSeconds(scenario == "rate" ? 60 : 0)
                                );
                            return limited;
                        }
                        var large = XmlResponse(xml);
                        large.Content.Headers.ContentLength = NcbiTransport.MaximumBytes + 1;
                        return large;
                    }
                )
            );
            var tested = new SourceAcquisition(new PubMedSource(transport), client, client);
            var state = "success";
            try
            {
                await tested.Request(root, CancellationToken.None);
            }
            catch (SourceException error)
            {
                state = error.State;
            }
            check(
                state
                    == (
                        scenario switch
                        {
                            "hops" or "transient" => "success",
                            "unsafe" => "unsupported",
                            "login" => "needs_login",
                            "challenge" => "challenge",
                            "rate" => "rate_wait",
                            _ => "failed",
                        }
                    ),
                "Bounded transport scenario " + scenario
            );
            check(calls <= 3, "Request bound for " + scenario);
        }
    }

    private static HttpResponseMessage XmlResponse(byte[] bytes) =>
        new(HttpStatusCode.OK)
        {
            Content = new ByteArrayContent(bytes)
            {
                Headers =
                {
                    ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(
                        "application/xml"
                    ),
                },
            },
        };

    private sealed class Routes(
        Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> response
    ) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellation
        ) => Task.FromResult(response(request, cancellation));
    }
}
