using System.Net;
using LitraDock.Core;
using Npgsql;

namespace Literature.Service;

// 時槽先以獨立提交保存，程序退出不能回滾已發送要求的頻率預算。
// Session advisory lock 跨越網路回應；回傳連線池前必須解除，失敗則清除該池。
public sealed class SourceRequestHandler(PgStore store, HttpMessageHandler inner)
    : DelegatingHandler(inner)
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        await using var db = await store.Data.OpenConnectionAsync(cancellationToken);
        try
        {
            await PgStore.Exec(db, "SELECT pg_advisory_lock(724913003)");
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
            var until = DateTime.UtcNow.AddMilliseconds(400);
            await PgStore.Exec(
                db,
                "UPDATE ld_source_budget SET next_at=@p0 WHERE name='ncbi'",
                until
            );
            HttpResponseMessage response;
            try
            {
                response = await base.SendAsync(request, cancellationToken);
            }
            catch
            {
                await PgStore.Exec(
                    db,
                    "UPDATE ld_source_budget SET next_at=GREATEST(next_at,@p0) WHERE name='ncbi'",
                    DateTime.UtcNow.AddSeconds(2)
                );
                throw;
            }
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
                    "UPDATE ld_source_budget SET next_at=GREATEST(next_at,@p0) WHERE name='ncbi'",
                    until
                );
                return response;
            }
            catch
            {
                response.Dispose();
                throw;
            }
        }
        finally
        {
            try
            {
                await PgStore.Exec(db, "SELECT pg_advisory_unlock(724913003)");
            }
            catch
            {
                NpgsqlConnection.ClearPool(db);
            }
        }
    }
}
