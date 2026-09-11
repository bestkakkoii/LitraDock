using System.Net;
using LitraDock.Core;
using Npgsql;

namespace Literature.Service;

// 時槽先以獨立提交保存，程序退出不能回滾已發送要求的頻率預算。
// Session advisory lock 跨越網路回應；回傳連線池前必須解除，失敗則清除該池。
public sealed class SourceRequestHandler(
    PgStore store,
    HttpMessageHandler inner,
    string provider = "ncbi",
    TimeProvider clock = null
) : DelegatingHandler(inner)
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        if (provider is not ("ncbi" or "europepmc"))
            throw new ArgumentException("Unknown source budget.");
        if (SourceEndpoints.Provider(request.RequestUri) != provider)
            throw new SourceException(
                "unsupported",
                "Request does not match its approved source budget."
            );
        var gate = provider == "ncbi" ? 724913003L : 724913004L;
        await using var db = await store.Data.OpenConnectionAsync(cancellationToken);
        try
        {
            // 非阻塞鎖迴圈讓等待本身能立即取消；不把取消 token 留在不支援的同步 SQL 裡。
            while (true)
            {
                await using var acquire = PgStore.Cmd(db, "SELECT pg_try_advisory_lock(@p0)", gate);
                if ((bool)await acquire.ExecuteScalarAsync(cancellationToken))
                    break;
                await Task.Delay(50, cancellationToken);
            }
            await PgStore.Exec(
                db,
                "INSERT INTO ld_source_budget VALUES(@p0,now()) ON CONFLICT DO NOTHING",
                provider
            );
            var next = (DateTime)
                await PgStore.Scalar(
                    db,
                    "SELECT next_at FROM ld_source_budget WHERE name=@p0",
                    provider
                );
            var delay = next - DateTime.UtcNow;
            if (delay > TimeSpan.FromSeconds(30))
                throw new SourceException(
                    "rate_wait",
                    "Shared source cooldown exceeds this attempt budget; retry later."
                );
            if (delay > TimeSpan.Zero)
                await Task.Delay(delay, cancellationToken);
            if (provider == "ncbi")
            {
                var eastern = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
                var scheduleUtc = (clock ?? TimeProvider.System).GetUtcNow().UtcDateTime;
                var local = TimeZoneInfo.ConvertTimeFromUtc(scheduleUtc, eastern);
                var day = local.ToString(
                    "yyyy-MM-dd",
                    System.Globalization.CultureInfo.InvariantCulture
                );
                await PgStore.Exec(
                    db,
                    "INSERT INTO ld_source_usage VALUES(@p0,@p1,0) ON CONFLICT DO NOTHING",
                    provider,
                    day
                );
                var used = Convert.ToInt32(
                    await PgStore.Scalar(
                        db,
                        "SELECT requests FROM ld_source_usage WHERE provider=@p0 AND day=@p1",
                        provider,
                        day
                    )
                );
                // 大批次開始之前即採離峰 admission；不是先發一百次再稱整批符合離峰政策。
                var largeBatch = (bool)
                    await PgStore.Scalar(
                        db,
                        "SELECT EXISTS(SELECT 1 FROM ld_batches b WHERE b.state IN ('queued','running') AND (SELECT count(*) FROM ld_items i WHERE i.library_id=b.library_id AND i.batch_id=b.batch_id)>100)"
                    );
                var resume = SourceSchedule.NcbiResume(scheduleUtc, largeBatch, used);
                if (resume.HasValue)
                {
                    await PgStore.Exec(
                        db,
                        "UPDATE ld_source_budget SET next_at=GREATEST(next_at,@p0) WHERE name=@p1",
                        resume.Value,
                        provider
                    );
                    throw new SourceException(
                        "rate_wait",
                        largeBatch
                            ? "A batch exceeding 100 items requires off-peak NCBI admission; retry after 21:00 US Eastern or on weekends."
                            : "NCBI daytime request allowance reached; retry after 21:00 US Eastern or on weekends."
                    );
                }
                await PgStore.Exec(
                    db,
                    "UPDATE ld_source_usage SET requests=requests+1 WHERE provider=@p0 AND day=@p1",
                    provider,
                    day
                );
            }
            var until = DateTime.UtcNow.AddMilliseconds(provider == "ncbi" ? 400 : 1000);
            await PgStore.Exec(
                db,
                "UPDATE ld_source_budget SET next_at=@p0 WHERE name=@p1",
                until,
                provider
            );
            HttpResponseMessage response = null;
            try
            {
                response = await base.SendAsync(request, cancellationToken);
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
                await PgStore.Exec(
                    db,
                    "UPDATE ld_source_budget SET next_at=GREATEST(next_at,@p0) WHERE name=@p1",
                    until,
                    provider
                );

                try
                {
                    if (response.Content.Headers.ContentLength > NcbiTransport.MaximumBytes)
                        throw new SourceException(
                            "failed",
                            "Source exceeds 32 MiB; no truncation."
                        );
                    await response.Content.LoadIntoBufferAsync(
                        NcbiTransport.MaximumBytes,
                        cancellationToken
                    );
                }
                catch
                {
                    response.Dispose();
                    throw;
                }
            }
            catch
            {
                response?.Dispose();
                await PgStore.Exec(
                    db,
                    "UPDATE ld_source_budget SET next_at=GREATEST(next_at,@p0) WHERE name=@p1",
                    DateTime.UtcNow.AddSeconds(2),
                    provider
                );
                throw;
            }
            try
            {
                await PgStore.Exec(
                    db,
                    "UPDATE ld_source_budget SET next_at=GREATEST(next_at,@p0) WHERE name=@p1",
                    until,
                    provider
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
                await PgStore.Exec(db, "SELECT pg_advisory_unlock(@p0)", gate);
            }
            catch
            {
                NpgsqlConnection.ClearPool(db);
            }
        }
    }
}
