using System.Net;
using Literature.Service;
using LitraDock.Core;
using Npgsql;

// 只在已明確授權的合成 PG 測試庫安裝短暫 fault trigger；finally 移除，不修改正式 schema。
public static class BudgetFailureChecks
{
    public static async Task Run(PgStore store, string connection, Action<bool, string> check)
    {
        await using var db = new NpgsqlConnection(connection);
        await db.OpenAsync();
        async Task Execute(string sql)
        {
            await using var command = new NpgsqlCommand(sql, db);
            await command.ExecuteNonQueryAsync();
        }
        foreach (var cleanupAlsoFails in new[] { false, true })
        {
            await Execute("UPDATE ld_source_budget SET next_at=now() WHERE name='europepmc'");
            var content = new TrackedContent();
            using var inner = new FaultHeaders(
                async () =>
                {
                    await Execute("CREATE SEQUENCE source_fault_counter");
                    await Execute(
                        "CREATE FUNCTION source_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='europepmc' AND (nextval('source_fault_counter')=1 OR "
                            + (cleanupAlsoFails ? "true" : "false")
                            + ") THEN RAISE EXCEPTION 'Synthetic budget write failure'; END IF; RETURN NEW; END $$"
                    );
                    await Execute(
                        "CREATE TRIGGER source_fault BEFORE UPDATE ON ld_source_budget FOR EACH ROW EXECUTE FUNCTION source_fault()"
                    );
                },
                content
            );
            try
            {
                using var client = new HttpMessageInvoker(
                    new SourceRequestHandler(store, inner, "europepmc")
                );
                var failed = false;
                try
                {
                    using var response = await client.SendAsync(
                        new(
                            HttpMethod.Get,
                            "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML"
                        ),
                        CancellationToken.None
                    );
                }
                catch (PostgresException)
                {
                    failed = true;
                }
                check(
                    failed && content.Disposed && !content.Read,
                    "Actual PG header-budget fault disposes unread response; cleanup also fails="
                        + cleanupAlsoFails
                );
            }
            finally
            {
                await Execute(
                    "DROP TRIGGER IF EXISTS source_fault ON ld_source_budget; DROP FUNCTION IF EXISTS source_fault(); DROP SEQUENCE IF EXISTS source_fault_counter"
                );
            }
            await using var gate = new NpgsqlCommand("SELECT pg_try_advisory_lock(724913004)", db);
            check(
                (bool)await gate.ExecuteScalarAsync(),
                "Budget SQL failure releases session gate=" + cleanupAlsoFails
            );
            await Execute("SELECT pg_advisory_unlock(724913004)");
        }
        await Execute("UPDATE ld_source_budget SET next_at=now() WHERE name='europepmc'");
        var oversized = new TrackedContent();
        oversized.Headers.ContentLength = NcbiTransport.MaximumBytes + 1;
        using (
            var client = new HttpMessageInvoker(
                new SourceRequestHandler(
                    store,
                    new FaultHeaders(() => Task.CompletedTask, oversized, true),
                    "europepmc"
                )
            )
        )
        {
            try
            {
                using var response = await client.SendAsync(
                    new(
                        HttpMethod.Get,
                        "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML"
                    ),
                    CancellationToken.None
                );
            }
            catch (SourceException) { }
        }
        await using var remaining = new NpgsqlCommand(
            "SELECT next_at > now()+interval '55 seconds' FROM ld_source_budget WHERE name='europepmc'",
            db
        );
        check(
            oversized.Disposed && !oversized.Read && (bool)await remaining.ExecuteScalarAsync(),
            "Actual PG retains 60-second Retry-After after rejected oversized body and cleanup"
        );
        await Execute("UPDATE ld_source_budget SET next_at=now() WHERE name='europepmc'");
    }

    private sealed class FaultHeaders(
        Func<Task> fault,
        TrackedContent content,
        bool limited = false
    ) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellation
        )
        {
            await fault();
            var response = new HttpResponseMessage(
                limited ? HttpStatusCode.TooManyRequests : HttpStatusCode.OK
            )
            {
                Content = content,
            };
            if (limited)
                response.Headers.RetryAfter = new(TimeSpan.FromSeconds(60));
            return response;
        }
    }

    private sealed class TrackedContent : HttpContent
    {
        public bool Disposed;
        public bool Read;

        protected override bool TryComputeLength(out long length)
        {
            length = 1;
            return true;
        }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext context)
        {
            Read = true;
            return stream.WriteAsync(new byte[] { 1 }).AsTask();
        }

        protected override void Dispose(bool disposing)
        {
            Disposed = true;
            base.Dispose(disposing);
        }
    }
}
