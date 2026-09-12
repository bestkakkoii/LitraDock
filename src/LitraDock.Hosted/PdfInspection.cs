using System.Diagnostics;
using System.Text.Json;
using LitraDock.Core;

namespace Literature.Service;

// PDF 解析在一次性子程序；限制時間與觀測記憶體，輸入/輸出都不是命令列程式碼。
// 這不是 OS 沙箱；正式部署仍須非特權帳號、容器限制與私人磁碟權限。
public static class PdfInspection
{
    private static readonly SemaphoreSlim Gate = new(2, 2);

    public sealed record Input(
        byte[] Bytes,
        Article Article,
        bool Confirmed,
        string DerivedKind = null
    );

    public sealed record Output(ArtifactInfo Info, string State, string Error);

    public static async Task<ArtifactInfo> Inspect(
        byte[] bytes,
        Article article,
        bool confirmed,
        string derivedKind = null
    )
    {
        if (!await Gate.WaitAsync(0))
            throw new SourceException("failed", "PDF validation capacity is busy; retry later.");
        try
        {
            var start = new ProcessStartInfo("dotnet")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add(typeof(PdfInspection).Assembly.Location);
            start.ArgumentList.Add("--inspect-pdf");
            foreach (
                var key in start
                    .Environment.Keys.Where(k =>
                        k.StartsWith("LITRADOCK_", StringComparison.OrdinalIgnoreCase)
                    )
                    .ToArray()
            )
                start.Environment.Remove(key);
            start.Environment["DOTNET_GCHeapHardLimit"] = "10000000";
            using var process = Process.Start(start);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
            try
            {
                var input = JsonSerializer.Serialize(
                    new Input(bytes, article, confirmed, derivedKind)
                );
                await process.StandardInput.WriteAsync(input.AsMemory(), timeout.Token);
                process.StandardInput.Close();
                while (!process.HasExited)
                {
                    process.Refresh();
                    if (process.WorkingSet64 > 384L * 1024 * 1024)
                        throw new SourceException(
                            "failed",
                            "PDF validation memory budget exceeded; original not accepted."
                        );
                    await Task.Delay(25, timeout.Token);
                }
                var text = await stdout;
                await stderr;
                if (process.ExitCode != 0 || text.Length > 1024 * 1024)
                    throw new SourceException(
                        "failed",
                        "PDF validation process failed; no completion recorded."
                    );
                var result = JsonSerializer.Deserialize<Output>(text);
                if (result.Info == null)
                    throw new SourceException(
                        result.State ?? "failed",
                        result.Error ?? "PDF validation failed."
                    );
                return result.Info;
            }
            catch (OperationCanceledException)
            {
                throw new SourceException(
                    "failed",
                    "PDF validation time limit reached; original not accepted."
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
        finally
        {
            Gate.Release();
        }
    }
}
