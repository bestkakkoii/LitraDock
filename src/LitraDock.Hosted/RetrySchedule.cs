using Npgsql;

namespace Literature.Service;

public sealed partial class PgStore
{
    public async Task VerifyOperational()
    {
        await using var db = await Data.OpenConnectionAsync();
        if ((bool)await Scalar(db, "SELECT required FROM ld_recovery_guard WHERE singleton"))
            throw new InvalidOperationException(
                "Database/object recovery is incomplete; operator verification required before service startup."
            );
    }

    public async Task Schedule(Claim claim, string category, string reason)
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913002)");
        await Fence(db, claim);
        await ScheduleLocked(db, claim.Library, claim.Job, category, reason);
        await tx.CommitAsync();
    }

    private static async Task ScheduleLocked(
        NpgsqlConnection db,
        Guid library,
        string job,
        string category,
        string reason
    )
    {
        var prior = (
            await Rows(
                db,
                "SELECT * FROM ld_retry WHERE library_id=@p0 AND successor_job=@p1",
                library,
                job
            )
        ).SingleOrDefault();
        var number = prior == null ? 1 : (int)prior["number"] + 1;
        var first = prior == null ? DateTime.UtcNow : (DateTime)prior["first_at"];
        var allowed =
            number <= (category == "rate_wait" ? 8 : 4)
            && DateTime.UtcNow - first < TimeSpan.FromHours(72);
        var delay = TimeSpan.FromSeconds(Math.Min(900, 15 * Math.Pow(4, number - 1)));
        var next = DateTime.UtcNow + delay;
        if (category == "rate_wait")
        {
            var gate = await Scalar(db, "SELECT max(next_at) FROM ld_source_budget");
            if (gate is DateTime time && time > next)
                next = time;
        }
        var state = allowed ? "scheduled" : "failed";
        var message = allowed
            ? reason + " Automatic continuation is scheduled."
            : reason + " Automatic retry budget exhausted; inspect and retry explicitly.";
        await Exec(
            db,
            "UPDATE ld_jobs SET state=@p2,reason=@p3,lease_token=NULL,lease_until=NULL WHERE library_id=@p0 AND job_id=@p1",
            library,
            job,
            state,
            message
        );
        await Exec(
            db,
            "UPDATE ld_items SET state=@p2,reason=@p3 WHERE library_id=@p0 AND last_job_id=@p1",
            library,
            job,
            state,
            message
        );
        await Exec(
            db,
            "UPDATE ld_runs SET state=@p2,reason=@p3 WHERE library_id=@p0 AND run_id=(SELECT run_id FROM ld_jobs WHERE library_id=@p0 AND job_id=@p1)",
            library,
            job,
            state,
            message
        );
        await Exec(
            db,
            "INSERT INTO ld_retry VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,NULL) ON CONFLICT(library_id,job_id) DO NOTHING",
            library,
            job,
            next,
            first,
            number,
            category,
            allowed ? "pending" : "exhausted"
        );
        await Event(db, library, job, state, message);
        await Exec(
            db,
            "UPDATE ld_batches b SET state='completed_with_errors' WHERE b.library_id=@p0 AND b.state IN ('running','queued') AND NOT EXISTS(SELECT 1 FROM ld_items i JOIN ld_jobs j ON j.library_id=i.library_id AND j.job_id=i.last_job_id WHERE i.library_id=b.library_id AND i.batch_id=b.batch_id AND j.state IN ('queued','running','scheduled'))",
            library
        );
    }

    public async Task AdvanceSchedule()
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913002)");
        var rows = await Rows(
            db,
            "SELECT r.*,j.kind,j.run_id,j.item_id,j.search_id FROM ld_retry r JOIN ld_jobs j USING(library_id,job_id) JOIN ld_libraries l USING(library_id) LEFT JOIN ld_items i ON i.library_id=j.library_id AND i.item_id=j.item_id LEFT JOIN ld_batches b ON b.library_id=i.library_id AND b.batch_id=i.batch_id WHERE r.status='pending' AND r.next_at<=now() AND j.state='scheduled' AND l.ready AND (j.kind='search' OR (i.last_job_id=j.job_id AND b.state IN ('queued','running'))) ORDER BY r.next_at,r.job_id LIMIT 100 FOR UPDATE OF r"
        );
        foreach (var row in rows)
        {
            var library = (Guid)row["library_id"];
            var old = (string)row["job_id"];
            var job = "JOB-" + Guid.NewGuid().ToString("N");
            await Exec(
                db,
                "INSERT INTO ld_jobs(library_id,job_id,kind,run_id,item_id,search_id,state) VALUES(@p0,@p1,@p2,@p3,@p4,@p5,'queued')",
                library,
                job,
                row["kind"],
                row["run_id"],
                row["item_id"],
                row["search_id"]
            );
            await Exec(
                db,
                "UPDATE ld_jobs SET state=@p2 WHERE library_id=@p0 AND job_id=@p1 AND state='scheduled'",
                library,
                old,
                row["category"]
            );
            await Exec(
                db,
                "UPDATE ld_retry SET status='dispatched',successor_job=@p2 WHERE library_id=@p0 AND job_id=@p1",
                library,
                old,
                job
            );
            await Exec(
                db,
                "UPDATE ld_items SET state='queued',last_job_id=@p2,reason='Automatic continuation; prior attempt retained.' WHERE library_id=@p0 AND last_job_id=@p1",
                library,
                old,
                job
            );
            await Exec(
                db,
                "UPDATE ld_runs SET state='queued' WHERE library_id=@p0 AND run_id=@p1",
                library,
                row["run_id"]
            );
            await Exec(
                db,
                "INSERT INTO ld_manual_inputs SELECT library_id,@p2,stage_token,hash,kind,provenance FROM ld_manual_inputs WHERE library_id=@p0 AND job_id=@p1",
                library,
                old,
                job
            );
            await Event(db, library, job, "queued", "Automatic continuation of " + old);
        }
        await tx.CommitAsync();
    }

    public async Task RecoverScheduledWork()
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913002)");
        var rows = await Rows(
            db,
            "SELECT library_id,job_id FROM ld_jobs WHERE state='running' AND lease_until<now() ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED"
        );
        foreach (var row in rows)
            await ScheduleLocked(
                db,
                (Guid)row["library_id"],
                (string)row["job_id"],
                "interrupted",
                "Worker lease expired; incomplete publication will be reconciled."
            );
        await tx.CommitAsync();
    }

    public async Task<object> NextEvents(Guid library)
    {
        await using var db = await Data.OpenConnectionAsync();
        return new
        {
            total = await Scalar(
                db,
                "SELECT count(*) FROM ld_retry WHERE library_id=@p0 AND status IN ('pending','paused')",
                library
            ),
            limit = 100,
            items = await Rows(
                db,
                "SELECT job_id,next_at,number,category,status FROM ld_retry WHERE library_id=@p0 AND status IN ('pending','paused') ORDER BY next_at LIMIT 100",
                library
            ),
        };
    }
}
