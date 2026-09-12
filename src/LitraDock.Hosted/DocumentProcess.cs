using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Literature.Service;

public static class DocumentProcess
{
    // 僅傳遞必要平台變數，不讓文件子程序繼承資料庫、登入或供應商憑證。
    public static async Task<JsonObject> Run(object input, CancellationToken token)
    {
        var helper =
            Environment.GetEnvironmentVariable("DOCUMENT_WORKER")
            ?? throw new InvalidOperationException(
                "Document worker is not configured; no conversion or citation completion assumed."
            );
        if (!Path.IsPathFullyQualified(helper) || !File.Exists(helper))
            throw new InvalidOperationException("Configure the absolute document worker path.");
        var start = new ProcessStartInfo(
            Environment.GetEnvironmentVariable("DOCUMENT_NODE") ?? "node"
        )
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(helper),
        };
        start.Environment.Clear();
        foreach (
            var name in new[]
            {
                "PATH",
                "SystemRoot",
                "TEMP",
                "TMP",
                "HOME",
                "USERPROFILE",
                "LOCALAPPDATA",
                "PLAYWRIGHT_BROWSERS_PATH",
                "CHROME_DEVEL_SANDBOX",
            }
        )
            if (Environment.GetEnvironmentVariable(name) is string value)
                start.Environment[name] = value;
        start.ArgumentList.Add("--max-old-space-size=256");
        start.ArgumentList.Add(helper);
        using var child = Process.Start(start);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(100));
        async Task<string> Bounded(StreamReader stream, int limit)
        {
            var result = new StringBuilder();
            var chunk = new char[8192];
            int read;
            while ((read = await stream.ReadAsync(chunk, timeout.Token)) > 0)
            {
                if (result.Length + read > limit)
                {
                    timeout.Cancel();
                    throw new IOException("Document response exceeds bound.");
                }
                result.Append(chunk, 0, read);
            }
            return result.ToString();
        }
        var output = Bounded(child.StandardOutput, 48 * 1024 * 1024);
        var errors = Bounded(child.StandardError, 32768);
        try
        {
            await child.StandardInput.WriteAsync(
                JsonSerializer.Serialize(input).AsMemory(),
                timeout.Token
            );
            child.StandardInput.Close();
            await child.WaitForExitAsync(timeout.Token);
            await Task.WhenAll(output, errors);
            if (child.ExitCode != 0)
                throw new IOException(
                    "Document processor failed; inspect configuration and supported content. No derived completion recorded."
                );
            return JsonNode.Parse(await output)?.AsObject()
                ?? throw new IOException("Document response missing.");
        }
        catch
        {
            if (!child.HasExited)
                child.Kill(true);
            try
            {
                await Task.WhenAll(output, errors);
            }
            catch { }
            throw;
        }
    }
}
