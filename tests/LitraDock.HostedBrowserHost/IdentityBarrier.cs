using Microsoft.AspNetCore.Http;

namespace Literature.Verification;

// 僅 fixture host 編譯；正式服務沒有此型別、標頭分支或可設定的認證屏障。
public static class IdentityBarrier
{
    public static async Task Wait(HttpContext context, string phase)
    {
        if (context.Request.Headers["X-Identity-Barrier"] != phase) return;
        var root = Environment.GetEnvironmentVariable("LITRADOCK_IDENTITY_BARRIER");
        if (root == null || Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes")
            throw new InvalidOperationException("Explicit fixture barrier required.");
        await File.WriteAllTextAsync(Path.Combine(root, phase + ".ready"), "Authentication reached barrier.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        deadline.CancelAfter(TimeSpan.FromSeconds(20));
        while (!File.Exists(Path.Combine(root, phase + ".release")))
            await Task.Delay(20, deadline.Token);
    }
}
