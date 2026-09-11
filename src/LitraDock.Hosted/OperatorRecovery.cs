using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using Npgsql;

namespace Literature.Service;

public sealed record RecoveryPair(
    int Version,
    int Schema,
    string DumpHash,
    List<BundleFile> Files,
    string Boundary
);

// 僅供受信任操作人員；資料庫 dump 不是可由一般使用者上傳的交換格式。
public static class OperatorRecovery
{
    private static void Separate(string directory, string storage)
    {
        var a =
            Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var b =
            Path.GetFullPath(storage).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (
            a.StartsWith(b, StringComparison.OrdinalIgnoreCase)
            || b.StartsWith(a, StringComparison.OrdinalIgnoreCase)
        )
            throw new IOException("Recovery destination must be separate from original storage.");
    }

    private static async Task PgTool(string tool, string connection, IEnumerable<string> options)
    {
        var c = new NpgsqlConnectionStringBuilder(connection);
        var start = new ProcessStartInfo(tool)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (
            var value in new[]
            {
                "--host",
                c.Host,
                "--port",
                c.Port.ToString(),
                "--username",
                c.Username,
                "--dbname",
                c.Database,
            }.Concat(options)
        )
            start.ArgumentList.Add(value);
        start.Environment["PGPASSWORD"] = c.Password;
        start.Environment["PGSSLMODE"] =
            c.SslMode == SslMode.VerifyFull ? "verify-full" : "disable";
        using var child = Process.Start(start);
        var stderr = child.StandardError.ReadToEndAsync();
        var stdout = child.StandardOutput.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        try
        {
            await child.WaitForExitAsync(timeout.Token);
        }
        catch
        {
            if (!child.HasExited)
                child.Kill(true);
            throw new IOException("Database recovery tool timed out; no success recorded.");
        }
        await Task.WhenAll(stderr, stdout);
        if (child.ExitCode != 0)
            throw new IOException(
                "Database recovery tool failed; inspect protected operator diagnostics, no completion assumed."
            );
    }

    private static string Hash(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    public static async Task Backup(
        PgStore store,
        string connection,
        OriginalStore originals,
        string destination,
        string dumpTool = "pg_dump",
        Action<string> checkpoint = null
    )
    {
        Separate(destination, originals.Root);
        if (Directory.Exists(destination) || File.Exists(destination))
            throw new IOException("Use a new backup destination.");
        await using var maintenance = await ResourceAdmission.Enter(store, maintenance: true);
        await store.VerifySchema();
        originals.Measure();
        Directory.CreateDirectory(destination);
        await File.WriteAllTextAsync(
            Path.Combine(destination, "INCOMPLETE"),
            "Maintenance barrier held; backup is not complete until manifest publication."
        );
        checkpoint?.Invoke("locked");
        var dump = Path.Combine(destination, "database.dump");
        await using (var guardDb = await store.Data.OpenConnectionAsync())
        {
            await PgStore.Exec(guardDb, "UPDATE ld_recovery_guard SET required=true");
            try
            {
                await PgTool(
                    dumpTool,
                    connection,
                    ["--format=custom", "--no-owner", "--no-acl", "--file", dump]
                );
            }
            finally
            {
                await PgStore.Exec(guardDb, "UPDATE ld_recovery_guard SET required=false");
            }
        }
        var files = new List<BundleFile>();
        var pending = new Stack<string>();
        if (Directory.Exists(originals.Root))
            pending.Push(originals.Root);
        while (pending.Count > 0)
            foreach (var path in Directory.EnumerateFileSystemEntries(pending.Pop()))
            {
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Linked storage cannot form a trusted backup.");
                if (Directory.Exists(path))
                {
                    pending.Push(path);
                    continue;
                }
                if (files.Count >= OriginalStore.EntryLimit)
                    throw new IOException("Backup file count limit exceeded.");
                var relative = Path.GetRelativePath(originals.Root, path).Replace('\\', '/');
                var target = Path.Combine(
                    destination,
                    "objects",
                    relative.Replace('/', Path.DirectorySeparatorChar)
                );
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(path, target, false);
                var hash = Hash(target);
                if (hash != Hash(path))
                    throw new IOException(
                        "Original changed during maintenance; backup incomplete."
                    );
                files.Add(new(relative, hash, new FileInfo(target).Length, "valid"));
            }
        checkpoint?.Invoke("copied");
        var pair = new RecoveryPair(
            1,
            3,
            Hash(dump),
            files,
            "Application API/worker/CLI write maintenance barrier; external SQL/filesystem writers must be stopped by operator; trusted private backup includes accounts and revokes sessions on restore."
        );
        await File.WriteAllTextAsync(
            Path.Combine(destination, "pair.json"),
            JsonSerializer.Serialize(pair)
        );
        File.Delete(Path.Combine(destination, "INCOMPLETE"));
    }

    public static async Task Restore(
        PgStore store,
        string connection,
        OriginalStore originals,
        string source,
        string restoreTool = "pg_restore"
    )
    {
        Separate(source, originals.Root);
        if (Directory.Exists(originals.Root) || File.Exists(originals.Root))
            throw new IOException("Restore requires a new empty object destination.");
        if (File.Exists(Path.Combine(source, "INCOMPLETE")))
            throw new IOException("Incomplete backup cannot be restored.");
        var pair = JsonSerializer.Deserialize<RecoveryPair>(
            await File.ReadAllTextAsync(Path.Combine(source, "pair.json"))
        );
        if (pair.Version != 1 || pair.Schema != 3 || pair.Files.Count > OriginalStore.EntryLimit)
            throw new IOException("Unsupported backup manifest.");
        var dump = Path.Combine(source, "database.dump");
        if (Hash(dump) != pair.DumpHash)
            throw new IOException("Database dump hash mismatch.");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var item in pair.Files)
        {
            if (
                !names.Add(item.Path)
                || item.Path.Contains('\\')
                || item.Path.Contains(':')
                || item.Path.Split('/').Any(x => x is "" or "." or "..")
            )
                throw new IOException("Unsafe backup path.");
            var path = Path.Combine(
                source,
                "objects",
                item.Path.Replace('/', Path.DirectorySeparatorChar)
            );
            if (
                (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0
                || new FileInfo(path).Length != item.Bytes
                || Hash(path) != item.Hash
            )
                throw new IOException("Backup file is missing, linked or corrupt.");
            total = checked(total + item.Bytes);
            if (total > OriginalStore.DeploymentLimit)
                throw new IOException("Restore storage bound exceeded.");
        }
        await using var maintenance = await ResourceAdmission.Enter(store, maintenance: true);
        await using (var db = await store.Data.OpenConnectionAsync())
            if (
                Convert.ToInt32(
                    await PgStore.Scalar(
                        db,
                        "SELECT count(*) FROM pg_tables WHERE schemaname='public'"
                    )
                ) != 0
            )
                throw new IOException(
                    "Restore requires a fresh empty PostgreSQL target; no overwrite."
                );
        var stage = originals.Root + ".restore-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(stage);
        foreach (var item in pair.Files)
        {
            var target = Path.Combine(stage, item.Path.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            File.Copy(
                Path.Combine(
                    source,
                    "objects",
                    item.Path.Replace('/', Path.DirectorySeparatorChar)
                ),
                target,
                false
            );
        }
        await PgTool(
            restoreTool,
            connection,
            ["--no-owner", "--no-acl", "--exit-on-error", "--single-transaction", dump]
        );
        await using (var db = await store.Data.OpenConnectionAsync())
        {
            await using var tx = await db.BeginTransactionAsync();
            await PgStore.Exec(
                db,
                "DELETE FROM ld_sessions; UPDATE ld_jobs SET state='paused',lease_token=NULL,lease_until=NULL WHERE state IN ('queued','running','scheduled'); UPDATE ld_items SET state='paused' WHERE state IN ('queued','running','scheduled','resolving','downloading','validating','publishing','waiting','redirecting'); UPDATE ld_batches SET state='paused' WHERE state IN ('queued','running'); UPDATE ld_runs SET state='paused' WHERE state IN ('queued','searching','running','scheduled'); UPDATE ld_retry SET status='paused' WHERE status='pending'"
            );
            Directory.Move(stage, originals.Root);
            await PgStore.Exec(db, "UPDATE ld_recovery_guard SET required=false");
            await tx.CommitAsync();
        }
        await store.VerifySchema();
        await File.WriteAllTextAsync(
            Path.Combine(originals.Root, "RESTORE-COMPLETE.json"),
            JsonSerializer.Serialize(
                new
                {
                    schema = 3,
                    restoredAt = DateTime.UtcNow,
                    files = pair.Files.Count,
                    sessionsRevoked = true,
                    unfinishedPaused = true,
                }
            )
        );
    }
}
