using System.Data;
using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using Literature.Service;
using LitraDock.Core;
using Npgsql;

public static class HostedSourceChecks
{
    public static async Task Run(
        PgStore store,
        string connection,
        string output,
        Action<bool, string> check
    )
    {
        await using var db = new NpgsqlConnection(connection);
        await db.OpenAsync();
        async Task<object> Sql(string sql, params object[] values)
        {
            await using var command = new NpgsqlCommand(sql, db);
            for (var i = 0; i < values.Length; i++)
                command.Parameters.AddWithValue("p" + i, values[i] ?? DBNull.Value);
            return await command.ExecuteScalarAsync();
        }
        check(
            Convert.ToInt32(await Sql("SELECT max(version) FROM ld_schema")) == 2,
            "Actual schema2 upgrade and prior schema1 marker retained"
        );
        check(
            Convert.ToInt32(await Sql("SELECT count(*) FROM ld_schema")) == 2,
            "Migration retains both version markers"
        );
        var account = await store.CreateAccount(
            "sources-" + Guid.NewGuid().ToString("N"),
            "Synthetic-source-password-2026"
        );
        var library = await store.CreateLibrary(account, "Mixed synthetic source library");
        var originals = new OriginalStore(Path.Combine(output, "source-originals"));
        var source = new MixedSource();
        var worker = new HostedWorker(store, originals, source);
        var run = await store.Search(library, "synthetic mixed outcomes", 7);
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        var scope = await store.Scope(library, run, null, "");
        var batch = await store.Batch(library, scope, false, "Evidence_{SearchId}_{Year}");
        for (var n = 0; n < 7; n++)
            await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        var status = JsonSerializer.SerializeToElement(await store.BatchStatus(library, batch, 0));
        var items = status.GetProperty("items").EnumerateArray().ToArray();
        check(
            status.GetProperty("state").GetString() == "completed_with_errors" && items.Length == 7,
            "Mixed batch settles with all seven durable items"
        );
        foreach (
            var state in new[]
            {
                "completed",
                "unavailable",
                "needs_login",
                "rate_wait",
                "failed",
                "challenge",
                "unsupported",
            }
        )
            check(
                items.Any(i => i.GetProperty("state").GetString() == state),
                "Durable mixed outcome " + state
            );
        var item = items[1].GetProperty("item_id").GetString();
        var id = items[1].GetProperty("search_id").GetString();
        var article = await store.Article(library, id);
        var pdf = SourceChecks.Pdf(article);
        var beforeRecords = await Sql(
            "SELECT count(*) FROM ld_records WHERE library_id=@p0",
            library
        );
        var manualJob = await store.QueueManual(
            library,
            id,
            item,
            pdf,
            "https://example.invalid/authorized-source",
            "accepted-manuscript",
            originals
        );
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        var files = await store.Files(library, id);
        var actualName = await store.OriginalName(
            library,
            id,
            Artifacts.Hash(pdf),
            OriginalValidation.PdfKind
        );
        check(
            actualName.StartsWith("Evidence_" + id)
                && actualName.EndsWith("_" + Artifacts.Hash(pdf)[..8] + ".pdf"),
            "Original download retains chosen naming template, actual PDF kind and version hash"
        );
        check(
            files.Count == 1
                && (string)files[0]["kind"] == "Original PDF"
                && originals.ObjectPath(library, Artifacts.Hash(pdf)).EndsWith(".pdf"),
            "Same unresolved item continues to actual immutable PDF"
        );
        check(
            Equals(
                beforeRecords,
                await Sql("SELECT count(*) FROM ld_records WHERE library_id=@p0", library)
            ),
            "Manual continuation does not duplicate canonical records"
        );
        check(
            (await store.Provenance(library, id)).Any(p =>
                ((string)p["details"]).Contains("accepted-manuscript")
            ),
            "Per-object manual version and rights provenance retained"
        );
        await store.QueueManual(
            library,
            id,
            item,
            pdf,
            "https://example.invalid/authorized-source",
            "accepted-manuscript",
            originals
        );
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        check(
            (await store.Files(library, id)).Count == 1
                && Directory
                    .GetFiles(Path.Combine(originals.Root, library.ToString("N"), "objects"))
                    .Length == 2
                && (await store.Provenance(library, id)).Count == 2,
            "Duplicate manual bytes keep one identical object and distinct attempts"
        );
        var version = SourceChecks.Pdf(article, "Second legitimate version");
        await store.QueueManual(library, id, item, version, "", "published", originals);
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        check(
            (await store.Files(library, id)).Count == 2
                && originals.Read(library, Artifacts.Hash(pdf)).SequenceEqual(pdf),
            "Different valid PDF version preserves original bytes"
        );
        var mismatch = SourceChecks.Record();
        mismatch.Doi = "10.1000/wrong";
        var uncertain = SourceChecks.Pdf(mismatch);
        await store.QueueManual(library, id, item, uncertain, "", "unspecified", originals);
        check(
            (string)
                await Sql(
                    "SELECT state FROM ld_items WHERE library_id=@p0 AND item_id=@p1",
                    library,
                    item
                ) == "needs_review"
                && (await store.Files(library, id)).Count == 2,
            "Uncertain PDF retained for review without an original association or false completion"
        );
        await store.ConfirmManual(library, id, item);
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        check(
            (await store.Files(library, id)).Count == 3
                && await store.IsUserConfirmed(library, id, Artifacts.Hash(uncertain)),
            "Explicit manual review creates attributed user-confirmed version"
        );
        var foreign = await store.CreateLibrary(account, "Other isolated library");
        var denied = false;
        try
        {
            await store.QueueManual(foreign, id, item, pdf, "", "published", originals);
        }
        catch (KeyNotFoundException)
        {
            denied = true;
        }
        check(
            denied && !Directory.Exists(Path.Combine(originals.Root, foreign.ToString("N"))),
            "Foreign manual record/item cannot create another library object"
        );
        await store.Select(library, scope, id, true);
        var report = await store.ExportComplete(library, scope);
        var selected = await store.ExportComplete(library, scope, true);
        using (var zip = new ZipArchive(new MemoryStream(report)))
        {
            using var reader = new StreamReader(zip.GetEntry("xl/workbook.xml").Open());
            var text = reader.ReadToEnd();
            check(
                new[]
                {
                    "Unresolved",
                    "Metadata",
                    "Provenance",
                    "Search Runs",
                    "Items",
                    "Activity",
                }.All(text.Contains),
                "Complete scoped workbook includes metadata, unresolved and traceable detail sheets"
            );
        }
        using (var zip = new ZipArchive(new MemoryStream(selected)))
        {
            var xml = System.Xml.Linq.XDocument.Load(
                zip.GetEntry("xl/worksheets/sheet1.xml").Open()
            );
            check(
                xml.Descendants().Count(e => e.Name.LocalName == "row") == 2
                    && xml.ToString().Contains(article.Doi),
                "Selected export contains exactly one record and textual identifiers"
            );
            var leading = xml.Descendants()
                .First(e => e.Name.LocalName == "row")
                .Elements()
                .Select(e => e.Value)
                .Take(8);
            var links = new StreamReader(
                zip.GetEntry("xl/worksheets/_rels/sheet1.xml.rels").Open()
            ).ReadToEnd();
            check(
                leading.SequenceEqual(ExcelExport.LeadingHeaders)
                    && links.Contains(article.DoiUri)
                    && links.Contains(article.OriginalUri)
                    && links.Contains(article.PmcUri),
                "Complete workbook preserves eight leading fields and distinct DOI/PubMed/PMC hyperlink targets"
            );
            var metadata = System.Xml.Linq.XDocument.Load(
                zip.GetEntry("xl/worksheets/sheet2.xml").Open()
            );
            var json = string.Concat(
                metadata
                    .Descendants()
                    .Where(e => e.Name.LocalName == "row")
                    .Skip(1)
                    .Select(r => r.Elements().Last().Value)
            );
            check(
                json == JsonSerializer.Serialize(await store.Article(library, id)),
                "Selected export reconstructs every canonical Article field including raw multilingual metadata exactly"
            );
        }
        check(
            (await store.ExportComplete(library, scope, false, true)).Length > 0,
            "Complete UTF-8 CSV detail bundle generated from same scope"
        );
        await File.WriteAllBytesAsync(Path.Combine(output, "synthetic-complete.xlsx"), report);
        // 真正於物件移動之後拋出錯誤，確認資料庫回滾後重開能只使用保留物件恢復。
        var manualItem = JsonSerializer.SerializeToElement(await store.ManualItem(library, id));
        var recoveryBatch = manualItem.GetProperty("batch").GetString();
        var recoveryItem = manualItem.GetProperty("item").GetString();
        var recoveryPdf = SourceChecks.Pdf(article, "Interrupted association");
        await store.QueueManual(library, id, recoveryItem, recoveryPdf, "", "published", originals);
        var claim = await store.ClaimNext();
        var input = await store.ManualInput(claim);
        var info = OriginalValidation.Validate(recoveryPdf, article);
        var response = new SourceResponse
        {
            Bytes = recoveryPdf,
            OriginalUri = "",
            FinalUri = "",
        };
        await store.PreparePublication(claim, info, response);
        var stage = originals.Stage(claim, recoveryPdf);
        try
        {
            await store.Publish(
                claim,
                article,
                info,
                response,
                originals,
                stage,
                point =>
                {
                    if (point == PublicationPoint.DuringAttach)
                        throw new IOException("Synthetic association commit failure");
                }
            );
        }
        catch (IOException) { }
        check(
            File.Exists(originals.ObjectPath(library, info.Hash))
                && !await store.Associated(library, id, info.Hash),
            "Injected post-move association failure retains object and rolls back association"
        );
        var staleRecoveryRejected = false;
        try
        {
            await store.RecoverPublication(
                claim with
                {
                    Job = "JOB-stale-synthetic",
                    Lease = Guid.NewGuid(),
                },
                article,
                originals
            );
        }
        catch (OperationCanceledException)
        {
            staleRecoveryRejected = true;
        }
        check(
            staleRecoveryRejected
                && !await store.Associated(library, id, info.Hash)
                && originals.Read(library, info.Hash).SequenceEqual(recoveryPdf),
            "Stale reconciliation claim cannot attach prepared original or alter retained bytes"
        );
        check(
            !await store.RecoverPublication(claim with { Library = foreign }, article, originals)
                && !Directory.Exists(Path.Combine(originals.Root, foreign.ToString("N"))),
            "Foreign-library reconciliation cannot discover or copy another library prepared original"
        );
        await store.PauseClaim(claim);
        await store.Control(library, recoveryBatch, "resume");
        await using (var reopened = new PgStore(connection))
            await new HostedWorker(reopened, originals, source).ExecuteClaim(
                await reopened.ClaimNext(),
                CancellationToken.None
            );
        check(
            await store.Associated(library, id, info.Hash)
                && !File.Exists(originals.RetainedStage(library, (string)input["stage_token"])),
            "Reopened worker reconciles interrupted manual publication"
        );
        var staleDenied = false;
        try
        {
            await store.Publish(claim, article, info, response, originals, stage);
        }
        catch (OperationCanceledException)
        {
            staleDenied = true;
        }
        check(
            staleDenied && originals.Read(library, info.Hash).SequenceEqual(recoveryPdf),
            "Stale publication writer rejected without original loss"
        );
        // 千筆合成範圍只排程/暫停，不製造千筆外部全文流量。
        var scaleWatch = Stopwatch.StartNew();
        var scale = new MixedSource(1000);
        var scaleRun = await store.Search(
            library,
            "1000 synthetic records; no source traffic",
            1000
        );
        await new HostedWorker(store, originals, scale).ExecuteClaim(
            await store.ClaimNext(),
            CancellationToken.None
        );
        var scaleScope = await store.Scope(library, scaleRun, null, "");
        var scaleBatch = await store.Batch(library, scaleScope, false, Naming.DefaultTemplate);
        await store.Control(library, scaleBatch, "paused");
        await store.Control(library, scaleBatch, "resume");
        await store.Control(library, scaleBatch, "cancelled");
        var count = await Sql(
            "SELECT count(*) FROM ld_items WHERE library_id=@p0 AND batch_id=@p1 AND state='cancelled'",
            library,
            scaleBatch
        );
        check(
            Convert.ToInt32(count) == 1000,
            "1000-item single scope retains exact cancelled count across pause/resume"
        );
        await File.WriteAllTextAsync(
            Path.Combine(output, "source-scale.json"),
            JsonSerializer.Serialize(
                new
                {
                    records = 1000,
                    elapsedMs = scaleWatch.ElapsedMilliseconds,
                    clientPeakWorkingSet = Process.GetCurrentProcess().PeakWorkingSet64,
                    logicalProcessors = Environment.ProcessorCount,
                    networkRequests = 0,
                    workload = "PostgreSQL save, batch create, pause/resume/cancel; excludes browser and DB process memory",
                }
            )
        );
        await BudgetChecks(store, connection, check);
        await BudgetFailureChecks.Run(store, connection, check);
        await GateProcessChecks.Run(output, check);
    }

    private static async Task BudgetChecks(
        PgStore store,
        string connection,
        Action<bool, string> check
    )
    {
        await using var db = new NpgsqlConnection(connection);
        await db.OpenAsync();
        await using (var reset = new NpgsqlCommand("UPDATE ld_source_budget SET next_at=now()", db))
            await reset.ExecuteNonQueryAsync();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var first = new HttpClient(
            new SourceRequestHandler(store, new SlowHandler(started, finished))
        );
        var firstTask = first.GetAsync(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?synthetic=slow"
        );
        await started.Task;
        using var blocked = new HttpClient(
            new SourceRequestHandler(store, new SlowHandler(new(), new()))
        );
        using var cancellation = new CancellationTokenSource(80);
        var cancelled = false;
        try
        {
            await blocked.GetAsync(
                "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?synthetic=cancel",
                cancellation.Token
            );
        }
        catch (OperationCanceledException)
        {
            cancelled = true;
        }
        check(
            cancelled && !finished.Task.IsCompleted,
            "Real cancellation token interrupts source gate wait while another body is active"
        );
        using var result = await firstTask;
        check(
            finished.Task.IsCompleted,
            "Shared request gate remains held through actual response body completion"
        );
        await using var acquire = new NpgsqlCommand("SELECT pg_try_advisory_lock(724913003)", db);
        check(
            (bool)await acquire.ExecuteScalarAsync(),
            "Cancelled waiter and successful body release pooled session gate"
        );
        await using var release = new NpgsqlCommand("SELECT pg_advisory_unlock(724913003)", db);
        await release.ExecuteNonQueryAsync();
    }

    private sealed class SlowHandler(TaskCompletionSource started, TaskCompletionSource finished)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellation
        ) =>
            Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new SlowContent(started, finished),
                }
            );
    }

    private sealed class SlowContent(TaskCompletionSource started, TaskCompletionSource finished)
        : HttpContent
    {
        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }

        protected override async Task SerializeToStreamAsync(
            Stream stream,
            TransportContext context
        )
        {
            started.TrySetResult();
            await Task.Delay(700);
            await stream.WriteAsync("synthetic"u8.ToArray());
            finished.TrySetResult();
        }
    }

    private sealed class MixedSource(int count = 7) : ILiteratureSource
    {
        public string Name => "Synthetic mixed source states";

        public Task SearchAsync(SearchSnapshot snapshot, CancellationToken token)
        {
            snapshot.Total = count + 5;
            snapshot.State = "partial";
            for (var n = 0; n < count; n++)
            {
                var a = SourceChecks.Record();
                a.SearchId = null;
                a.Pmid = (88000000 + n).ToString();
                a.Pmcid = "PMC" + a.Pmid;
                a.Doi = "10.5555/mixed-" + n;
                a.Title = "Synthetic mixed source validation " + n;
                a.RawXml =
                    "<source><language>繁體中文</language><affiliation>Example institution</affiliation></source>";
                snapshot.Articles.Add(a);
                snapshot.SourceIds.Add(a.Pmid);
            }
            return Task.CompletedTask;
        }

        public Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken token)
        {
            var index = int.Parse(article.Pmid) - 88000000;
            if (index != 0)
                throw new SourceException(
                    new[]
                    {
                        "completed",
                        "unavailable",
                        "needs_login",
                        "rate_wait",
                        "failed",
                        "challenge",
                        "unsupported",
                    }[index % 7],
                    "Synthetic source outcome; no external request."
                );
            return Task.FromResult(
                new SourceResponse
                {
                    Bytes = SourceChecks.Xml(article),
                    OriginalUri = "https://example.invalid/synthetic",
                    FinalUri = "https://example.invalid/synthetic",
                }
            );
        }
    }
}
