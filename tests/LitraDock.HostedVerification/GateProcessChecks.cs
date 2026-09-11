using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Literature.Service;
using Npgsql;

public static class GateProcessChecks
{
    public static async Task Child(string path, bool hold)
    {
        if (Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes")
            throw new InvalidOperationException("Explicit test authority required.");
        Directory.CreateDirectory(path);
        await File.WriteAllTextAsync(Path.Combine(path, "ready"), "ready");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (!File.Exists(Path.Combine(Path.GetDirectoryName(path), "go")))
            await Task.Delay(20, deadline.Token);
        await using var store = new PgStore(
            Environment.GetEnvironmentVariable("LITRADOCK_PG_TEST_CONNECTION")
        );
        using var client = new HttpMessageInvoker(
            new SourceRequestHandler(store, new BodyHandler(path, hold), "europepmc")
        );
        for (var n = 0; n < (hold ? 1 : 2); n++)
        {
            using var response = await client.SendAsync(
                new(
                    HttpMethod.Get,
                    "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML"
                ),
                deadline.Token
            );
        }
        await File.WriteAllTextAsync(Path.Combine(path, "completed"), "completed");
    }

    public static async Task Run(string output, Action<bool, string> check)
    {
        var root = Path.Combine(output, "gate-processes");
        Directory.CreateDirectory(root);
        Process Start(string name, bool hold)
        {
            var start = new ProcessStartInfo("dotnet")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add(typeof(GateProcessChecks).Assembly.Location);
            start.ArgumentList.Add(hold ? "--gate-hold" : "--gate-child");
            start.ArgumentList.Add(Path.Combine(root, name));
            var process = Process.Start(start);
            _ = process.StandardOutput.ReadToEndAsync();
            _ = process.StandardError.ReadToEndAsync();
            return process;
        }
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        async Task WaitFile(string file)
        {
            while (!File.Exists(file))
                await Task.Delay(20, deadline.Token);
        }
        using var first = Start("one", false);
        using var second = Start("two", false);
        try
        {
            await Task.WhenAll(
                WaitFile(Path.Combine(root, "one", "ready")),
                WaitFile(Path.Combine(root, "two", "ready"))
            );
            await File.WriteAllTextAsync(Path.Combine(root, "go"), "start together");
            await Task.WhenAll(
                first.WaitForExitAsync(deadline.Token),
                second.WaitForExitAsync(deadline.Token)
            );
            var periods = new[] { "one", "two" }
                .SelectMany(name => File.ReadAllLines(Path.Combine(root, name, "periods.jsonl")))
                .Select(line => JsonSerializer.Deserialize<long[]>(line))
                .OrderBy(p => p[0])
                .ToArray();
            check(
                first.ExitCode == 0
                    && second.ExitCode == 0
                    && periods.Length == 4
                    && periods
                        .Skip(1)
                        .Select((p, i) => p[0] >= periods[i][1] && p[0] - periods[i][0] >= 900)
                        .All(x => x),
                "Two barrier-synchronized actual worker processes serialize four complete bodies and shared provider spacing"
            );
        }
        finally
        {
            foreach (var p in new[] { first, second })
                if (!p.HasExited)
                {
                    p.Kill(true);
                    await p.WaitForExitAsync();
                }
        }
        using var killed = Start("killed", true);
        try
        {
            await WaitFile(Path.Combine(root, "killed", "body-start"));
            killed.Kill(true);
            await killed.WaitForExitAsync();
            await using var db = new NpgsqlConnection(
                Environment.GetEnvironmentVariable("LITRADOCK_PG_TEST_CONNECTION")
            );
            await db.OpenAsync();
            await using var nextQuery = new NpgsqlCommand(
                "SELECT next_at FROM ld_source_budget WHERE name='europepmc'",
                db
            );
            var nextAt = (DateTime)await nextQuery.ExecuteScalarAsync();
            check(
                nextAt > DateTime.UtcNow.AddSeconds(3),
                "Killed body leaves a future five-second Retry-After committed in PostgreSQL before survivor starts"
            );
            using var survivor = Start("survivor", false);
            try
            {
                await survivor.WaitForExitAsync(deadline.Token);
            }
            finally
            {
                if (!survivor.HasExited)
                {
                    survivor.Kill(true);
                    await survivor.WaitForExitAsync();
                }
            }
            var began = long.Parse(
                await File.ReadAllTextAsync(Path.Combine(root, "killed", "body-start"))
            );
            var resumed = JsonSerializer.Deserialize<long[]>(
                File.ReadAllLines(Path.Combine(root, "survivor", "periods.jsonl"))[0]
            )[0];
            check(
                survivor.ExitCode == 0
                    && !File.Exists(Path.Combine(root, "killed", "completed"))
                    && resumed >= new DateTimeOffset(nextAt).ToUnixTimeMilliseconds() - 50,
                "Killing process during body releases actual PG gate, retains cooldown and creates no false completion"
            );
        }
        finally
        {
            if (!killed.HasExited)
            {
                killed.Kill(true);
                await killed.WaitForExitAsync();
            }
        }
    }

    private sealed class BodyHandler(string path, bool hold) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        )
        {
            var response = new HttpResponseMessage(
                hold ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK
            )
            {
                Content = new Body(path, hold),
            };
            if (hold)
                response.Headers.RetryAfter = new(TimeSpan.FromSeconds(5));
            return Task.FromResult(response);
        }
    }

    private sealed class Body(string path, bool hold) : HttpContent
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
            var begin = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            await File.WriteAllTextAsync(Path.Combine(path, "body-start"), begin.ToString());
            // 1500ms 超過 Europe 的1000ms時槽；只鎖 headers 的退化版本必定重疊。
            await Task.Delay(hold ? 20000 : 1500);
            await stream.WriteAsync("synthetic"u8.ToArray());
            await File.AppendAllTextAsync(
                Path.Combine(path, "periods.jsonl"),
                JsonSerializer.Serialize(
                    new[] { begin, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }
                ) + "\n"
            );
        }
    }
}
