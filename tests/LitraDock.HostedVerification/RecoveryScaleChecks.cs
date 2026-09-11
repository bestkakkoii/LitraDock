using System.Diagnostics;
using System.Text.Json;
using Literature.Service;
using LitraDock.Core;

public static class RecoveryScaleChecks
{
    public static async Task Run(
        PgStore store,
        Guid owner,
        OriginalStore originals,
        string output,
        Action<bool, string> check
    )
    {
        var timer = Stopwatch.StartNew();
        var library = await store.CreateLibrary(owner, "1000-record synthetic transfer workload");
        var source = new LibraryFixture();
        var worker = new HostedWorker(store, originals, source);
        var run = await store.Search(library, "Synthetic transfer scale; no network", 1000);
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        var scope = await store.Scope(library, run, null, "");
        var records = JsonSerializer
            .SerializeToElement(await store.Page(library, scope, 0))
            .GetProperty("records")
            .EnumerateArray()
            .Take(8)
            .ToArray();
        foreach (var item in records)
            await store.Select(
                library,
                scope,
                item.GetProperty("article").GetProperty("SearchId").GetString(),
                true
            );
        await store.Batch(library, scope, true, Naming.DefaultTemplate);
        for (int n = 0; n < 8; n++)
            await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        var preparation = timer.ElapsedMilliseconds;
        timer.Restart();
        var archive = await store.ExportBundle(library, originals);
        var exportMs = timer.ElapsedMilliseconds;
        timer.Restart();
        var restored = await store.ImportBundle(owner, archive, originals);
        var importMs = timer.ElapsedMilliseconds;
        var restoredScope = JsonSerializer.SerializeToElement(await store.Page(restored, scope, 0));
        check(
            restoredScope.GetProperty("total").GetInt32() == 1000 && source.Fetches == 8,
            "Synthetic1000-record transfer retains full scope using only8 generated originals and0 network requests"
        );
        foreach (var item in records)
        {
            var id = item.GetProperty("article").GetProperty("SearchId").GetString();
            var before = await store.Article(library, id);
            var after = await store.Article(restored, id);
            var file = (await store.Files(library, id)).Single();
            check(
                before.Abstract == after.Abstract
                    && before.RawXml == after.RawXml
                    && originals
                        .Read(library, (string)file["hash"])
                        .SequenceEqual(originals.Read(restored, (string)file["hash"])),
                "Scale original bytes and Unicode/raw metadata preserved: " + before.Pmid
            );
        }
        await File.WriteAllTextAsync(
            Path.Combine(output, "recovery-library-scale.json"),
            JsonSerializer.Serialize(
                new
                {
                    records = 1000,
                    generatedOriginals = 8,
                    bodyCharactersPerOriginal = 262144,
                    liveRequests = 0,
                    preparationMs = preparation,
                    exportMs,
                    importMs,
                    bundleBytes = new FileInfo(archive).Length,
                    sourceLibraryDiskBytes = originals.Measure(library),
                    restoredLibraryDiskBytes = originals.Measure(restored),
                    clientPeakRssBytes = Process.GetCurrentProcess().PeakWorkingSet64,
                    processorCount = Environment.ProcessorCount,
                    scope = "Synthetic single-library transfer, not sustained multiuser capacity; process peaks include earlier verification work; CI sampler separately records host-visible relevant processes.",
                }
            )
        );
    }

    private sealed class LibraryFixture : ILiteratureSource
    {
        public string Name => "Synthetic transfer library; no external requests";
        public int Fetches;

        public Task SearchAsync(SearchSnapshot run, CancellationToken token)
        {
            run.Total = 1000;
            run.State = "complete";
            for (int i = 0; i < 1000; i++)
            {
                var pmid = (88100000 + i).ToString();
                run.SourceIds.Add(pmid);
                run.Articles.Add(
                    new Article
                    {
                        Pmid = pmid,
                        Pmcid = "PMC" + pmid,
                        Doi = "10.5555/recovery-scale-" + i,
                        Title = "Synthetic 多語 transfer record " + i,
                        Authors = "Example 群組",
                        Abstract = new string('β', 1024) + " 保留完整摘要",
                        RawXml =
                            "<synthetic><field>原始多語 metadata " + i + "</field></synthetic>",
                    }
                );
            }
            return Task.CompletedTask;
        }

        public Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken token)
        {
            Fetches++;
            return Task.FromResult(
                new SourceResponse
                {
                    Bytes = SourceChecks.Xml(article, new string('x', 262144) + " 中文 β"),
                    OriginalUri = "https://example.invalid/synthetic",
                    FinalUri = "https://example.invalid/synthetic",
                }
            );
        }
    }
}
