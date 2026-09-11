using System.Diagnostics;
using Literature.Service;

public static class RecoveryProcessChecks
{
    public static async Task Child(string mode, string output)
    {
        if (Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes")
            throw new InvalidOperationException("Synthetic process authority required.");
        await using var store = new PgStore(
            Environment.GetEnvironmentVariable("LITRADOCK_PG_TEST_CONNECTION")
        );
        if (mode == "--recovery-scheduler-child")
        {
            await store.AdvanceSchedule();
            await File.WriteAllTextAsync(Path.Combine(output, "scheduled"), "done");
            return;
        }
        await using var admission = await ResourceAdmission.Enter(store, heavy: true);
        await store.ImportBundle(
            Guid.Parse(Environment.GetEnvironmentVariable("RECOVERY_TEST_OWNER")),
            Environment.GetEnvironmentVariable("RECOVERY_TEST_BUNDLE"),
            new OriginalStore(Environment.GetEnvironmentVariable("RECOVERY_TEST_OBJECTS")),
            phase =>
            {
                if (phase == "published")
                {
                    File.WriteAllText(
                        Path.Combine(output, "published"),
                        "Files moved; transaction deliberately held for process-kill fixture."
                    );
                    Thread.Sleep(Timeout.Infinite);
                }
            }
        );
    }

    private static Process Start(
        string connection,
        string mode,
        string output,
        Dictionary<string, string> extra = null
    )
    {
        Directory.CreateDirectory(output);
        var start = new ProcessStartInfo("dotnet")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        start.ArgumentList.Add(typeof(RecoveryProcessChecks).Assembly.Location);
        start.ArgumentList.Add(mode);
        start.ArgumentList.Add(output);
        start.Environment["LITRADOCK_PG_TEST_CONNECTION"] = connection;
        if (extra != null)
            foreach (var pair in extra)
                start.Environment[pair.Key] = pair.Value;
        var process = Process.Start(start);
        _ = process.StandardOutput.ReadToEndAsync();
        _ = process.StandardError.ReadToEndAsync();
        return process;
    }

    public static async Task SchedulePair(string connection, string output)
    {
        using var first = Start(
            connection,
            "--recovery-scheduler-child",
            Path.Combine(output, "scheduler-a")
        );
        using var second = Start(
            connection,
            "--recovery-scheduler-child",
            Path.Combine(output, "scheduler-b")
        );
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            await Task.WhenAll(
                first.WaitForExitAsync(deadline.Token),
                second.WaitForExitAsync(deadline.Token)
            );
        }
        finally
        {
            if (!first.HasExited)
                first.Kill(true);
            if (!second.HasExited)
                second.Kill(true);
        }
        if (first.ExitCode != 0 || second.ExitCode != 0)
            throw new IOException("Independent scheduler process failed.");
    }

    public static async Task InterruptImport(
        string connection,
        string output,
        Guid owner,
        string archive,
        OriginalStore originals
    )
    {
        var directory = Path.Combine(output, "interrupted-import");
        using var child = Start(
            connection,
            "--recovery-import-child",
            directory,
            new()
            {
                ["RECOVERY_TEST_OWNER"] = owner.ToString(),
                ["RECOVERY_TEST_BUNDLE"] = archive,
                ["RECOVERY_TEST_OBJECTS"] = originals.Root,
            }
        );
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            while (!File.Exists(Path.Combine(directory, "published")))
            {
                if (child.HasExited)
                    throw new IOException("Import child exited before interruption checkpoint.");
                await Task.Delay(30, deadline.Token);
            }
            await using (var peer = new PgStore(connection))
            {
                bool refused = false;
                try
                {
                    await using var conflicting = await ResourceAdmission.Enter(peer, heavy: true);
                }
                catch (ResourceBusyException)
                {
                    refused = true;
                }
                if (!refused)
                    throw new IOException(
                        "Separate import process did not hold aggregate admission."
                    );
            }
            child.Kill(true);
            await child.WaitForExitAsync(deadline.Token);
        }
        finally
        {
            if (!child.HasExited)
                child.Kill(true);
        }
    }
}
