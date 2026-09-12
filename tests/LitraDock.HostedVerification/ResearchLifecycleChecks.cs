using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Literature.Service;
using Npgsql;

public static class ResearchLifecycleChecks
{
    public static async Task Child(string output)
    {
        var connection = Environment.GetEnvironmentVariable("LITRADOCK_PG_TEST_CONNECTION");
        if (
            Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes"
            || !new NpgsqlConnectionStringBuilder(connection).Database.StartsWith("litradock_ci_")
        )
            throw new InvalidOperationException();
        await using var store = new PgStore(connection);
        var claim = await store.ClaimConversion();
        await File.WriteAllTextAsync(
            Path.Combine(output, "claim.json"),
            JsonSerializer.Serialize(claim)
        );
        await Task.Delay(TimeSpan.FromMinutes(2));
    }

    public static async Task Run(
        PgStore store,
        string connection,
        Guid library,
        Guid owner,
        string id,
        OriginalStore originals,
        string inputHash,
        string hash,
        string output,
        Action<bool, string> check
    )
    {
        async Task Reject(Func<Task> action, string name)
        {
            bool rejected = false;
            try
            {
                await action();
            }
            catch
            {
                rejected = true;
            }
            check(rejected, name);
        }
        var saved = originals.Read(library, hash);
        var originalPath = originals.ObjectPath(library, hash);
        var retained = originalPath + ".test-retained";
        File.Move(originalPath, retained);
        try
        {
            await Reject(
                () => store.QueueConversion(library, id, inputHash, "original", owner, originals),
                "Missing completed derived file rejects verified-existing reuse"
            );
        }
        finally
        {
            File.Move(retained, originalPath);
        }
        // 同時程序取得同一工作；程序被終止後不得自稱完成或重設嘗試次數。
        var queued = await store.QueueConversion(library, id, null, "abstract", owner, originals);
        var processes = new List<Process>();
        var claims = new List<ConversionClaim>();
        try
        {
            for (var i = 0; i < 2; i++)
            {
                var directory = Path.Combine(output, "claim-process-" + i);
                Directory.CreateDirectory(directory);
                var start = new ProcessStartInfo("dotnet")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
                start.ArgumentList.Add("--research-claim-hold");
                start.ArgumentList.Add(directory);
                start.Environment["LITRADOCK_PG_TEST_CONNECTION"] = connection;
                processes.Add(Process.Start(start));
            }
            for (var i = 0; i < 2; i++)
            {
                var path = Path.Combine(output, "claim-process-" + i, "claim.json");
                for (var n = 0; n < 100 && !File.Exists(path); n++)
                    await Task.Delay(100);
                claims.Add(
                    JsonSerializer.Deserialize<ConversionClaim>(await File.ReadAllTextAsync(path))
                );
            }
            check(
                claims.Count(x => x != null) == 1 && claims.Single(x => x != null).Id == queued,
                "Two actual processes produce exactly one conversion claim"
            );
        }
        finally
        {
            foreach (var process in processes)
            {
                if (!process.HasExited)
                    process.Kill(true);
                await process.WaitForExitAsync();
                process.Dispose();
            }
        }
        var stale = claims.Single(x => x != null);
        await using var db = new NpgsqlConnection(connection);
        await db.OpenAsync();
        await using (
            var expire = new NpgsqlCommand(
                "UPDATE ld_conversions SET lease_until=now()-interval '1 second' WHERE library_id=@l AND conversion_id=@c",
                db
            )
        )
        {
            expire.Parameters.AddWithValue("l", library);
            expire.Parameters.AddWithValue("c", queued);
            await expire.ExecuteNonQueryAsync();
        }
        await using (var reopened = new PgStore(connection))
            check(
                await reopened.ClaimConversion() == null,
                "Killed processor lease reconciles to paused without automatic duplicate work"
            );
        await Reject(
            () => store.PrepareConversion(stale, new JsonObject()),
            "Expired process cannot prepare or publish after restart"
        );
        await store.ControlConversion(library, queued, "resume", owner);
        var current = await store.ClaimConversion();
        await store.ControlConversion(library, queued, "pause", owner);
        check(
            !await store.RenewConversion(current),
            "Deliberate pause revokes current conversion lease"
        );
        await Reject(
            () => store.PrepareConversion(current, new JsonObject()),
            "Paused writer cannot record prepared output"
        );
        await store.ControlConversion(library, queued, "cancel", owner);
        check(
            await store.ClaimConversion() == null,
            "User cancellation persists across scheduler checks"
        );
        await using var query = new NpgsqlCommand(
            "SELECT attempts FROM ld_conversions WHERE library_id=@l AND conversion_id=@c",
            db
        );
        query.Parameters.AddWithValue("l", library);
        query.Parameters.AddWithValue("c", queued);
        check(
            Convert.ToInt32(await query.ExecuteScalarAsync()) == 2,
            "Process restart and controls preserve bounded attempt lineage"
        );
        check(
            originals.Read(library, hash).SequenceEqual(saved),
            "Conversion lifecycle failures preserve saved derived bytes"
        );
    }
}
