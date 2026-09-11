using System.Net;
using LitraDock.Core;
using Npgsql;

namespace Literature.Service;

// 同一資料庫的所有來源程序共用請求時槽與 Retry-After；網路中斷不代表工作完成。
public sealed class SourceRequestHandler(PgStore store, HttpMessageHandler inner)
    : DelegatingHandler(inner)
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        await using var db = await store.Data.OpenConnectionAsync(cancellationToken);
        await using var tx = await db.BeginTransactionAsync(cancellationToken);
        await PgStore.Exec(db, "SELECT pg_advisory_xact_lock(724913003)");
        var next = (DateTime)
            await PgStore.Scalar(db, "SELECT next_at FROM ld_source_budget WHERE name='ncbi'");
        var delay = next - DateTime.UtcNow;
        if (delay > TimeSpan.FromSeconds(30))
            throw new SourceException(
                "failed",
                "Shared source cooldown exceeds this attempt budget; retry later."
            );
        if (delay > TimeSpan.Zero)
            await Task.Delay(delay, cancellationToken);
        var started = DateTime.UtcNow;
        HttpResponseMessage response;
        try
        {
            response = await base.SendAsync(request, cancellationToken);
        }
        catch
        {
            await PgStore.Exec(
                db,
                "UPDATE ld_source_budget SET next_at=@p0 WHERE name='ncbi'",
                DateTime.UtcNow.AddSeconds(2)
            );
            await tx.CommitAsync();
            throw;
        }
        var until = started.AddMilliseconds(400);
        if (
            response.StatusCode
            is HttpStatusCode.TooManyRequests
                or HttpStatusCode.ServiceUnavailable
                or HttpStatusCode.BadGateway
        )
        {
            var retry = response.Headers.RetryAfter;
            var requested =
                retry?.Date?.UtcDateTime
                ?? DateTime.UtcNow.Add(retry?.Delta ?? TimeSpan.FromSeconds(2));
            if (requested > until)
                until = requested;
        }
        try
        {
            await PgStore.Exec(
                db,
                "UPDATE ld_source_budget SET next_at=@p0 WHERE name='ncbi'",
                until
            );
            await tx.CommitAsync();
            return response;
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }
}
