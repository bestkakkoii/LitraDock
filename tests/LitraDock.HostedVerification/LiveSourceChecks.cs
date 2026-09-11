using System.Runtime.InteropServices;
using System.Text.Json;
using Literature.Service;
using LitraDock.Core;

public static class LiveSourceChecks
{
    public static async Task Run(string output, Action<bool, string> check)
    {
        if (Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_LIVE_SOURCE_PROBE") != "yes")
            throw new InvalidOperationException(
                "Live source checks require an explicit, bounded source-policy-reviewed invocation."
            );
        var budget = new ProbeBudget();
        using var transport = new NcbiTransport(new ProbeHandler(budget));
        using var ncbi = new HttpClient(new ProbeHandler(budget));
        using var europe = new HttpClient(new ProbeHandler(budget));
        var source = new SourceAcquisition(new PubMedSource(transport), ncbi, europe);
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(4));
        var run = new SearchSnapshot { Input = "31719837", Limit = 1 };
        await source.SearchAsync(run, timeout.Token);
        check(
            run.Total == 1 && run.Articles.Count == 1,
            "Live PubMed known-record metadata resolves one result"
        );
        var article = run.Articles.Single();
        check(
            article.Pmid == "31719837"
                && article.Pmcid == "PMC6836491"
                && article.Doi == "10.1186/s13020-019-0270-9",
            "Live required identifiers match acceptance record"
        );
        var response = await source.FetchFullTextAsync(article, timeout.Token);
        var info = OriginalValidation.Validate(response.Bytes, article);
        check(
            info.ArticleNumber == "48"
                && info.EqualContribution.Contains(
                    "contributed equally",
                    StringComparison.OrdinalIgnoreCase
                ),
            "Live original preserves article number and equal-contribution metadata"
        );
        await File.WriteAllBytesAsync(Path.Combine(output, "known-original.xml"), response.Bytes);
        var observations = new List<object>
        {
            new
            {
                provider = "automatic selected route",
                state = "validated",
                bytes = info.Bytes,
                hash = info.Hash,
                source = response.OriginalUri,
                final = response.FinalUri,
                license = info.License,
            },
        };
        try
        {
            var alternate = await source.Request(
                "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC6836491/fullTextXML",
                timeout.Token
            );
            var validated = OriginalValidation.Validate(alternate.Bytes, article);
            observations.Add(
                new
                {
                    provider = "Europe PMC REST",
                    state = "validated",
                    bytes = validated.Bytes,
                    hash = validated.Hash,
                    source = alternate.OriginalUri,
                    final = alternate.FinalUri,
                    license = validated.License,
                }
            );
            await File.WriteAllBytesAsync(
                Path.Combine(output, "europe-original.xml"),
                alternate.Bytes
            );
            check(true, "Live Europe PMC open-access XML route validated independently");
        }
        catch (Exception error) when (error is SourceException or HttpRequestException)
        {
            observations.Add(
                new
                {
                    provider = "Europe PMC REST",
                    state = (error as SourceException)?.State ?? "network_failed",
                    reason = Artifacts.SafeMessage(error),
                }
            );
        }
        await File.WriteAllTextAsync(
            Path.Combine(output, "live-observations.json"),
            JsonSerializer.Serialize(
                new
                {
                    checkedAt = DateTime.UtcNow.ToString("o"),
                    os = RuntimeInformation.OSDescription,
                    runtime = RuntimeInformation.FrameworkDescription,
                    requests = budget.Count,
                    limit = 10,
                    maximumConcurrency = 1,
                    minimumDelayMs = 1000,
                    observations,
                    scope = "Windows direct public HTTPS; no shared PostgreSQL gate, no institutional session, no original PDF/media claim. Papers remain ignored local artifacts.",
                },
                new JsonSerializerOptions { WriteIndented = true }
            )
        );
    }

    private sealed class ProbeBudget
    {
        public int Count;
        public SemaphoreSlim Gate = new(1);
    }

    private sealed class ProbeHandler(ProbeBudget budget)
        : DelegatingHandler(SourceEndpoints.CreateHandler())
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellation
        )
        {
            SourceEndpoints.Provider(request.RequestUri);
            await budget.Gate.WaitAsync(cancellation);
            try
            {
                if (++budget.Count > 10)
                    throw new SourceException("failed", "Live probe request cap reached.");
                await Task.Delay(1000, cancellation);
                var response = await base.SendAsync(request, cancellation);
                try
                {
                    await response.Content.LoadIntoBufferAsync(
                        NcbiTransport.MaximumBytes,
                        cancellation
                    );
                    return response;
                }
                catch
                {
                    response.Dispose();
                    throw;
                }
            }
            finally
            {
                budget.Gate.Release();
            }
        }
    }
}
