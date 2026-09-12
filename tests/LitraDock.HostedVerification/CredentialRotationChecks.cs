using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using Literature.Service;
using LitraDock.Core;
using Npgsql;

public static class CredentialRotationChecks
{
    public static async Task Run(string connection, string output, Action<bool, string> check)
    {
        var config = new NpgsqlConnectionStringBuilder(connection);
        if (!config.Database.StartsWith("litradock_ci_") || Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes")
            throw new InvalidOperationException("Explicit disposable PostgreSQL required.");
        await using (var admin = new NpgsqlConnection(connection))
        {
            await admin.OpenAsync();
            config.Database = "litradock_ci_rotation_" + Guid.NewGuid().ToString("N")[..12];
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
        check((long)await Sql("SELECT count(*) FROM ld_derivations WHERE library_id=@p0", library) == 1, "IDC07 fixture has a real rendered derivation and research lineage");
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
        // Restore creates actual paused work before the credential lifecycle starts.
        library = await store.ImportBundle(owner, await store.ExportBundle(library, originals), originals);
        var baseline = await Metadata(library);
        const string next = "Synthetic-rotated-password-2026";
        const string last = "Synthetic-final-password-2026";
        var logs = new List<string>();
        Process Start(string account, string secret, bool stopped = true, bool extra = false)
        {
            var start = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Path.GetFullPath("src/LitraDock.Hosted") };
            start.ArgumentList.Add(typeof(PgStore).Assembly.Location);
            start.ArgumentList.Add("--rotate-credential");
            if (extra) start.ArgumentList.Add("--unexpected-option");
            start.Environment["LITRADOCK_POSTGRES"] = connection;
            start.Environment["LITRADOCK_OBJECTS"] = originals.Root;
            start.Environment["LITRADOCK_ACCOUNT_ID"] = account;
            start.Environment["LITRADOCK_NEW_PASSWORD"] = secret;
            start.Environment["LITRADOCK_SERVICE_STOPPED"] = stopped ? "yes" : "no";
            if (!string.IsNullOrEmpty(secret) && start.ArgumentList.Any(x => x.Contains(secret))) throw new Exception("Secret in child arguments.");
            return Process.Start(start);
        }
        async Task<int> Command(string account, string secret, bool stopped = true, bool extra = false)
        {
            using var child = Start(account, secret, stopped, extra);
            var stdout = child.StandardOutput.ReadToEndAsync();
            var stderr = child.StandardError.ReadToEndAsync();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            try { await child.WaitForExitAsync(deadline.Token); }
            finally { if (!child.HasExited) { child.Kill(true); await child.WaitForExitAsync(); } }
            logs.Add(await stdout); logs.Add(await stderr);
            return child.ExitCode;
        }
        async Task<string> AccountSnapshot() => (string)await Sql("SELECT row_to_json(a)::text FROM ld_accounts a WHERE account_id=@p0", owner);
        var first = (await store.Login("identity-owner", password)).Value;
        var second = (await store.Login("identity-owner", password)).Value;
        var foreign = (await store.Login("identity-other", password)).Value;
        var foreignBefore = (string)await Sql("SELECT row_to_json(a)::text FROM ld_accounts a WHERE account_id=@p0", other);
        check(await Command(owner.ToString(), next) == 0, "IDC01 real operator command succeeds");
        check(JsonDocument.Parse(logs[0]).RootElement.GetProperty("Revoked").GetInt32() == 2, "IDC01 committed operator result reports both revoked A sessions");
        check(await store.Authenticate(first.Token) == null && await store.Authenticate(second.Token) == null
            && await store.Login("identity-owner", password) == null, "IDC01 both prior sessions and old password denied");
        first = (await store.Login("identity-owner", next)).Value;
        check(await store.Authenticate(first.Token) != null && (bool)await Sql("SELECT enabled FROM ld_accounts WHERE account_id=@p0", owner), "IDC01 new password authenticates enabled account");
        await store.ControlAccount(owner.ToString(), "disable");
        check(await Command(owner.ToString(), last) == 0 && !(bool)await Sql("SELECT enabled FROM ld_accounts WHERE account_id=@p0", owner)
            && await store.Login("identity-owner", last) == null && await store.Login("identity-owner", next) == null, "IDC02 disabled account remains disabled after rotation");
        await store.ControlAccount(owner.ToString(), "enable");
        check(await store.Login("identity-owner", next) == null && await store.Authenticate(first.Token) == null, "IDC02 later explicit enable does not revive old password or token");
        first = (await store.Login("identity-owner", last)).Value;
        foreach (var repeat in Enumerable.Range(0, 2))
        {
            check(await Command(owner.ToString(), last) == 0 && await store.Authenticate(first.Token) == null, "IDC03 repeated rotation revokes current session without changing identity");
            first = (await store.Login("identity-owner", last)).Value;
        }
        var beforeInvalid = await AccountSnapshot();
        var invalidUnicode = false;
        try { PgStore.ValidateRotation(owner.ToString(), "Invalid-surrogate-\ud800"); }
        catch (ArgumentException) { invalidUnicode = true; }
        check(invalidUnicode, "IDC03 malformed Unicode secret rejected without replacement encoding");
        foreach (var secret in new[] { null, "", "short", new string('x', 257), new string(' ', 12), "Secret-control\n2026" })
            check(await Command(owner.ToString(), secret) != 0, "IDC03 invalid secret rejected before mutation");
        foreach (var account in new[] { password, Guid.Empty.ToString(), owner.ToString("N"), Guid.NewGuid().ToString() })
            check(await Command(account, next) != 0, "IDC03 malformed or unknown explicit account rejected");
        check(await Command(owner.ToString(), next, stopped: false) != 0 && await Command(owner.ToString(), next, extra: true) != 0,
            "IDC03 stopped-service attestation and environment-only invocation enforced");
        check(beforeInvalid == await AccountSnapshot() && await store.Authenticate(first.Token) != null, "IDC03 rejected inputs leave exact hash, account state and session intact");

        async Task Reject(Func<Task> action, string label)
        {
            var rejected = false;
            try { await action(); } catch { rejected = true; }
            check(rejected, label);
        }
        await Sql("CREATE FUNCTION rotation_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic-final-password-2026'; END $$; CREATE TRIGGER rotation_fail BEFORE DELETE ON ld_sessions FOR EACH ROW EXECUTE FUNCTION rotation_fail()");
        try { check(await Command(owner.ToString(), next) != 0, "IDC04 real deletion failure rolls back prior password update"); }
        finally { await Sql("DROP TRIGGER rotation_fail ON ld_sessions; DROP FUNCTION rotation_fail()"); }
        check(beforeInvalid == await AccountSnapshot() && await store.Authenticate(first.Token) != null, "IDC04 failure preserves old hash and session exactly");
        const long barrier = 724919102;
        await Sql("CREATE FUNCTION rotation_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(724919102); IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$");
        async Task WaitBlocked(string query)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while ((long)await Sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND strpos(query,@p0)>0", query) == 0)
                await Task.Delay(20, deadline.Token);
        }
        await Sql("CREATE TRIGGER rotation_hold BEFORE INSERT ON ld_sessions FOR EACH ROW EXECUTE FUNCTION rotation_hold(); SELECT pg_advisory_lock(724919102)");
        var pendingLogin = store.Login("identity-owner", last);
        await WaitBlocked("INSERT INTO ld_sessions");
        var pendingRotation = store.RotateCredential(owner.ToString(), next);
        await WaitBlocked("SELECT login,enabled FROM ld_accounts");
        await Sql("SELECT pg_advisory_unlock(@p0)", barrier);
        var raced = (await pendingLogin).Value;
        await pendingRotation;
        await Sql("DROP TRIGGER rotation_hold ON ld_sessions");
        check(await store.Authenticate(raced.Token) == null && await store.Login("identity-owner", last) == null, "IDC05 actual observed login-before-rotation locks revoke raced issuance");
        await Sql("CREATE TRIGGER rotation_hold BEFORE UPDATE ON ld_accounts FOR EACH ROW EXECUTE FUNCTION rotation_hold(); SELECT pg_advisory_lock(724919102)");
        pendingRotation = store.RotateCredential(owner.ToString(), last);
        await WaitBlocked("UPDATE ld_accounts");
        pendingLogin = store.Login("identity-owner", next);
        await WaitBlocked("SELECT account_id,password_hash");
        await Sql("SELECT pg_advisory_unlock(@p0)", barrier);
        await pendingRotation;
        check(await pendingLogin == null, "IDC05 actual observed rotation-before-login locks reject old password");
        await Sql("DROP TRIGGER rotation_hold ON ld_accounts");
        first = (await store.Login("identity-owner", last)).Value;
        var beforeInterrupted = await AccountSnapshot();
        await Sql("CREATE TRIGGER rotation_hold BEFORE DELETE ON ld_sessions FOR EACH ROW EXECUTE FUNCTION rotation_hold(); SELECT pg_advisory_lock(724919102)");
        using (var killed = Start(owner.ToString(), next))
        {
            var stdout = killed.StandardOutput.ReadToEndAsync();
            var stderr = killed.StandardError.ReadToEndAsync();
            try { await WaitBlocked("DELETE FROM ld_sessions"); }
            finally { killed.Kill(true); await killed.WaitForExitAsync(); await Sql("SELECT pg_advisory_unlock(@p0)", barrier); }
            logs.Add(await stdout); logs.Add(await stderr);
        }
        await Sql("DROP TRIGGER rotation_hold ON ld_sessions");
        check(beforeInterrupted == await AccountSnapshot() && await store.Authenticate(first.Token) != null, "IDC04 actual operator process kill after update before commit rolls back hash and session");
        await Sql("CREATE TRIGGER rotation_hold BEFORE DELETE ON ld_sessions FOR EACH ROW EXECUTE FUNCTION rotation_hold(); SELECT pg_advisory_lock(724919102)");
        using (var cancel = new CancellationTokenSource())
        {
            var pending = store.RotateCredential(owner.ToString(), next, cancel.Token);
            await WaitBlocked("DELETE FROM ld_sessions");
            cancel.Cancel();
            await Reject(() => pending, "IDC04 cancellation while PostgreSQL deletion blocked fails transaction");
        }
        await Sql("SELECT pg_advisory_unlock(@p0)", barrier);
        await Sql("DROP TRIGGER rotation_hold ON ld_sessions; DROP FUNCTION rotation_hold()");
        check(beforeInterrupted == await AccountSnapshot() && await store.Authenticate(first.Token) != null, "IDC04 cancellation rollback preserves exact account and session");
        await using (var admitted = await ResourceAdmission.Enter(store))
        {
            var timer = Stopwatch.StartNew();
            check(await Command(owner.ToString(), next) != 0 && timer.Elapsed < TimeSpan.FromSeconds(15), "IDC06 admitted request blocks maintenance with bounded busy result");
        }
        await using (var locked = new NpgsqlConnection(connection))
        {
            await locked.OpenAsync();
            await using var tx = await locked.BeginTransactionAsync();
            await using var row = new NpgsqlCommand("SELECT enabled FROM ld_accounts WHERE account_id=@id FOR UPDATE", locked);
            row.Parameters.AddWithValue("id", owner);
            await row.ExecuteScalarAsync();
            var timer = Stopwatch.StartNew();
            check(await Command(owner.ToString(), next) != 0 && timer.Elapsed < TimeSpan.FromSeconds(15), "IDC06 row contention returns bounded nonzero operator result");
        }
        await RecoveryProcessChecks.SchedulePair(connection, Path.Combine(output, "scheduler-restart"));
        await using (var reopened = new PgStore(connection))
        {
            await reopened.VerifySchema(); await reopened.VerifyOperational();
            check(beforeInterrupted == await AccountSnapshot() && await reopened.Authenticate(first.Token) != null
                && await reopened.Login("identity-owner", next) == null, "IDC06 reopen after contention preserves password and session");
            check(await reopened.Authenticate(foreign.Token) != null && foreignBefore == (string)await Sql("SELECT row_to_json(a)::text FROM ld_accounts a WHERE account_id=@p0", other), "IDC01 B account hash, enabled state and session remain isolated throughout");
            check(JsonNode.DeepEquals(baseline, await Metadata(library)), "IDC07 full exported graph identities and metadata preserved after lifecycle and reopen");
            check(Artifacts.Hash(originals.Read(library, hash)) == hash, "IDC07 exact original SHA256 preserved");
            check((long)await Sql("SELECT count(*) FROM ld_jobs WHERE library_id=@p0 AND state='paused'", library) > 0
                && (long)await Sql("SELECT count(*) FROM ld_conversions WHERE library_id=@p0 AND state='paused'", library) > 0,
                "IDC07 durable jobs and conversions still paused after independent scheduler processes restart and store reopen");
        }
        var joined = string.Join("\n", logs);
        var persistedHash = (string)await Sql("SELECT password_hash FROM ld_accounts WHERE account_id=@p0", owner);
        check(!new[] { password, next, last, first.Token, second.Token, foreign.Token, raced.Token, persistedHash, "Private note", "Secret-control" }.Any(joined.Contains)
            && joined.Contains("busy") && joined.Contains("contention") && joined.Contains("unknown_account") && joined.Contains("database_failure_or_commit_unconfirmed")
            && joined.Contains("succeeded"), "IDC08 actual success, validation, contention and injected secret-exception logs exclude passwords, hashes, tokens and research text");
        await File.WriteAllTextAsync(Path.Combine(output, "operator-results.json"), JsonSerializer.Serialize(logs));
        await File.WriteAllTextAsync(Path.Combine(output, "environment.json"), JsonSerializer.Serialize(new { postgres = (string)await Sql("SELECT version()"), runtime = Environment.Version.ToString(), platform = Environment.OSVersion.ToString(), scope = "Disposable synthetic PostgreSQL; no biomedical requests" }));
    }
}
