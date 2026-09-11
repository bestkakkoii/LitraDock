using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Literature.Service;
using LitraDock.Core;
using Npgsql;

public static class RecoveryChecks
{
    public static async Task Run(string connection, string output, Action<bool, string> check)
    {
        var config = new NpgsqlConnectionStringBuilder(connection);
        if (
            !config.Database.StartsWith("litradock_ci_")
            || Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes"
        )
            throw new InvalidOperationException("Explicit disposable test environment required.");
        var suffix = Guid.NewGuid().ToString("N")[..12];
        var sourceName = "litradock_ci_recovery_" + suffix;
        var targetName = "litradock_ci_restore_" + suffix;
        await using (var admin = new NpgsqlConnection(connection))
        {
            await admin.OpenAsync();
            foreach (var name in new[] { sourceName, targetName })
            {
                await using var create = new NpgsqlCommand("CREATE DATABASE " + name, admin);
                await create.ExecuteNonQueryAsync();
            }
        }
        config.Database = sourceName;
        var sourceConnection = config.ConnectionString;
        await using var store = new PgStore(sourceConnection);
        await store.Migrate();
        await using var db = new NpgsqlConnection(sourceConnection);
        await db.OpenAsync();
        async Task<object> Sql(string sql, params object[] values)
        {
            await using var c = new NpgsqlCommand(sql, db);
            for (int i = 0; i < values.Length; i++)
                c.Parameters.AddWithValue("p" + i, values[i] ?? DBNull.Value);
            return await c.ExecuteScalarAsync();
        }
        async Task Reject(Func<Task> action, string name)
        {
            bool rejected = false;
            try
            {
                await action();
            }
            catch (Exception)
            {
                rejected = true;
            }
            check(rejected, name);
        }
        var owner = await store.CreateAccount("recovery-user", "Synthetic-recovery-password-2026");
        var other = await store.CreateAccount("recovery-other", "Synthetic-recovery-password-2026");
        var library = await store.CreateLibrary(owner, "Recovery 多語 library");
        var originals = new OriginalStore(Path.Combine(output, "source-objects"));
        var source = new FixtureSource();
        var worker = new HostedWorker(store, originals, source);
        var run = await store.Search(library, "synthetic recovery", 120);
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        var scope = await store.Scope(library, run, null, "");
        var page = JsonSerializer.SerializeToElement(await store.Page(library, scope, 0));
        var id = page.GetProperty("records")[0]
            .GetProperty("article")
            .GetProperty("SearchId")
            .GetString();
        await store.Select(library, scope, id, true);
        var batch = await store.Batch(library, scope, true, Naming.DefaultTemplate);
        var claim = await store.ClaimNext();
        await store.Schedule(claim, "transient", "Synthetic transient interruption");
        check(
            (string)
                await Sql(
                    "SELECT state FROM ld_items WHERE library_id=@p0 AND item_id=@p1",
                    library,
                    claim.Item
                ) == "scheduled",
            "Transient failure persists a scheduled next event"
        );
        await store.AdvanceSchedule();
        check(
            await store.ClaimNext() == null,
            "Scheduler does not run before persisted eligible timestamp"
        );
        await Sql(
            "UPDATE ld_retry SET next_at=now()-interval '1 second' WHERE library_id=@p0",
            library
        );
        await RecoveryProcessChecks.SchedulePair(sourceConnection, output);
        check(
            Convert.ToInt32(
                await Sql(
                    "SELECT count(*) FROM ld_jobs WHERE library_id=@p0 AND state='queued'",
                    library
                )
            ) == 1,
            "Two actual scheduler processes create one successor attempt"
        );
        var successor = await store.ClaimNext();
        check(
            successor.Job != claim.Job,
            "Automatic continuation preserves prior Job identity and creates a distinct attempt"
        );
        await Reject(
            () => store.Finish(claim, "completed", "stale"),
            "Stale pre-schedule lease cannot finish newer work"
        );
        await worker.ExecuteClaim(successor, CancellationToken.None);
        check(source.Fetches == 1, "Automatic continuation acquires the original once");
        check(
            (string)
                await Sql(
                    "SELECT state FROM ld_batches WHERE library_id=@p0 AND batch_id=@p1",
                    library,
                    batch
                ) == "completed",
            "Superseded scheduled attempt cannot keep completed batch running"
        );
        var files = await store.Files(library, id);
        var hash = (string)files[0]["hash"];
        var original = originals.Read(library, hash);
        var repeat = await store.Batch(library, scope, true, Naming.DefaultTemplate);
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        check(
            source.Fetches == 1,
            "Repeated acquisition verifies existing bytes and skips source request"
        );
        var paused = await store.Batch(library, scope, true, Naming.DefaultTemplate);
        var held = await store.ClaimNext();
        await store.Schedule(held, "rate_wait", "Synthetic cooldown");
        await store.Control(library, paused, "paused");
        await Sql(
            "UPDATE ld_retry SET next_at=now()-interval '1 second' WHERE library_id=@p0",
            library
        );
        await store.AdvanceSchedule();
        await store.RecoverScheduledWork();
        check(
            await store.ClaimNext() == null
                && (string)
                    await Sql(
                        "SELECT state FROM ld_batches WHERE library_id=@p0 AND batch_id=@p1",
                        library,
                        paused
                    ) == "paused",
            "Deliberate pause survives due scheduler and reopen"
        );
        await store.Control(library, paused, "resume");
        await store.Control(library, paused, "cancelled");
        await store.AdvanceSchedule();
        check(await store.ClaimNext() == null, "Deliberate cancel prevents automatic continuation");
        var bounded = await store.Batch(library, scope, true, Naming.DefaultTemplate);
        for (var n = 0; n < 5; n++)
        {
            var attempt = await store.ClaimNext();
            await store.Schedule(attempt, "transient", "Bounded synthetic failure");
            await Sql(
                "UPDATE ld_retry SET next_at=now()-interval '1 second' WHERE library_id=@p0 AND status='pending'",
                library
            );
            await store.AdvanceSchedule();
        }
        check(
            await store.ClaimNext() == null
                && Convert.ToInt32(
                    await Sql(
                        "SELECT count(*) FROM ld_retry WHERE library_id=@p0 AND status='exhausted'",
                        library
                    )
                ) == 1,
            "Automatic attempt budget exhausts without resetting across successor jobs"
        );
        var interrupted = await store.Batch(library, scope, true, Naming.DefaultTemplate);
        var lost = await store.ClaimNext();
        await Sql(
            "UPDATE ld_jobs SET lease_until=now()-interval '1 second' WHERE library_id=@p0 AND job_id=@p1",
            library,
            lost.Job
        );
        await store.RecoverScheduledWork();
        check(
            (string)
                await Sql(
                    "SELECT state FROM ld_jobs WHERE library_id=@p0 AND job_id=@p1",
                    library,
                    lost.Job
                ) == "scheduled",
            "Expired worker lease becomes durable bounded interruption continuation"
        );
        await store.Control(library, interrupted, "paused");
        await using (var resource = await ResourceAdmission.Enter(store, heavy: true))
        {
            await using var peer = new PgStore(sourceConnection);
            await Reject(
                async () =>
                {
                    await using var second = await ResourceAdmission.Enter(peer, heavy: true);
                },
                "Independent process-equivalent store cannot bypass global heavyweight admission"
            );
            await Reject(
                async () =>
                {
                    await using var maintenance = await ResourceAdmission.Enter(
                        peer,
                        maintenance: true
                    );
                },
                "Maintenance refuses an active application resource owner"
            );
        }
        await using (var resource = await ResourceAdmission.Enter(store, heavy: true))
            check(true, "Resource gate is reusable after owner release");
        var health = JsonSerializer.SerializeToElement(
            await store.InspectHealth(library, originals)
        );
        check(
            health
                .GetProperty("items")
                .EnumerateArray()
                .Any(x => x.GetProperty("state").GetString() == "valid"),
            "Health verifies expected original hash"
        );
        File.WriteAllText(originals.ObjectPath(library, hash), "corrupt retained evidence");
        health = JsonSerializer.SerializeToElement(await store.InspectHealth(library, originals));
        check(
            health
                .GetProperty("items")
                .EnumerateArray()
                .Any(x => x.GetProperty("state").GetString() == "corrupt")
                && File.ReadAllText(originals.ObjectPath(library, hash))
                    == "corrupt retained evidence",
            "Corrupt health evidence preserves bytes and scientific record"
        );
        File.WriteAllBytes(originals.ObjectPath(library, hash), original);
        var missingPath = originals.ObjectPath(library, hash);
        File.Move(missingPath, missingPath + ".retained");
        health = JsonSerializer.SerializeToElement(await store.InspectHealth(library, originals));
        check(
            health
                .GetProperty("items")
                .EnumerateArray()
                .Any(x => x.GetProperty("state").GetString() == "missing")
                && health
                    .GetProperty("items")
                    .EnumerateArray()
                    .Any(x => x.GetProperty("state").GetString() == "unreferenced"),
            "Missing references and unknown retained bytes are distinguished without deletion"
        );
        var incomplete = await store.ExportBundle(library, originals);
        await Reject(
            async () =>
            {
                await store.ImportBundle(other, incomplete, originals);
            },
            "Declared incomplete bundle cannot falsely restore"
        );
        File.Move(missingPath + ".retained", missingPath);
        var versionItem = JsonSerializer.SerializeToElement(await store.ManualItem(library, id));
        var versionBytes = SourceChecks.Xml(await store.Article(library, id));
        await store.QueueManual(
            library,
            id,
            versionItem.GetProperty("item").GetString(),
            versionBytes,
            "",
            "accepted-manuscript",
            originals
        );
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        check(
            (await store.Files(library, id)).Count == 2,
            "Distinct valid version survives as second immutable original"
        );
        var pendingItem = JsonSerializer.SerializeToElement(await store.ManualItem(library, id));
        await store.QueueManual(
            library,
            id,
            pendingItem.GetProperty("item").GetString(),
            versionBytes,
            "",
            "published",
            originals
        );
        await store.Control(library, pendingItem.GetProperty("batch").GetString(), "paused");
        var archive = await store.ExportBundle(library, originals);
        var restored = await store.ImportBundle(other, archive, originals);
        check(
            await store.Owns(other, restored) && !await store.Owns(owner, restored),
            "Restored library belongs only to authenticated destination owner"
        );
        check(
            (await store.Article(restored, id)).RawXml == (await store.Article(library, id)).RawXml
                && originals.Read(restored, hash).SequenceEqual(original),
            "Restore preserves independent metadata field and exact original bytes under relocated library path"
        );
        foreach (
            var table in new[]
            {
                "ld_records",
                "ld_identifiers",
                "ld_results",
                "ld_scopes",
                "ld_members",
                "ld_files",
                "ld_article_files",
                "ld_legacy_rows",
            }
        )
            check(
                (string)
                    await Sql(
                        $"SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(t)-'library_id' x FROM {table} t WHERE library_id=@p0) q",
                        library
                    )
                    == (string)
                        await Sql(
                            $"SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(t)-'library_id' x FROM {table} t WHERE library_id=@p0) q",
                            restored
                        ),
                "Independent SQL row equivalence after relocation: " + table
            );
        check(
            Convert.ToInt32(
                await Sql(
                    "SELECT count(*) FROM ld_jobs WHERE library_id=@p0 AND (state IN ('queued','running','scheduled') OR lease_token IS NOT NULL)",
                    restored
                )
            ) == 0,
            "Imported library cannot activate jobs or copied leases"
        );
        using (var zip = ZipFile.OpenRead(archive))
        {
            var text = new StreamReader(zip.GetEntry("metadata.json").Open()).ReadToEnd();
            check(
                !text.Contains("password_hash")
                    && !text.Contains("csrf")
                    && !text.Contains("lease_token"),
                "User transfer excludes account/session/lease capability fields"
            );
        }
        var countBefore = await Sql("SELECT count(*) FROM ld_libraries");
        await Reject(
            async () =>
            {
                await store.ImportBundle(
                    other,
                    archive,
                    originals,
                    phase =>
                    {
                        if (phase == "published")
                            throw new IOException("Synthetic association I/O failure");
                    }
                );
            },
            "Interrupted destination publication rolls back database visibility"
        );
        check(
            Equals(countBefore, await Sql("SELECT count(*) FROM ld_libraries"))
                && originals.Read(library, hash).SequenceEqual(original),
            "Failed publication leaves existing libraries and source bytes intact"
        );
        await RecoveryProcessChecks.InterruptImport(
            sourceConnection,
            output,
            other,
            archive,
            originals
        );
        check(
            Equals(countBefore, await Sql("SELECT count(*) FROM ld_libraries")),
            "Actual process kill after file move rolls back library publication"
        );
        await Sql(
            "UPDATE ld_transfer_attempts SET updated_at=now()-interval '4 minutes' WHERE phase IN ('published','interrupted')"
        );
        var transfers = JsonSerializer.SerializeToElement(await store.TransferStatus(other));
        check(
            transfers
                .EnumerateArray()
                .Any(x => x.GetProperty("phase").GetString() == "interrupted"),
            "Reopen reconciles interrupted transfer with retained evidence and no false completion"
        );
        await using (var available = await ResourceAdmission.Enter(store, heavy: true))
            check(true, "Killed import process releases aggregate resource gate");
        var bad = Path.Combine(output, "bad.zip");
        foreach (
            var attack in new[]
            {
                "duplicate",
                "traversal",
                "hash",
                "incompatible",
                "credentials",
                "truncated",
            }
        )
        {
            File.Copy(archive, bad, true);
            if (attack == "truncated")
            {
                using var stream = new FileStream(bad, FileMode.Open, FileAccess.Write);
                stream.SetLength(31);
            }
            else
                using (var zip = ZipFile.Open(bad, ZipArchiveMode.Update))
                {
                    if (attack is "duplicate" or "traversal")
                    {
                        using var w = new StreamWriter(
                            zip.CreateEntry(
                                    attack == "duplicate" ? "metadata.json" : "../escape.txt"
                                )
                                .Open()
                        );
                        w.Write("unsafe");
                    }
                    else if (attack == "hash")
                    {
                        var entry = zip.Entries.First(e => e.FullName.StartsWith("objects/"));
                        var name = entry.FullName;
                        entry.Delete();
                        using var w = new StreamWriter(zip.CreateEntry(name).Open());
                        w.Write("corrupted");
                    }
                    else
                    {
                        var entry = zip.GetEntry("manifest.json");
                        using var r = new StreamReader(entry.Open());
                        var node = JsonNode.Parse(r.ReadToEnd());
                        r.Dispose();
                        entry.Delete();
                        node["Schema"] = attack == "incompatible" ? 999 : 3;
                        if (attack == "credentials")
                        {
                            using var w = new StreamWriter(zip.CreateEntry("accounts.json").Open());
                            w.Write("{}");
                        }
                        using var writer = new StreamWriter(
                            zip.CreateEntry("manifest.json").Open()
                        );
                        writer.Write(node.ToJsonString());
                    }
                }
            await Reject(
                async () =>
                {
                    await store.ImportBundle(other, bad, originals);
                },
                "Reject bundle attack without publication: " + attack
            );
        }
        check(
            Equals(countBefore, await Sql("SELECT count(*) FROM ld_libraries")),
            "All malicious bundle failures preserve destination library count"
        );
        await Reject(
            () => Task.Run(() => originals.Admit(library, OriginalStore.LibraryLimit)),
            "Aggregate library capacity accounts for existing/staged/retained content"
        );
        var backup = Path.Combine(output, "operator-backup");
        var dumpTool = Environment.GetEnvironmentVariable("LITRADOCK_PG_DUMP") ?? "pg_dump";
        var restoreTool =
            Environment.GetEnvironmentVariable("LITRADOCK_PG_RESTORE") ?? "pg_restore";
        await Reject(
            () =>
                OperatorRecovery.Backup(
                    store,
                    sourceConnection,
                    originals,
                    Path.Combine(output, "failed-backup"),
                    dumpTool,
                    phase =>
                    {
                        if (phase == "copied")
                            throw new IOException("Synthetic backup interruption");
                    }
                ),
            "Failed operator backup leaves an incomplete destination and releases maintenance"
        );
        await using (var admission = await ResourceAdmission.Enter(store))
            check(true, "Failed backup does not leave application maintenance lock held");
        await Sql("UPDATE ld_recovery_guard SET required=true");
        await Reject(
            () => store.VerifyOperational(),
            "Incomplete recovery guard blocks service startup"
        );
        await OperatorRecovery.VerifyAndClearGuard(store, originals);
        await store.VerifyOperational();
        check(
            true,
            "Operator verifies original associations before clearing failed-backup startup guard"
        );
        var login = await store.Login("recovery-user", "Synthetic-recovery-password-2026");
        bool barrier = false;
        await OperatorRecovery.Backup(
            store,
            sourceConnection,
            originals,
            backup,
            dumpTool,
            phase =>
            {
                if (phase == "locked")
                {
                    try
                    {
                        ResourceAdmission
                            .Enter(store)
                            .GetAwaiter()
                            .GetResult()
                            .DisposeAsync()
                            .GetAwaiter()
                            .GetResult();
                    }
                    catch (ResourceBusyException)
                    {
                        barrier = true;
                    }
                }
            }
        );
        check(
            barrier
                && File.Exists(Path.Combine(backup, "pair.json"))
                && !File.Exists(Path.Combine(backup, "INCOMPLETE")),
            "Actual pg_dump/object pair completes under exclusive application maintenance barrier"
        );
        config.Database = targetName;
        await using var target = new PgStore(config.ConnectionString);
        var relocated = new OriginalStore(
            Path.Combine(output, "different-directory", "restored-objects")
        );
        await OperatorRecovery.Restore(
            target,
            config.ConnectionString,
            relocated,
            backup,
            restoreTool
        );
        await target.VerifyOperational();
        check(
            await target.Authenticate(login.Value.Token) == null
                && await store.Authenticate(login.Value.Token) != null,
            "Operator restore revokes copied sessions while preserving source session"
        );

        check(
            relocated.Read(library, hash).SequenceEqual(original)
                && (await target.Article(library, id)).SearchId == id,
            "Actual pg_restore into different database/directory preserves IDs and original hashes"
        );
        await using (var reopened = new PgStore(config.ConnectionString))
            check(
                (await reopened.Article(restored, id)).Pmid
                    == (await store.Article(restored, id)).Pmid,
                "Reopened restored database retains portable-library identities"
            );
        var record = JsonSerializer.SerializeToElement(
            await target.BatchStatus(library, interrupted, 0)
        );
        check(
            record.GetProperty("state").GetString() == "paused",
            "Operator restored deliberate pause survives reopen"
        );
        await Reject(
            () =>
                OperatorRecovery.Restore(
                    target,
                    config.ConnectionString,
                    relocated,
                    backup,
                    restoreTool
                ),
            "Operator restore refuses existing target rather than overwriting"
        );
        var measure = new
        {
            records = 120,
            liveRequests = 0,
            bundleBytes = new FileInfo(archive).Length,
            sourceDiskBytes = originals.Measure(),
            restoredDiskBytes = relocated.Measure(),
            clientPeakBytes = Process.GetCurrentProcess().PeakWorkingSet64,
            processorCount = Environment.ProcessorCount,
            limits = new
            {
                bundle = PgStore.BundleLimit,
                metadata = PgStore.MetadataLimit,
                library = OriginalStore.LibraryLimit,
                deployment = OriginalStore.DeploymentLimit,
                heavyConcurrency = 1,
            },
            excludedMemory = "PostgreSQL, API, browser and PDF child processes; measured separately by CI resource sampler",
        };
        await File.WriteAllTextAsync(
            Path.Combine(output, "recovery-scale.json"),
            JsonSerializer.Serialize(measure)
        );
    }
}
