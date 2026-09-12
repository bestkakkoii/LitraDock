using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using Literature.Service;
using LitraDock.Core;
using Npgsql;

public static class IdentityChecks
{
    public static async Task Run(string connection, string output, Action<bool, string> check)
    {
        var config = new NpgsqlConnectionStringBuilder(connection);
        if (!config.Database.StartsWith("litradock_ci_") || Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes")
            throw new InvalidOperationException("Explicit disposable PostgreSQL required.");
        await using (var admin = new NpgsqlConnection(connection))
        {
            await admin.OpenAsync();
            config.Database = "litradock_ci_identity_" + Guid.NewGuid().ToString("N")[..12];
            await using var create = new NpgsqlCommand("CREATE DATABASE " + config.Database, admin);
            await create.ExecuteNonQueryAsync();
        }
        connection = config.ConnectionString;
        await using var store = new PgStore(connection);
        await store.Migrate();
        await using var db = new NpgsqlConnection(connection);
        await db.OpenAsync();
        async Task<object> Sql(string sql, params object[] values)
        {
            await using var cmd = new NpgsqlCommand(sql, db);
            for (int i = 0; i < values.Length; i++) cmd.Parameters.AddWithValue("p" + i, values[i]);
            return await cmd.ExecuteScalarAsync();
        }
        const string password = "Synthetic-identity-password-2026";
        var owner = await store.CreateAccount("identity-owner", password);
        var other = await store.CreateAccount("identity-other", password);
        var library = await store.CreateLibrary(owner, "Identity preserved 中文");
        var originals = new OriginalStore(Path.Combine(output, "private"));
        var worker = new HostedWorker(store, originals, new ResearchFixture());
        var run = await store.Search(library, "synthetic identity", 120);
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        var scope = await store.Scope(library, run, null, "");
        var record = JsonSerializer.SerializeToElement(await store.Page(library, scope, 0)).GetProperty("records")[0];
        var id = record.GetProperty("article").GetProperty("SearchId").GetString();
        await store.Select(library, scope, id, true);
        await store.Batch(library, scope, true, Naming.DefaultTemplate);
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        var hash = (string)(await store.Files(library, id)).Single()["hash"];
        var project = await store.CreateProject(library, "Preserved research");
        await store.SaveReview(library, project, id, owner, new("included", "中文", "Private note", "Relevant", "{}", 0));
        await store.QueueConversion(library, id, hash, "original", owner, originals);
        await new ReadingWorker(store, originals).Execute(await store.ClaimConversion(), CancellationToken.None);
        check((long)await Sql("SELECT count(*) FROM ld_derivations WHERE library_id=@p0", library) == 1, "IDA07 fixture has a real rendered derivation and research lineage");
        await store.Search(library, "pending preserved search", 1);
        await store.QueueConversion(library, id, null, "abstract", owner, originals);
        async Task<JsonObject> Metadata(Guid selected)
        {
            var path = await store.ExportBundle(selected, originals);
            using var zip = ZipFile.OpenRead(path);
            using var reader = new StreamReader(zip.GetEntry("metadata.json").Open());
            var data = JsonNode.Parse(await reader.ReadToEndAsync()).AsObject();
            foreach (var key in data.Select(x => x.Key).ToArray())
                data[key] = new JsonArray(data[key].AsArray().OrderBy(x => x.ToJsonString(), StringComparer.Ordinal).Select(x => x.DeepClone()).ToArray());
            return data;
        }
        var baseline = await Metadata(library);
        var first = (await store.Login("identity-owner", password)).Value;
        var second = (await store.Login("identity-owner", password)).Value;
        var foreign = (await store.Login("identity-other", password)).Value;
        var result = await store.ControlAccount(owner.ToString(), "disable");
        check(!result.Enabled && result.Revoked == 2 && await store.Authenticate(first.Token) == null && await store.Authenticate(second.Token) == null && await store.Login("identity-owner", password) == null, "IDA01 disable atomically denies both sessions and fresh login");
        check(await store.Authenticate(foreign.Token) != null, "IDA01 independent account session survives");
        await store.ControlAccount(owner.ToString(), "enable");
        check(await store.Authenticate(first.Token) == null && await store.Authenticate(second.Token) == null, "IDA02 enable cannot resurrect old tokens");
        first = (await store.Login("identity-owner", password)).Value;
        second = (await store.Login("identity-owner", password)).Value;
        result = await store.ControlAccount(owner.ToString(), "revoke-sessions");
        check(result.Enabled && result.Revoked == 2 && await store.Authenticate(first.Token) == null && await store.Authenticate(second.Token) == null, "IDA02 revoke preserves enabled state and invalidates all sessions");
        first = (await store.Login("identity-owner", password)).Value;
        async Task Reject(Func<Task> action, string name)
        {
            var failed = false;
            try { await action(); } catch { failed = true; }
            check(failed, name);
        }
        foreach (var input in new[] { ("bad", "disable"), (Guid.Empty.ToString(), "disable"), (owner.ToString("N"), "disable"), (owner.ToString(), "bad"), (Guid.NewGuid().ToString(), "disable") })
            await Reject(() => store.ControlAccount(input.Item1, input.Item2), "IDA03 invalid input or unknown account fails without mutation: " + input.Item2 + "/" + (input.Item1 == "bad" ? "malformed" : "UUID"));
        await Sql("CREATE FUNCTION identity_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$; CREATE TRIGGER identity_fail BEFORE DELETE ON ld_sessions FOR EACH ROW EXECUTE FUNCTION identity_fail()");
        try { await Reject(() => store.ControlAccount(owner.ToString(), "disable"), "IDA03 injected deletion failure rolls back earlier enabled-state update"); }
        finally { await Sql("DROP TRIGGER identity_fail ON ld_sessions; DROP FUNCTION identity_fail()"); }
        await using (var reopened = new PgStore(connection))
            check(await reopened.Authenticate(first.Token) != null && JsonNode.DeepEquals(baseline, await Metadata(library)), "IDA03 reopen after rollback retains session and complete library graph");

        // 測試資料庫觸發器建立真實 SQL 屏障，不在正式認證程式提供測試後門。
        const long barrier = 724919100;
        await Sql("CREATE FUNCTION identity_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(724919100); RETURN NEW; END $$");
        async Task WaitBlocked(string queryPart)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while ((long)await Sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND strpos(query,@p0)>0", queryPart) == 0)
                await Task.Delay(20, deadline.Token);
        }
        await Sql("CREATE TRIGGER identity_hold BEFORE INSERT ON ld_sessions FOR EACH ROW EXECUTE FUNCTION identity_hold(); SELECT pg_advisory_lock(724919100)");
        var pendingLogin = store.Login("identity-owner", password);
        await WaitBlocked("INSERT INTO ld_sessions");
        var pendingDisable = store.ControlAccount(owner.ToString(), "disable");
        await WaitBlocked("SELECT enabled FROM ld_accounts");
        await Sql("SELECT pg_advisory_unlock(@p0)", barrier);
        var issued = (await pendingLogin).Value;
        await pendingDisable;
        await Sql("DROP TRIGGER identity_hold ON ld_sessions");
        check(await store.Authenticate(issued.Token) == null, "IDA04 observed PostgreSQL barriers force login-before-disable; inserted token revoked");
        await store.ControlAccount(owner.ToString(), "enable");
        check(await store.Authenticate(issued.Token) == null, "IDA04 later enable does not revive raced login");
        await Sql("CREATE TRIGGER identity_hold BEFORE UPDATE ON ld_accounts FOR EACH ROW EXECUTE FUNCTION identity_hold(); SELECT pg_advisory_lock(724919100)");
        pendingDisable = store.ControlAccount(owner.ToString(), "disable");
        await WaitBlocked("UPDATE ld_accounts");
        pendingLogin = store.Login("identity-owner", password);
        await WaitBlocked("SELECT account_id,password_hash");
        await Sql("SELECT pg_advisory_unlock(@p0)", barrier);
        await pendingDisable;
        check(await pendingLogin == null, "IDA04 observed PostgreSQL barriers force disable-before-login; latest disabled state rejects issuance");
        await Sql("DROP TRIGGER identity_hold ON ld_accounts");
        await store.ControlAccount(owner.ToString(), "enable");
        first = (await store.Login("identity-owner", password)).Value;
        var logs = new List<string>();
        Process Start(string account, string action)
        {
            var start = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Path.GetFullPath("src/LitraDock.Hosted") };
            start.ArgumentList.Add(typeof(PgStore).Assembly.Location);
            start.ArgumentList.Add("--account-control");
            start.Environment["LITRADOCK_POSTGRES"] = connection;
            start.Environment["LITRADOCK_OBJECTS"] = originals.Root;
            start.Environment["LITRADOCK_ACCOUNT_ID"] = account;
            start.Environment["LITRADOCK_ACCOUNT_ACTION"] = action;
            return Process.Start(start);
        }
        async Task<int> Command(string account, string action)
        {
            using var child = Start(account, action);
            var stdout = child.StandardOutput.ReadToEndAsync();
            var stderr = child.StandardError.ReadToEndAsync();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            try { await child.WaitForExitAsync(deadline.Token); }
            finally { if (!child.HasExited) { child.Kill(true); await child.WaitForExitAsync(); } }
            logs.Add(await stdout); logs.Add(await stderr);
            return child.ExitCode;
        }
        await Sql("CREATE TRIGGER identity_hold BEFORE DELETE ON ld_sessions FOR EACH ROW EXECUTE FUNCTION identity_hold(); SELECT pg_advisory_lock(724919100)");
        using (var killed = Start(owner.ToString(), "disable"))
        {
            try { await WaitBlocked("DELETE FROM ld_sessions"); }
            finally { killed.Kill(true); await killed.WaitForExitAsync(); await Sql("SELECT pg_advisory_unlock(@p0)", barrier); }
        }
        await Sql("DROP TRIGGER identity_hold ON ld_sessions; DROP FUNCTION identity_hold()");
        await using (var reopened = new PgStore(connection))
            check(await reopened.Authenticate(first.Token) != null, "IDA03 actual operator process killed after update before deletion commit retains prior account/session");
        await using (var admitted = await ResourceAdmission.Enter(store))
        {
            var timer = Stopwatch.StartNew();
            check(await Command(owner.ToString(), "disable") != 0 && timer.Elapsed < TimeSpan.FromSeconds(15), "IDA05 admitted operation causes bounded operator busy failure");
            check(await store.Authenticate(first.Token) != null, "IDA05 busy refusal does not partially revoke sessions");
        }
        foreach (var action in new[] { "disable", "disable", "revoke-sessions", "enable", "enable", "revoke-sessions" })
            check(await Command(owner.ToString(), action) == 0, "IDA03 actual operator repeat is safe: " + action);
        check(await Command(owner.ToString(), password) != 0 && await Command(password, "disable") != 0 && await Command(Guid.NewGuid().ToString(), "disable") != 0, "IDA07 operator invalid inputs and unknown account have nonzero exit");
        await using (var locked = new NpgsqlConnection(connection))
        {
            await locked.OpenAsync();
            await using var tx = await locked.BeginTransactionAsync();
            await using var row = new NpgsqlCommand("SELECT enabled FROM ld_accounts WHERE account_id=@id FOR UPDATE", locked);
            row.Parameters.AddWithValue("id", owner);
            await row.ExecuteScalarAsync();
            var timer = Stopwatch.StartNew();
            check(await Command(owner.ToString(), "disable") != 0 && timer.Elapsed < TimeSpan.FromSeconds(15), "IDA03 account-row contention times out and rolls back within bounded operator invocation");
        }
        var joined = string.Join("\n", logs);
        check(!new[] { password, first.Token, second.Token, foreign.Token, issued.Token, "Private note" }.Any(joined.Contains) && joined.Contains("busy") && joined.Contains("database_failure") && joined.Contains("succeeded"), "IDA07 captured operator success and failure logs exclude fixture passwords, tokens and library text");
        await File.WriteAllTextAsync(Path.Combine(output, "operator-results.json"), JsonSerializer.Serialize(logs));
        check(JsonNode.DeepEquals(baseline, await Metadata(library)), "IDA07 all original IDs, research lineage, pending jobs and metadata unchanged after lifecycle and rollback");
        var bundle = await store.ExportBundle(library, originals);
        var restored = await store.ImportBundle(owner, bundle, originals);
        var restoredMetadata = await Metadata(restored);
        foreach (var table in baseline)
        {
            // 匯入保留資料識別碼；library_id 改成新文獻庫，排程依既有復原契約轉 paused。
            foreach (var item in restoredMetadata[table.Key].AsArray())
                if (item.AsObject().ContainsKey("library_id")) item["library_id"] = library.ToString();
        }
        // ordinal 是新資料庫排列鍵，非永久 Search ID；還原可重建此鍵。
        foreach (var data in new[] { baseline, restoredMetadata })
            foreach (var row in data["ld_records"].AsArray()) row.AsObject().Remove("ordinal");
        foreach (var table in new[] { "ld_records", "ld_identifiers", "ld_results", "ld_members", "ld_reviews", "ld_review_events", "ld_derivations", "ld_article_files", "ld_files" })
            check(baseline[table].AsArray().Select(x => x.ToJsonString()).Order(StringComparer.Ordinal).SequenceEqual(restoredMetadata[table].AsArray().Select(x => x.ToJsonString()).Order(StringComparer.Ordinal)), "IDA07 real export/restore preserves complete table: " + table);
        check(Artifacts.Hash(originals.Read(restored, hash)) == hash && Artifacts.Hash(originals.Read(library, hash)) == hash, "IDA07 relocated and source original bytes match exact baseline SHA256");
        check((long)await Sql("SELECT count(*) FROM ld_jobs WHERE library_id=@p0 AND state='paused'", restored) > 0 && (long)await Sql("SELECT count(*) FROM ld_conversions WHERE library_id=@p0 AND state='paused'", restored) > 0, "IDA07 restore retains unfinished durable jobs and conversions paused for explicit continuation");
        await File.WriteAllTextAsync(Path.Combine(output, "environment.json"), JsonSerializer.Serialize(new { postgres = (string)await Sql("SELECT version()"), runtime = Environment.Version.ToString(), platform = Environment.OSVersion.ToString() }));
    }
}
