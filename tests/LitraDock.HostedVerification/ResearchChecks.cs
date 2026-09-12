using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Literature.Service;
using LitraDock.Core;
using Npgsql;

public static class ResearchChecks
{
    public static async Task Run(string connection, string output, Action<bool, string> check)
    {
        var config = new NpgsqlConnectionStringBuilder(connection);
        if (
            !config.Database.StartsWith("litradock_ci_")
            || Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes"
        )
            throw new InvalidOperationException("Explicit disposable PostgreSQL required.");
        await using (var admin = new NpgsqlConnection(connection))
        {
            await admin.OpenAsync();
            config.Database = "litradock_ci_research_" + Guid.NewGuid().ToString("N")[..12];
            await using var create = new NpgsqlCommand("CREATE DATABASE " + config.Database, admin);
            await create.ExecuteNonQueryAsync();
        }
        await using var store = new PgStore(config.ConnectionString);
        await store.Migrate();
        await using var db = new NpgsqlConnection(config.ConnectionString);
        await db.OpenAsync();
        async Task<object> Sql(string sql, params object[] args)
        {
            await using var cmd = new NpgsqlCommand(sql, db);
            for (var i = 0; i < args.Length; i++)
                cmd.Parameters.AddWithValue("p" + i, args[i] ?? DBNull.Value);
            return await cmd.ExecuteScalarAsync();
        }
        async Task Reject(Func<Task> action, string name)
        {
            var failed = false;
            try
            {
                await action();
            }
            catch
            {
                failed = true;
            }
            check(failed, name);
        }
        var owner = await store.CreateAccount("research-owner", "Synthetic-research-password-2026");
        var other = await store.CreateAccount("research-other", "Synthetic-research-password-2026");
        var library = await store.CreateLibrary(owner, "Research 中文 library");
        var originals = new OriginalStore(Path.Combine(output, "originals"));
        var worker = new HostedWorker(store, originals, new ResearchFixture());
        var run = await store.Search(library, "synthetic research", 120);
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        var scope = await store.Scope(library, run, null, "");
        var records = JsonSerializer
            .SerializeToElement(await store.Page(library, scope, 0))
            .GetProperty("records")
            .EnumerateArray()
            .ToArray();
        var id = records[0].GetProperty("article").GetProperty("SearchId").GetString();
        var excluded = records[1].GetProperty("article").GetProperty("SearchId").GetString();
        await store.Select(library, scope, id, true);
        await store.Batch(library, scope, true, Naming.DefaultTemplate);
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        var original = (await store.Files(library, id)).Single();
        var hash = (string)original["hash"];
        var bytes = originals.Read(library, hash);
        var a = await store.CreateProject(library, "Project A");
        var b = await store.CreateProject(library, "Project B");
        var evidence = JsonSerializer.Serialize(
            new
            {
                hash,
                quote = "Synthetic 測試 β",
                section = "body",
                page = "1",
                pageKind = "source",
                runId = run,
            }
        );
        await store.SaveReview(
            library,
            a,
            id,
            owner,
            new("included", "中文;science", "Preserved note", "Relevant", evidence, 0)
        );
        await store.SaveReview(
            library,
            b,
            id,
            owner,
            new("excluded", "other", "Independent decision", "Wrong population", "{}", 0)
        );
        check(
            Convert.ToInt64(
                await Sql(
                    "SELECT count(DISTINCT state) FROM ld_reviews WHERE library_id=@p0 AND search_id=@p1",
                    library,
                    id
                )
            ) == 2,
            "Same canonical record has opposing decisions in two persistent projects"
        );
        await Reject(
            () =>
                store.SaveReview(library, a, id, owner, new("excluded", "", "stale", "", "{}", 0)),
            "Stale review revision rejects without destroying current note"
        );
        await Reject(
            () =>
                store.SaveReview(
                    library,
                    a,
                    excluded,
                    owner,
                    new("included", "", "", "", evidence, 0)
                ),
            "Evidence hash from a different record cannot become a screening locator"
        );
        var missing = await store.CreateLibrary(other, "Other tenant");
        await Reject(
            () => store.SaveReview(missing, a, id, other, new("included", "", "", "", "{}", 0)),
            "Foreign project/record graph cannot cross library ownership"
        );
        var key = await store.QueueConversion(library, id, hash, "original", owner, originals);
        var claim = await store.ClaimConversion();
        var second = await store.ClaimConversion();
        check(second == null, "Concurrent-equivalent claim cannot duplicate running conversion");
        var reading = new ReadingWorker(store, originals);
        await reading.Execute(
            claim,
            CancellationToken.None,
            point =>
            {
                if (point == "published")
                    throw new IOException("Synthetic interrupted association.");
            }
        );
        check(
            (string)
                await Sql(
                    "SELECT state FROM ld_conversions WHERE library_id=@p0 AND conversion_id=@p1",
                    library,
                    key
                ) == "failed"
                && Convert.ToInt64(
                    await Sql("SELECT count(*) FROM ld_derivations WHERE library_id=@p0", library)
                ) == 0,
            "Post-publication interruption retains failed evidence without a derived association"
        );
        await store.ControlConversion(library, key, "retry", owner);
        var recovered = await store.ClaimConversion();
        await reading.Execute(recovered, CancellationToken.None);
        check(
            (string)
                await Sql(
                    "SELECT state FROM ld_conversions WHERE library_id=@p0 AND conversion_id=@p1",
                    library,
                    key
                ) == "completed",
            "Reopened retry reconciles prepared derived publication"
        );
        check(
            originals.Read(library, hash).SequenceEqual(bytes)
                && (await store.Files(library, id)).Count == 1,
            "Reading output preserves original bytes and cannot become an acquisition original"
        );
        check(
            await store.QueueConversion(library, id, hash, "original", owner, originals) == key,
            "Identical completed conversion request reuses its durable identity"
        );
        var derivedHash = (string)
            await Sql(
                "SELECT hash FROM ld_derivations WHERE library_id=@p0 AND conversion_id=@p1",
                library,
                key
            );
        var derivedBytes = originals.Read(library, derivedHash);
        await store.SaveReview(
            library,
            a,
            id,
            owner,
            new(
                "included",
                "中文;science",
                "Exact derived quote",
                "Relevant",
                JsonSerializer.Serialize(
                    new
                    {
                        hash = derivedHash,
                        quote = "Synthetic",
                        page = "1",
                        pageKind = "derived",
                    }
                ),
                1
            )
        );
        check(
            Convert.ToInt64(
                await Sql("SELECT count(*) FROM ld_review_events WHERE library_id=@p0", library)
            ) == 3,
            "Decision edits retain original and derived page attribution in immutable events"
        );
        var cancel = await store.QueueConversion(
            library,
            excluded,
            null,
            "abstract",
            owner,
            originals
        );
        await store.ControlConversion(library, cancel, "cancel", owner);
        check(
            await store.ClaimConversion() == null,
            "Deliberately cancelled conversion never claimed after reopen"
        );
        var xml = Encoding.UTF8.GetBytes(
            "<PubmedArticle><MedlineCitation><PMID>999</PMID><Article><ArticleTitle>Unicode &amp; citation</ArticleTitle><Journal><Title>Example Journal</Title><JournalIssue><Volume>14</Volume><Issue>2</Issue><PubDate><Year>2020</Year></PubDate></JournalIssue></Journal><AuthorList><Author><LastName>王</LastName><ForeName>小明</ForeName></Author><Author><CollectiveName>Research Council</CollectiveName></Author></AuthorList></Article></MedlineCitation></PubmedArticle>"
        );
        var mapped = Metadata.ParsePubMed(xml).Single();
        mapped.SearchId = "LD-STRUCTURED";
        mapped.ArticleNumber = "e48";
        var csl = CitationMetadata.Map(mapped);
        check(
            csl["author"][0]["family"].ToString() == "王"
                && csl["author"][1]["literal"].ToString() == "Research Council"
                && csl["number"].ToString() == "e48"
                && csl["page"].ToString() == "",
            "Ordered structured/corporate authors and article number remain distinct from pages"
        );
        await File.WriteAllTextAsync(
            Path.Combine(output, "interchange.ris"),
            CitationMetadata.Ris(new[] { csl })
        );
        await File.WriteAllTextAsync(
            Path.Combine(output, "interchange.bib"),
            CitationMetadata.BibTex(new[] { csl })
        );
        await File.WriteAllTextAsync(
            Path.Combine(output, "interchange.csl.json"),
            csl.ToJsonString()
        );
        var citations = await store.CitationExport(
            library,
            scope,
            true,
            "apa",
            CancellationToken.None
        );
        check(
            citations["items"].AsArray().Count == 1 && citations["items"][0]["id"].ToString() == id,
            "Actual CSL processor receives exact selected scope only"
        );
        check(
            !citations.ToJsonString().Contains(excluded),
            "Citation output excludes unselected record identity"
        );
        foreach (var csv in new[] { false, true })
        {
            var report = await store.ExportComplete(library, scope, true, csv);
            using var zip = new ZipArchive(new MemoryStream(report));
            var text = string.Join(
                "\n",
                zip.Entries.Where(x => x.Length < 8 * 1024 * 1024)
                    .Select(x =>
                    {
                        using var r = new StreamReader(x.Open());
                        return r.ReadToEnd();
                    })
            );
            check(
                text.Contains("Reviews") && text.Contains("Citations") && !text.Contains(excluded),
                "Scoped report includes reviews/citations/derived details without unselected identity; CSV="
                    + csv
            );
        }
        var bundle = await store.ExportBundle(library, originals, scope, true);
        var imported = await store.ImportBundle(other, bundle, originals);
        check(
            Convert.ToInt64(
                await Sql("SELECT count(*) FROM ld_records WHERE library_id=@p0", imported)
            ) == 1
                && await store.Owns(other, imported),
            "Selected private bundle restores only selected canonical record under new owner"
        );
        check(
            originals.Read(imported, hash).SequenceEqual(bytes)
                && originals.Read(imported, derivedHash).SequenceEqual(derivedBytes),
            "Relocated selected original and derived PDF preserve exact bytes"
        );
        foreach (
            var table in new[]
            {
                "ld_projects",
                "ld_reviews",
                "ld_review_events",
                "ld_derivations",
                "ld_citations",
            }
        )
        {
            var equality = await Sql(
                $"SELECT (SELECT md5(string_agg((to_jsonb(t)-'library_id')::text,',' ORDER BY (to_jsonb(t)-'library_id')::text)) FROM {table} t WHERE library_id=@p0)=(SELECT md5(string_agg((to_jsonb(t)-'library_id')::text,',' ORDER BY (to_jsonb(t)-'library_id')::text)) FROM {table} t WHERE library_id=@p1)",
                library,
                imported
            );
            check(
                Convert.ToBoolean(equality),
                "Independent SQL selected research equality: " + table
            );
        }
        await using (var reopened = new PgStore(config.ConnectionString))
        {
            await reopened.VerifySchema();
            check(
                (await reopened.Article(imported, id)).SearchId == id,
                "New store process boundary retains relocated canonical identity"
            );
        }
        await ResearchLifecycleChecks.Run(
            store,
            config.ConnectionString,
            library,
            owner,
            id,
            originals,
            hash,
            derivedHash,
            output,
            check
        );
        var health = JsonSerializer.Serialize(await store.InspectHealth(imported, originals));
        check(
            health.Contains("valid"),
            "Derived content participates in bounded file-health inspection"
        );
        await File.WriteAllTextAsync(
            Path.Combine(output, "research-scale.json"),
            JsonSerializer.Serialize(
                new
                {
                    records = 120,
                    projects = 2,
                    conversions = 2,
                    generatedPdfBytes = derivedBytes.Length,
                    bundleBytes = new FileInfo(bundle).Length,
                    processPeak = Process.GetCurrentProcess().PeakWorkingSet64,
                    liveRequests = 0,
                    scope = "Bounded synthetic workflow; child/browser/PG measured separately by CI sampler",
                }
            )
        );
    }
}

sealed class ResearchFixture : ILiteratureSource
{
    private readonly FixtureSource inner = new();
    public string Name => "Synthetic research workflow";

    public async Task SearchAsync(SearchSnapshot run, CancellationToken token)
    {
        await inner.SearchAsync(run, token);
        foreach (var article in run.Articles)
            article.Abstract = "Saved synthetic abstract 中文.";
    }

    public Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken token) =>
        inner.FetchFullTextAsync(article, token);
}
