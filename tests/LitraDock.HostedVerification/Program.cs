using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Literature.Service;
using LitraDock.Core;
using Microsoft.AspNetCore.Identity;
using Npgsql;

var output = Path.GetFullPath(args.ElementAtOrDefault(1) ?? ".litradock/hosted-tests");
Directory.CreateDirectory(output);
if (args.FirstOrDefault() is "--recovery-scheduler-child" or "--recovery-import-child")
{
    await RecoveryProcessChecks.Child(args[0], output);
    return;
}
var checks = new List<string>();
var watch = Stopwatch.StartNew();
string engineVersion = null;
if (args.FirstOrDefault() is "--gate-child" or "--gate-hold")
{
    await GateProcessChecks.Child(output, args[0] == "--gate-hold");
    return;
}
if (args.FirstOrDefault() == "--source-probe")
{
    if (Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes")
        throw new InvalidOperationException("Explicit synthetic test authority required.");
    await using var probeStore = new PgStore(
        Environment.GetEnvironmentVariable("LITRADOCK_PG_TEST_CONNECTION")
    );
    var probeTimes = new System.Collections.Concurrent.ConcurrentBag<long>();
    using var probeClient = new HttpMessageInvoker(
        new SourceRequestHandler(probeStore, new HeaderFixture(probeTimes))
    );
    using var response = await probeClient.SendAsync(
        new HttpRequestMessage(
            HttpMethod.Get,
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?synthetic=process-probe"
        ),
        CancellationToken.None
    );
    await File.WriteAllTextAsync(
        Path.Combine(output, "source-probe.json"),
        JsonSerializer.Serialize(probeTimes.ToArray())
    );
    return;
}
void Check(bool value, string name)
{
    if (!value)
        throw new Exception("FAILED: " + name);
    checks.Add(name);
    Console.WriteLine("PASS " + name);
}
if (args.FirstOrDefault() == "--postgres")
{
    var connection =
        Environment.GetEnvironmentVariable("LITRADOCK_PG_TEST_CONNECTION")
        ?? throw new InvalidOperationException(
            "PostgreSQL tests NOT RUN: explicit reviewed ephemeral connection required."
        );
    if (
        !new NpgsqlConnectionStringBuilder(connection).Database.StartsWith("litradock_ci_")
        || Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes"
    )
        throw new InvalidOperationException(
            "Use an explicitly authorized ephemeral litradock_ci_ database."
        );
    await UpgradeChecks.Run(connection, Check);
    await using var store = new PgStore(connection);
    await store.Migrate();
    await store.VerifySchema();
    await using (var versionDb = new NpgsqlConnection(connection))
    {
        await versionDb.OpenAsync();
        await using var query = new NpgsqlCommand("SELECT version()", versionDb);
        engineVersion = (string)await query.ExecuteScalarAsync();
    }
    var times = new System.Collections.Concurrent.ConcurrentBag<long>();
    using (
        var firstClient = new HttpMessageInvoker(
            new SourceRequestHandler(store, new HeaderFixture(times))
        )
    )
    using (
        var secondClient = new HttpMessageInvoker(
            new SourceRequestHandler(store, new HeaderFixture(times))
        )
    )
    {
        await Task.WhenAll(
            firstClient.SendAsync(
                new HttpRequestMessage(
                    HttpMethod.Get,
                    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?synthetic=one"
                ),
                CancellationToken.None
            ),
            secondClient.SendAsync(
                new HttpRequestMessage(
                    HttpMethod.Get,
                    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?synthetic=two"
                ),
                CancellationToken.None
            )
        );
        var ordered = times.OrderBy(x => x).ToArray();
        Check(
            ordered.Length == 2 && ordered[1] - ordered[0] >= 350,
            "Independent source handlers share PostgreSQL request pacing"
        );
    }
    using (
        var limited = new HttpMessageInvoker(
            new SourceRequestHandler(store, new HeaderFixture(times, true))
        )
    )
        await limited.SendAsync(
            new HttpRequestMessage(
                HttpMethod.Get,
                "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?synthetic=limited"
            ),
            CancellationToken.None
        );
    using (
        var blocked = new HttpMessageInvoker(
            new SourceRequestHandler(store, new HeaderFixture(times))
        )
    )
    {
        try
        {
            await blocked.SendAsync(
                new HttpRequestMessage(
                    HttpMethod.Get,
                    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?synthetic=blocked"
                ),
                CancellationToken.None
            );
            throw new Exception("Shared cooldown bypassed");
        }
        catch (SourceException) { }
    }
    Check(times.Count == 3, "Persisted Retry-After prevents another handler from reaching source");
    await using (var reset = new NpgsqlConnection(connection))
    {
        await reset.OpenAsync();
        await using var command = new NpgsqlCommand(
            "UPDATE ld_source_budget SET next_at=now() WHERE name='ncbi'",
            reset
        );
        await command.ExecuteNonQueryAsync();
    }
    async Task<long> Probe(int index)
    {
        var path = Path.Combine(output, "probe-" + index);
        var start = new ProcessStartInfo(Environment.ProcessPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        if (Path.GetFileNameWithoutExtension(Environment.ProcessPath) == "dotnet")
            start.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location);
        start.ArgumentList.Add("--source-probe");
        start.ArgumentList.Add(path);
        using var process = Process.Start(start);
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            await process.WaitForExitAsync(deadline.Token);
        }
        catch
        {
            process.Kill(true);
            throw;
        }
        if (process.ExitCode != 0)
            throw new Exception("Synthetic source process failed: " + await stderr);
        await stdout;
        return JsonSerializer
            .Deserialize<long[]>(
                await File.ReadAllTextAsync(Path.Combine(path, "source-probe.json"))
            )
            .Single();
    }
    var processTimes = (await Task.WhenAll(Probe(1), Probe(2))).OrderBy(x => x).ToArray();
    Check(
        processTimes[1] - processTimes[0] >= 350,
        "Two actual processes obey shared PostgreSQL source pacing with synthetic handlers"
    );
    foreach (var cancelled in new[] { false, true })
    {
        using var failing = new HttpMessageInvoker(
            new SourceRequestHandler(store, new FailureFixture(cancelled))
        );
        try
        {
            await failing.SendAsync(
                new HttpRequestMessage(
                    HttpMethod.Get,
                    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?synthetic=failure"
                ),
                CancellationToken.None
            );
            throw new Exception("Failure fixture returned success");
        }
        catch (Exception error) when (error is IOException or OperationCanceledException) { }
        await using var audit = new NpgsqlConnection(connection);
        await audit.OpenAsync();
        await using var query = new NpgsqlCommand(
            "SELECT next_at>now()+interval '1 second' FROM ld_source_budget WHERE name='ncbi'",
            audit
        );
        var cooldown = (bool)await query.ExecuteScalarAsync();
        query.CommandText = "SELECT pg_try_advisory_lock(724913003)";
        var released = (bool)await query.ExecuteScalarAsync();
        if (released)
        {
            query.CommandText = "SELECT pg_advisory_unlock(724913003)";
            await query.ExecuteNonQueryAsync();
        }
        Check(
            cooldown && released,
            cancelled
                ? "Post-dispatch cancellation retains shared cooldown and releases source gate"
                : "Post-dispatch I/O failure retains committed shared cooldown"
        );
    }
    var password = PgStore.Token();
    var login = "test-" + Guid.NewGuid().ToString("N");
    var a = await store.CreateAccount(login, password);
    var otherLogin = "other-" + Guid.NewGuid().ToString("N");
    var b = await store.CreateAccount(otherLogin, password);
    var library = await store.CreateLibrary(a, "測試 β");
    Check(
        await store.Owns(a, library) && !await store.Owns(b, library),
        "Actual PostgreSQL account/library authorization boundary"
    );
    var session = (await store.Login(login, password)).Value;
    Check(
        await store.Authenticate(session.Token) != null
            && await store.Login(login, "wrong-password-value") == null,
        "Real password login rejects incorrect password"
    );
    await store.Revoke(session.Session);
    Check(
        await store.Authenticate(session.Token) == null,
        "Database session revocation takes immediate effect"
    );
    var run = await store.Search(library, "synthetic", 120);
    var simultaneous = await Task.WhenAll(store.ClaimNext(), store.ClaimNext());
    Check(
        simultaneous.Count(c => c != null) == 1,
        "Two actual PostgreSQL claimers cannot own one queued job"
    );
    var claim = simultaneous.Single(c => c != null);
    var snapshot = new SearchSnapshot
    {
        RunId = run,
        Input = "synthetic",
        Limit = 120,
    };
    var source = new FixtureSource();
    await source.SearchAsync(snapshot, CancellationToken.None);
    await store.SaveSearch(claim, snapshot);
    await store.Finish(claim, "completed", "synthetic search saved");
    var scope = await store.Scope(library, run, null, "");
    var records = JsonSerializer.SerializeToElement(await store.Page(library, scope, 0));
    var first = records
        .GetProperty("records")[0]
        .GetProperty("article")
        .GetProperty("SearchId")
        .GetString();
    var last = JsonSerializer
        .SerializeToElement(await store.Page(library, scope, 100))
        .GetProperty("records")[19]
        .GetProperty("article")
        .GetProperty("SearchId")
        .GetString();
    await store.Select(library, scope, first, true);
    await store.Select(library, scope, last, true);
    var batch = await store.Batch(library, scope, true, Naming.DefaultTemplate);
    var originals = new OriginalStore(Path.Combine(output, "objects"));
    var worker = new HostedWorker(store, originals, source);
    for (var n = 0; n < 2; n++)
    {
        var c = await store.ClaimNext();
        await worker.ExecuteClaim(c, CancellationToken.None);
    }
    var status = JsonSerializer.SerializeToElement(await store.BatchStatus(library, batch, 0));
    Console.WriteLine(
        "SYNTHETIC_BATCH_DIAGNOSTIC "
            + JsonSerializer.Serialize(await store.BatchStatus(library, batch, 0))
    );
    Check(
        status.GetProperty("items").GetArrayLength() == 2
            && status.GetProperty("state").GetString() == "completed",
        "Cross-page stated scope persists and acquires exactly two actual objects"
    );
    try
    {
        await store.Control(library, batch, "retry");
        throw new Exception("Empty retry accepted");
    }
    catch (InvalidOperationException) { }
    Check(
        JsonSerializer
            .SerializeToElement(await store.BatchStatus(library, batch, 0))
            .GetProperty("state")
            .GetString() == "completed",
        "No eligible retry leaves completed batch unchanged"
    );
    var files = await store.Files(library, first);
    Check(
        files.Count == 1 && originals.Read(library, (string)files[0]["hash"]).Length > 0,
        "Committed original association validates real bytes"
    );
    var repeated = await store.Batch(library, scope, true, Naming.DefaultTemplate);
    for (var n = 0; n < 2; n++)
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
    Check(source.Fetches == 2, "Verified-existing skip avoids new source fetch/storage");
    var interrupted = await store.Batch(library, scope, false, Naming.DefaultTemplate);
    var stale = await store.ClaimNext();
    await store.Control(library, interrupted, "paused");
    try
    {
        await store.Finish(stale, "completed", "stale");
        throw new Exception("Stale write accepted");
    }
    catch (OperationCanceledException) { }
    Check(!await store.Renew(stale), "Pause invalidates lease and fences a stale completion");
    await store.Control(library, interrupted, "resume");
    await store.Control(library, interrupted, "cancelled");
    await store.Control(library, interrupted, "retry");
    var expired = await store.ClaimNext();
    await using (var db = new NpgsqlConnection(connection))
    {
        await db.OpenAsync();
        await using var cmd = new NpgsqlCommand(
            "UPDATE ld_jobs SET lease_until=now()-interval '1 second' WHERE library_id=$1 AND job_id=$2",
            db
        );
        cmd.Parameters.AddWithValue(library);
        cmd.Parameters.AddWithValue(expired.Job);
        await cmd.ExecuteNonQueryAsync();
    }
    await store.RecoverExpired();
    Check(
        JsonSerializer
            .SerializeToElement(await store.BatchStatus(library, interrupted, 0))
            .GetProperty("state")
            .GetString() == "paused",
        "Expired lease reopens paused with explicit continuation and attempt history"
    );
    Check(
        await store.ClaimNext() == null,
        "Expired batch recovery prevents remaining queued work from starting"
    );
    await store.Control(library, interrupted, "resume");
    var stopping = await store.ClaimNext();
    await store.PauseClaim(stopping);
    Check(
        await store.ClaimNext() == null && !await store.Renew(stopping),
        "Graceful worker stop pauses entire batch and fences its lease"
    );
    var crashBatch = await store.Batch(library, scope, true, Naming.DefaultTemplate);
    var crash = await store.ClaimNext();
    var crashArticle = await store.Article(library, crash.SearchId);
    var crashResponse = await source.FetchFullTextAsync(crashArticle, CancellationToken.None);
    crashResponse.Bytes = Encoding.UTF8.GetBytes(
        Encoding
            .UTF8.GetString(crashResponse.Bytes)
            .Replace("Synthetic 測試 β", "Retained version after interrupted publication")
    );
    var crashInfo = Artifacts.ValidateXml(crashResponse.Bytes, crashArticle);
    await store.PreparePublication(crash, crashInfo, crashResponse);
    originals.Publish(library, crashInfo.Hash, originals.Stage(crash, crashResponse.Bytes));
    var stagedClaim = await store.ClaimNext();
    var stagedArticle = await store.Article(library, stagedClaim.SearchId);
    var stagedResponse = await source.FetchFullTextAsync(stagedArticle, CancellationToken.None);
    stagedResponse.Bytes = Encoding.UTF8.GetBytes(
        Encoding
            .UTF8.GetString(stagedResponse.Bytes)
            .Replace("Synthetic 測試 β", "Retained staged legitimate version")
    );
    var stagedInfo = Artifacts.ValidateXml(stagedResponse.Bytes, stagedArticle);
    await store.PreparePublication(stagedClaim, stagedInfo, stagedResponse);
    var retainedStage = originals.Stage(stagedClaim, stagedResponse.Bytes);
    await store.PauseClaim(crash);
    Check(
        !await store.Associated(library, crash.SearchId, crashInfo.Hash)
            && originals.Read(library, crashInfo.Hash).Length > 0,
        "Interrupted file publication retains bytes without false committed association"
    );
    await using var reopenedStore = new PgStore(connection);
    await reopenedStore.Control(library, crashBatch, "resume");
    var noSource = new UnavailableFixture();
    var recovery = new HostedWorker(reopenedStore, originals, noSource);
    for (var i = 0; i < 2; i++)
        await recovery.ExecuteClaim(await reopenedStore.ClaimNext(), CancellationToken.None);
    Check(
        await store.Associated(library, crash.SearchId, crashInfo.Hash) && noSource.Fetches == 0,
        "Reopened publication reconciles valid version without refetch when source unavailable"
    );
    Check(
        await store.Associated(library, stagedClaim.SearchId, stagedInfo.Hash)
            && !File.Exists(retainedStage)
            && noSource.Fetches == 0,
        "Prepared staging recovers without refetch and removes only verified duplicate staging"
    );
    var corruptBatch = await store.Batch(library, scope, true, Naming.DefaultTemplate);
    var corruptClaim = await store.ClaimNext();
    var corruptArticle = await store.Article(library, corruptClaim.SearchId);
    var corruptResponse = await source.FetchFullTextAsync(corruptArticle, CancellationToken.None);
    corruptResponse.Bytes = Encoding.UTF8.GetBytes(
        Encoding
            .UTF8.GetString(corruptResponse.Bytes)
            .Replace("Synthetic 測試 β", "Corrupt retained candidate fixture")
    );
    var corruptInfo = Artifacts.ValidateXml(corruptResponse.Bytes, corruptArticle);
    await store.PreparePublication(corruptClaim, corruptInfo, corruptResponse);
    originals.Publish(
        library,
        corruptInfo.Hash,
        originals.Stage(corruptClaim, corruptResponse.Bytes)
    );
    File.WriteAllText(originals.ObjectPath(library, corruptInfo.Hash), "corrupt retained evidence");
    await store.PauseClaim(corruptClaim);
    await store.Control(library, corruptBatch, "resume");
    for (var i = 0; i < 2; i++)
        await recovery.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
    Check(
        JsonSerializer
            .SerializeToElement(await store.BatchStatus(library, corruptBatch, 0))
            .GetProperty("state")
            .GetString() == "completed"
            && noSource.Fetches == 0
            && !await store.Associated(library, corruptClaim.SearchId, corruptInfo.Hash),
        "Corrupt prepared candidate retains failure evidence and permits verified good-original skip"
    );
    await using (var evidenceDb = new NpgsqlConnection(connection))
    {
        await evidenceDb.OpenAsync();
        await using var query = new NpgsqlCommand(
            "SELECT EXISTS(SELECT 1 FROM ld_events WHERE library_id=$1 AND state='recovery_validation_failed' AND strpos(reason,$2)>0)",
            evidenceDb
        );
        query.Parameters.AddWithValue(library);
        query.Parameters.AddWithValue(corruptClaim.Job);
        Check(
            (bool)await query.ExecuteScalarAsync()
                && File.ReadAllText(originals.ObjectPath(library, corruptInfo.Hash))
                    == "corrupt retained evidence",
            "Corrupt prepared original bytes and attributed failure event remain retained"
        );
    }
    var other = await store.CreateLibrary(b, "Other library");
    Check(
        (await store.Files(other, first)).Count == 0
            && !await store.Associated(other, first, (string)files[0]["hash"]),
        "Guessed foreign record/hash has no cross-library association"
    );
    await using (var db = new NpgsqlConnection(connection))
    {
        await db.OpenAsync();
        await using var tx = await db.BeginTransactionAsync();
        await using var bad = new NpgsqlCommand(
            "INSERT INTO ld_article_files VALUES($1,$2,$3,'','','','')",
            db,
            tx
        );
        bad.Parameters.AddWithValue(other);
        bad.Parameters.AddWithValue(first);
        bad.Parameters.AddWithValue((string)files[0]["hash"]);
        try
        {
            await bad.ExecuteNonQueryAsync();
            throw new Exception("Cross-library FK accepted");
        }
        catch (PostgresException e) when (e.SqlState == "23503") { }
        await tx.RollbackAsync();
    }
    Check(true, "Real composite foreign key rejects cross-library original link");
    var legacyRoot = Path.Combine(output, "legacy");
    var legacy = new Library(legacyRoot);
    var legacyRun = await Workflow.SearchAsync(
        legacy,
        source,
        "fixture",
        120,
        CancellationToken.None
    );
    var oldScope = legacy.CreateScope(legacyRun.RunId);
    legacy.SelectInScope(oldScope, legacyRun.Articles[0].SearchId, true);
    var oldBatch = legacy.CreateBatch(oldScope, true);
    await new BatchEngine(legacy, source).RunAsync(oldBatch, CancellationToken.None);
    var paused = legacy.CreateBatch(oldScope, true);
    legacy.ControlBatch(paused, "paused");
    var imported = await store.ImportStoppedCopy(a, "Imported", legacyRoot, originals);
    var importedArticle = await store.Article(imported, legacyRun.Articles[0].SearchId);
    var preservedRows = await Literature.Verification.MigrationAudit.Compare(
        connection,
        legacy.DatabasePath,
        imported
    );
    Check(
        preservedRows > 0,
        "All15 source tables preserve exact raw rows, IDs, nulls, multilingual metadata and provenance: "
            + preservedRows
            + " rows"
    );
    Check(
        importedArticle.Title == legacyRun.Articles[0].Title
            && importedArticle.Pmid == legacyRun.Articles[0].Pmid
            && JsonSerializer
                .SerializeToElement(await store.BatchStatus(imported, paused, 0))
                .GetProperty("state")
                .GetString() == "paused",
        "SQLite IDs, multilingual metadata, batches and deliberate pause are active after PG import"
    );
    Check(
        (await store.Files(imported, importedArticle.SearchId))
            .Single()["hash"]
            .Equals(legacy.ReadTable("files").Rows[0]["hash"]),
        "Imported original hashes/associations remain queryable"
    );
    var concurrentWrite = false;
    using (
        var configure = new Microsoft.Data.Sqlite.SqliteConnection(
            new Microsoft.Data.Sqlite.SqliteConnectionStringBuilder
            {
                DataSource = legacy.DatabasePath,
                Mode = Microsoft.Data.Sqlite.SqliteOpenMode.ReadWrite,
                Pooling = false,
            }.ConnectionString
        )
    )
    {
        configure.Open();
        using var wal = configure.CreateCommand();
        wal.CommandText = "PRAGMA journal_mode=WAL";
        Check(
            (string)wal.ExecuteScalar() == "wal",
            "Synthetic copied SQLite uses explicit WAL for concurrent-writer snapshot test"
        );
    }
    var consistentImport = await store.ImportStoppedCopy(
        a,
        "Concurrent snapshot fixture",
        legacyRoot,
        originals,
        table =>
        {
            if (table != "articles")
                return;
            using var writer = new Microsoft.Data.Sqlite.SqliteConnection(
                new Microsoft.Data.Sqlite.SqliteConnectionStringBuilder
                {
                    DataSource = legacy.DatabasePath,
                    Mode = Microsoft.Data.Sqlite.SqliteOpenMode.ReadWrite,
                    Pooling = false,
                }.ConnectionString
            );
            writer.Open();
            using var command = writer.CreateCommand();
            command.CommandText =
                "INSERT INTO activity(state,reason,occurred_at) VALUES('snapshot_probe','Concurrent writer committed after articles snapshot','2026-09-12T00:00:00Z')";
            command.ExecuteNonQuery();
            concurrentWrite = true;
        }
    );
    await using (var snapshotDb = new NpgsqlConnection(connection))
    {
        await snapshotDb.OpenAsync();
        await using var query = new NpgsqlCommand(
            "SELECT count(*) FROM ld_legacy_rows WHERE library_id=$1 AND table_name='activity' AND data::jsonb->>'state'='snapshot_probe'",
            snapshotDb
        );
        query.Parameters.AddWithValue(consistentImport);
        Check(
            concurrentWrite
                && Convert.ToInt32(await query.ExecuteScalarAsync()) == 0
                && legacy
                    .ReadTable("activity")
                    .Rows.Cast<System.Data.DataRow>()
                    .Any(r => (string)r["state"] == "snapshot_probe"),
            "Actual concurrent SQLite writer commits while import retains one pre-write table snapshot"
        );
    }
    await using (var db = new NpgsqlConnection(connection))
    {
        await db.OpenAsync();
        await using var countCommand = new NpgsqlCommand("SELECT count(*) FROM ld_libraries", db);
        var beforeCount = await countCommand.ExecuteScalarAsync();
        var legacyPath = legacy.FilePaths(importedArticle.SearchId).Single();
        var originalBytes = File.ReadAllBytes(legacyPath);
        File.WriteAllText(legacyPath, "corrupt import fixture");
        try
        {
            await store.ImportStoppedCopy(a, "Rejected corrupt copy", legacyRoot, originals);
            throw new Exception("Corrupt import accepted");
        }
        catch (IOException) { }
        Check(
            Equals(beforeCount, await countCommand.ExecuteScalarAsync())
                && File.ReadAllText(legacyPath) == "corrupt import fixture",
            "Corrupt import rolls back destination rows without changing rejected source bytes"
        );
        File.WriteAllBytes(legacyPath, originalBytes);
    }
    await HttpNegativeTests(
        connection,
        otherLogin,
        password,
        other,
        library,
        scope,
        batch,
        first,
        (string)files[0]["hash"],
        output,
        Check
    );
    await HostedSourceChecks.Run(store, connection, output, Check);
}
else if (args.FirstOrDefault() == "--recovery")
{
    await RecoveryChecks.Run(
        Environment.GetEnvironmentVariable("LITRADOCK_PG_TEST_CONNECTION"),
        output,
        Check
    );
}
else if (args.FirstOrDefault() == "--live-sources")
{
    await LiveSourceChecks.Run(output, Check);
}
else if (args.FirstOrDefault() == "--sources")
{
    await SourceChecks.Run(Check);
}
else if (args.FirstOrDefault() == "--static")
{
    var hasher = new PasswordHasher<string>();
    var hash = hasher.HashPassword("user", "long synthetic password");
    Check(
        hasher.VerifyHashedPassword("user", hash, "wrong") == PasswordVerificationResult.Failed,
        "Framework password hashing rejects wrong password"
    );
    Check(
        PgStore.Token() != PgStore.Token()
            && PgStore.Digest("token").Length == 64
            && PgStore.Equal("abc", "abc")
            && !PgStore.Equal("abc", "abd"),
        "Session token uniqueness, digest and fixed-time comparison behavior"
    );
    var originals = new OriginalStore(Path.Combine(output, "originals"));
    var library = Guid.NewGuid();
    var bytes = Encoding.UTF8.GetBytes("synthetic original bytes");
    var digest = Artifacts.Hash(bytes);
    var claim = new Claim(
        library,
        "JOB-fixture",
        "acquire",
        null,
        "ITEM-fixture",
        "LD-fixture",
        Guid.NewGuid()
    );
    var stage = originals.Stage(claim, bytes);
    originals.Publish(library, digest, stage);
    Check(
        originals.Read(library, digest).SequenceEqual(bytes),
        "Actual staged flush/publication/hash read"
    );
    var duplicate = originals.Stage(claim with { Lease = Guid.NewGuid() }, bytes);
    originals.Publish(library, digest, duplicate);
    Check(
        !File.Exists(duplicate),
        "Verified identical publication removes only redundant staged bytes"
    );
    var content = Path.Combine(output, "app");
    Directory.CreateDirectory(content);
    originals.VerifyPrivateRoot(content);
    try
    {
        new OriginalStore(Path.Combine(content, "wwwroot", "private")).VerifyPrivateRoot(content);
        throw new Exception("Public storage accepted");
    }
    catch (InvalidOperationException) { }
    Check(true, "Startup rejects private objects under served application content");
    using (
        var locked = new FileStream(
            originals.ObjectPath(library, digest),
            FileMode.Open,
            FileAccess.Read,
            FileShare.None
        )
    )
    {
        try
        {
            originals.Read(library, digest);
            throw new Exception("Locked read accepted");
        }
        catch (IOException) { }
    }
    Check(
        originals.Read(library, digest).SequenceEqual(bytes),
        "Controlled file I/O failure retains original bytes"
    );
    File.WriteAllText(originals.ObjectPath(library, digest), "corrupt evidence");
    originals.Publish(
        library,
        digest,
        originals.Stage(claim with { Lease = Guid.NewGuid() }, bytes)
    );
    Check(
        Directory.GetFiles(Path.Combine(originals.Root, library.ToString("N"), "quarantine")).Length
            == 1,
        "Corrupt existing original quarantined without loss"
    );
    try
    {
        originals.ObjectPath(library, "../escape");
        throw new Exception("Traversal accepted");
    }
    catch (ArgumentException) { }
    Check(true, "Original path rejects unsafe hash");
    try
    {
        originals.VerifyWebRoot(originals.Root);
        throw new Exception("External public root accepted");
    }
    catch (InvalidOperationException) { }
    Check(true, "Configured external public root cannot expose originals");
    await using (
        var noDatabase = new PgStore("Host=127.0.0.1;Port=1;Database=unused;Username=unused")
    )
    {
        var missing = Path.Combine(output, "missing-copy");
        try
        {
            await noDatabase.ImportStoppedCopy(Guid.NewGuid(), "missing", missing, originals);
            throw new Exception("Missing import accepted");
        }
        catch (IOException) { }
        Check(
            !Directory.Exists(missing),
            "Missing import source rejected before database access or directory creation"
        );
        var v1 = Path.Combine(output, "v1-copy");
        Directory.CreateDirectory(v1);
        var path = Path.Combine(v1, "library.sqlite3");
        using (
            var sqlite = new Microsoft.Data.Sqlite.SqliteConnection(
                "Data Source=" + path + ";Pooling=False"
            )
        )
        {
            sqlite.Open();
            using var command = sqlite.CreateCommand();
            command.CommandText = "PRAGMA user_version=1";
            command.ExecuteNonQuery();
        }
        var before = Artifacts.Hash(File.ReadAllBytes(path));
        try
        {
            await noDatabase.ImportStoppedCopy(Guid.NewGuid(), "v1", v1, originals);
            throw new Exception("V1 import accepted");
        }
        catch (InvalidOperationException) { }
        Check(
            Artifacts.Hash(File.ReadAllBytes(path)) == before,
            "Unsupported SQLite version rejected without source migration"
        );
        using (
            var sourceLock = new FileStream(
                Path.Combine(v1, "web-host.lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
        )
        {
            try
            {
                await noDatabase.ImportStoppedCopy(Guid.NewGuid(), "active", v1, originals);
                throw new Exception("Active source accepted");
            }
            catch (IOException) { }
        }
        Check(
            Artifacts.Hash(File.ReadAllBytes(path)) == before,
            "Active-source lock rejects import before schema inspection or mutation"
        );
    }
    var workbook = HostedExport.Write(
        new[]
        {
            new Article
            {
                SearchId = "LD-synthetic",
                Title = "=2+3 測試 β",
                Pmid = "31719837",
                Pmcid = "PMC6836491",
                Doi = "10.1186/s13020-019-0270-9",
            },
        }
    );
    using (var archive = new ZipArchive(new MemoryStream(workbook)))
    {
        using var sheet = new StreamReader(archive.GetEntry("xl/worksheets/sheet1.xml").Open());
        var xml = sheet.ReadToEnd();
        Check(
            xml.Contains("inlineStr") && xml.Contains("31719837") && !xml.Contains("<f>"),
            "Hosted Excel identifiers and formula-like Unicode remain textual"
        );
        using var relationships = new StreamReader(
            archive.GetEntry("xl/worksheets/_rels/sheet1.xml.rels").Open()
        );
        Check(
            relationships.ReadToEnd().Contains("TargetMode=\"External\""),
            "Hosted Excel uses actual external hyperlink relationships"
        );
    }
    try
    {
        HostedExport.Write(new[] { new Article { Title = new string('x', 32768) } });
        throw new Exception("Truncation accepted");
    }
    catch (ArgumentException) { }
    Check(true, "Oversized Excel cell fails explicitly without truncation");
    using var schema = typeof(PgStore).Assembly.GetManifestResourceStream(
        "LitraDock.Hosted.migrations.001.sql"
    );
    Check(
        schema != null,
        "Versioned PostgreSQL migration is packaged, not proof of engine execution"
    );
}
else
    throw new ArgumentException("Choose --static or --postgres explicitly.");
await File.WriteAllTextAsync(
    Path.Combine(output, "result.json"),
    JsonSerializer.Serialize(
        new
        {
            mode = args[0],
            passed = checks.Count,
            elapsedMs = watch.ElapsedMilliseconds,
            engineVersion,
            runtime = Environment.Version.ToString(),
            os = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
            processorCount = Environment.ProcessorCount,
            peakWorkingSetBytes = Process.GetCurrentProcess().PeakWorkingSet64,
            checks,
        }
    )
);
Console.WriteLine($"PASS {checks.Count}; mode={args[0]}");

static async Task HttpNegativeTests(
    string connection,
    string login,
    string password,
    Guid library,
    Guid foreign,
    string scope,
    string batch,
    string record,
    string hash,
    string output,
    Action<bool, string> check
)
{
    var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    var port = ((IPEndPoint)listener.LocalEndpoint).Port;
    listener.Stop();
    var origin = "http://127.0.0.1:" + port;
    var project = Path.GetFullPath("src/LitraDock.Hosted");
    var dll = Path.GetFullPath("build/LitraDock.Hosted/Release/net10.0/LitraDock.Hosted.dll");
    var start = new ProcessStartInfo("dotnet")
    {
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
    };
    start.ArgumentList.Add(dll);
    start.ArgumentList.Add("--contentRoot");
    start.ArgumentList.Add(project);
    start.Environment["LITRADOCK_POSTGRES"] = connection;
    start.Environment["LITRADOCK_OBJECTS"] = Path.Combine(output, "http-objects");
    start.Environment["LITRADOCK_LOCAL_TEST"] = "true";
    start.Environment["LITRADOCK_ORIGIN"] = origin;
    start.Environment["LITRADOCK_PORT"] = port.ToString();
    using var process = Process.Start(start);
    _ = process.StandardOutput.ReadToEndAsync();
    _ = process.StandardError.ReadToEndAsync();
    try
    {
        using var handler = new HttpClientHandler { CookieContainer = new CookieContainer() };
        using var client = new HttpClient(handler)
        {
            BaseAddress = new Uri(origin),
            Timeout = TimeSpan.FromSeconds(5),
        };
        client.DefaultRequestHeaders.Add("Origin", origin);
        var ready = false;
        for (var n = 0; n < 100; n++)
        {
            try
            {
                var r = await client.GetAsync("/api/session");
                if (r.StatusCode == HttpStatusCode.Unauthorized)
                {
                    ready = true;
                    break;
                }
            }
            catch (HttpRequestException) { }
            await Task.Delay(100);
        }
        check(ready, "Actual hosted HTTP process requires authentication");
        var privatePath = Path.Combine(
            start.Environment["LITRADOCK_OBJECTS"],
            foreign.ToString("N"),
            "objects",
            hash + ".xml"
        );
        Directory.CreateDirectory(Path.GetDirectoryName(privatePath));
        File.Copy(
            Path.Combine(output, "objects", foreign.ToString("N"), "objects", hash + ".xml"),
            privatePath,
            false
        );
        var raw = await client.GetAsync("/" + foreign.ToString("N") + "/objects/" + hash + ".xml");
        check(
            File.Exists(privatePath)
                && raw.StatusCode == HttpStatusCode.NotFound
                && !(await raw.Content.ReadAsStringAsync()).Contains("Synthetic")
                && (
                    await client.GetAsync(
                        "/api/libraries/" + foreign + "/records/" + record + "/files/" + hash
                    )
                ).StatusCode == HttpStatusCode.Unauthorized,
            "Existing private original is denied through unauthenticated raw URL and download API"
        );
        async Task RejectPublicRoot(string root, string expected)
        {
            Directory.CreateDirectory(root);
            start.ArgumentList.Add("--webroot");
            start.ArgumentList.Add(root);
            using var invalid = Process.Start(start);
            var stdout = invalid.StandardOutput.ReadToEndAsync();
            var stderr = invalid.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            try
            {
                await invalid.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                invalid.Kill(true);
                await invalid.WaitForExitAsync();
            }
            var error = await stderr;
            await stdout;
            start.ArgumentList.RemoveAt(start.ArgumentList.Count - 1);
            start.ArgumentList.RemoveAt(start.ArgumentList.Count - 1);
            check(
                invalid.ExitCode != 0 && error.Contains(expected),
                "Actual host startup rejects unsafe webroot: " + expected
            );
        }
        await RejectPublicRoot(start.Environment["LITRADOCK_OBJECTS"], "separate directory trees");
        if (OperatingSystem.IsLinux())
        {
            var publicRoot = Path.Combine(output, "linked-webroot");
            Directory.CreateDirectory(publicRoot);
            Directory.CreateSymbolicLink(
                Path.Combine(publicRoot, "private"),
                start.Environment["LITRADOCK_OBJECTS"]
            );
            await RejectPublicRoot(publicRoot, "Linked public content");
        }
        var response = await client.PostAsJsonAsync("/api/login", new { login, password });
        response.EnsureSuccessStatusCode();
        var csrf = (await response.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("csrf")
            .GetString();
        check(
            (await client.PostAsJsonAsync("/api/libraries", new { value = "csrf test" })).StatusCode
                == HttpStatusCode.Forbidden,
            "Authenticated HTTP mutation without CSRF is denied"
        );
        client.DefaultRequestHeaders.Add("X-CSRF", csrf);
        foreach (var denied in new[] { "bundle", "health" })
            check(
                (
                    await client.PostAsJsonAsync(
                        "/api/libraries/" + foreign + "/" + denied,
                        new { offset = 0 }
                    )
                ).StatusCode == HttpStatusCode.NotFound,
                "Cross-user private transfer/health HTTP denial: " + denied
            );
        check(
            (await client.GetAsync("/api/libraries/" + foreign + "/next-events")).StatusCode
                == HttpStatusCode.NotFound,
            "Cross-user automatic event HTTP denial"
        );

        foreach (
            var route in new[]
            {
                "",
                "/scopes/" + scope,
                "/batches/" + batch,
                "/records/" + record,
                "/records/" + record + "/files/" + hash,
                "/history",
            }
        )
            check(
                (await client.GetAsync("/api/libraries/" + foreign + route)).StatusCode
                    == HttpStatusCode.NotFound,
                "Cross-user/unknown library HTTP denial " + route.Split('/').ElementAtOrDefault(1)
            );
        check(
            (
                await client.PostAsJsonAsync(
                    "/api/libraries/" + foreign + "/scopes/" + scope + "/export",
                    new { }
                )
            ).StatusCode == HttpStatusCode.NotFound,
            "Foreign scoped export HTTP denial"
        );
        check(
            (await client.GetAsync("/api/libraries/" + library)).IsSuccessStatusCode,
            "Authenticated owner can read own library"
        );
        foreach (
            var (route, body) in new[]
            {
                ("/search", (object)new { query = "blocked", limit = 1 }),
                ("/scopes", new { run = "RUN-guessed" }),
                ("/scopes/" + scope + "/select", new { id = record, selected = true }),
                ("/batches", new { scope, selectedOnly = false }),
                ("/batches/" + batch + "/control", new { action = "retry" }),
                ("/records/" + record + "/manual-item", new { }),
                ("/records/" + record + "/manual/ITEM-guessed/confirm", new { }),
                ("/scopes/" + scope + "/csv", new { }),
            }
        )
            check(
                (await client.PostAsJsonAsync("/api/libraries/" + foreign + route, body)).StatusCode
                    == HttpStatusCode.NotFound,
                "Foreign mutation denied: " + route
            );
        using (var upload = new ByteArrayContent(await File.ReadAllBytesAsync(privatePath)))
        {
            upload.Headers.ContentType = new("application/octet-stream");
            using var deniedUpload = await client.PostAsync(
                "/api/libraries/" + foreign + "/records/" + record + "/manual/ITEM-guessed",
                upload
            );
            check(
                deniedUpload.StatusCode == HttpStatusCode.NotFound
                    && !(await deniedUpload.Content.ReadAsStringAsync()).Contains(record),
                "Cross-user original upload denied without record/body disclosure"
            );
        }
        var revoked = await client.PostAsJsonAsync("/api/logout", new { });
        revoked.EnsureSuccessStatusCode();
        check(
            (await client.GetAsync("/api/libraries/" + library)).StatusCode
                == HttpStatusCode.Unauthorized,
            "HTTP logout revokes subsequent private library access"
        );
    }
    finally
    {
        if (!process.HasExited)
        {
            process.Kill(true);
            await process.WaitForExitAsync();
        }
    }
}

sealed class FixtureSource : ILiteratureSource
{
    public string Name => "Synthetic hosted integration fixture";
    public int Fetches { get; private set; }

    public Task SearchAsync(SearchSnapshot run, CancellationToken token)
    {
        run.Total = 150;
        run.State = "partial";
        run.Reason = "Synthetic bounded fixture";
        for (var n = 0; n < 120; n++)
        {
            var pmid = (99000000 + n).ToString();
            run.SourceIds.Add(pmid);
            run.Articles.Add(
                new Article
                {
                    Pmid = pmid,
                    Pmcid = "PMC" + pmid,
                    Doi = "10.5555/fixture-" + pmid,
                    Title = "Synthetic 測試 β " + n,
                    Authors = "Example 群組",
                    RawXml = "<synthetic />",
                }
            );
        }
        return Task.CompletedTask;
    }

    public Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken token)
    {
        Fetches++;
        var xml =
            "<article><front><article-meta><article-id pub-id-type='pmid'>"
            + article.Pmid
            + "</article-id><article-id pub-id-type='pmc'>"
            + article.Pmcid
            + "</article-id><article-id pub-id-type='doi'>"
            + article.Doi
            + "</article-id></article-meta></front><body><p>Synthetic 測試 β</p></body></article>";
        return Task.FromResult(
            new SourceResponse
            {
                Bytes = Encoding.UTF8.GetBytes(xml),
                OriginalUri = "https://example.invalid/fixture",
                FinalUri = "https://example.invalid/fixture",
            }
        );
    }
}

sealed class HeaderFixture(
    System.Collections.Concurrent.ConcurrentBag<long> times,
    bool limited = false
) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        times.Add(Environment.TickCount64);
        var response = new HttpResponseMessage(
            limited ? HttpStatusCode.TooManyRequests : HttpStatusCode.OK
        );
        if (limited)
            response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(
                TimeSpan.FromSeconds(61)
            );
        return Task.FromResult(response);
    }
}

sealed class UnavailableFixture : ILiteratureSource
{
    public int Fetches { get; private set; }
    public string Name => "Unavailable synthetic source";

    public Task SearchAsync(SearchSnapshot run, CancellationToken token) =>
        throw new NotSupportedException();

    public Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken token)
    {
        Fetches++;
        throw new SourceException("unavailable", "Synthetic unavailable source");
    }
}

sealed class FailureFixture(bool cancelled) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        if (cancelled)
            throw new OperationCanceledException("Synthetic post-dispatch cancellation");
        throw new IOException("Synthetic post-dispatch I/O failure");
    }
}
