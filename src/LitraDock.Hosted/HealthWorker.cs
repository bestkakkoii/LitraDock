using System.Text.Json;

namespace Literature.Service;

public sealed class HealthWorker(PgStore store, OriginalStore originals) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
            try
            {
                await using var admission = await ResourceAdmission.Enter(store, heavy: true);
                await store.HealthStep(originals);
            }
            catch (ResourceBusyException) { }
            catch (Exception) when (!stoppingToken.IsCancellationRequested)
            {
                Console.Error.WriteLine(
                    "Background integrity scan could not finish; originals retained and next bounded scan remains eligible."
                );
            }
        }
    }
}

public sealed partial class PgStore
{
    public async Task HealthStep(OriginalStore originals)
    {
        await using var db = await Data.OpenConnectionAsync();
        var row = (
            await Rows(
                db,
                "SELECT l.library_id,coalesce(s.next_offset,0) AS next_offset FROM ld_libraries l LEFT JOIN ld_health_scans s USING(library_id) WHERE l.ready ORDER BY s.checked_at NULLS FIRST,l.library_id LIMIT 1"
            )
        ).SingleOrDefault();
        if (row == null)
            return;
        var library = (Guid)row["library_id"];
        int next = 0;
        string reason = "Bounded integrity page completed.";
        try
        {
            var result = JsonSerializer.SerializeToElement(
                await InspectHealth(library, originals, (int)row["next_offset"])
            );
            next = result.GetProperty("nextOffset").GetInt32();
        }
        catch (IOException)
        {
            reason = "Integrity page failed; retained for operator review and bounded retry.";
        }
        await Exec(
            db,
            "INSERT INTO ld_health_scans VALUES(@p0,@p1,now(),@p2) ON CONFLICT(library_id) DO UPDATE SET next_offset=excluded.next_offset,checked_at=excluded.checked_at,reason=excluded.reason",
            library,
            next,
            reason
        );
    }
}
