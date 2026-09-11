namespace Literature.Service;

public sealed partial class PgStore
{
    public async Task<Claim> ClaimNext()
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913002)");
        var row = (
            await Rows(
                db,
                "SELECT j.* FROM ld_jobs j JOIN ld_libraries l USING(library_id) LEFT JOIN ld_items i ON i.library_id=j.library_id AND i.item_id=j.item_id LEFT JOIN ld_batches b ON b.library_id=i.library_id AND b.batch_id=i.batch_id WHERE j.state='queued' AND l.ready AND (j.kind='search' OR b.state IN ('queued','running')) ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1"
            )
        ).SingleOrDefault();
        if (row == null)
            return null;
        var claim = new Claim(
            (Guid)row["library_id"],
            (string)row["job_id"],
            (string)row["kind"],
            row["run_id"] as string,
            row["item_id"] as string,
            row["search_id"] as string,
            Guid.NewGuid()
        );
        await Exec(
            db,
            "UPDATE ld_jobs SET state='running',lease_token=@p2,lease_until=now()+interval '60 seconds' WHERE library_id=@p0 AND job_id=@p1",
            claim.Library,
            claim.Job,
            claim.Lease
        );
        if (claim.Item != null)
        {
            await Exec(
                db,
                "UPDATE ld_items SET state='running',attempts=attempts+1 WHERE library_id=@p0 AND item_id=@p1",
                claim.Library,
                claim.Item
            );
            await Exec(
                db,
                "UPDATE ld_batches SET state='running' WHERE library_id=@p0 AND batch_id=(SELECT batch_id FROM ld_items WHERE library_id=@p0 AND item_id=@p1)",
                claim.Library,
                claim.Item
            );
        }
        else
            await Exec(
                db,
                "UPDATE ld_runs SET state='searching' WHERE library_id=@p0 AND run_id=@p1",
                claim.Library,
                claim.Run
            );
        await Event(
            db,
            claim.Library,
            claim.Job,
            "running",
            "Attempt claimed with expiring worker lease."
        );
        await tx.CommitAsync();
        return claim;
    }

    public async Task<bool> Renew(Claim claim)
    {
        await using var db = await Data.OpenConnectionAsync();
        return await Exec(
                db,
                "UPDATE ld_jobs SET lease_until=now()+interval '60 seconds' WHERE library_id=@p0 AND job_id=@p1 AND lease_token=@p2 AND state='running' AND lease_until>now()",
                claim.Library,
                claim.Job,
                claim.Lease
            ) == 1;
    }

    public async Task Progress(Claim claim, string state, string reason)
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Fence(db, claim);
        await Exec(
            db,
            "UPDATE ld_jobs SET reason=@p2 WHERE library_id=@p0 AND job_id=@p1",
            claim.Library,
            claim.Job,
            state + ": " + reason
        );
        if (claim.Item != null)
            await Exec(
                db,
                "UPDATE ld_items SET state=@p2,reason=@p3 WHERE library_id=@p0 AND item_id=@p1",
                claim.Library,
                claim.Item,
                state,
                reason
            );
        await Event(db, claim.Library, claim.Job, state, reason);
        await tx.CommitAsync();
    }

    public async Task Finish(Claim claim, string state, string reason)
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913002)");
        await Fence(db, claim);
        await Exec(
            db,
            "UPDATE ld_jobs SET state=@p2,reason=@p3,lease_token=NULL,lease_until=NULL WHERE library_id=@p0 AND job_id=@p1",
            claim.Library,
            claim.Job,
            state,
            reason
        );
        if (claim.Item != null)
        {
            await Exec(
                db,
                "UPDATE ld_items SET state=@p2,reason=@p3 WHERE library_id=@p0 AND item_id=@p1 AND last_job_id=@p4",
                claim.Library,
                claim.Item,
                state,
                reason,
                claim.Job
            );
            await Exec(
                db,
                "UPDATE ld_batches b SET state=CASE WHEN EXISTS(SELECT 1 FROM ld_items i WHERE i.library_id=b.library_id AND i.batch_id=b.batch_id AND i.state<>'completed') THEN 'completed_with_errors' ELSE 'completed' END WHERE b.library_id=@p0 AND b.batch_id=(SELECT batch_id FROM ld_items WHERE library_id=@p0 AND item_id=@p1) AND b.state='running' AND NOT EXISTS(SELECT 1 FROM ld_jobs j JOIN ld_items i ON i.library_id=j.library_id AND i.item_id=j.item_id WHERE i.library_id=b.library_id AND i.batch_id=b.batch_id AND j.state IN ('queued','running'))",
                claim.Library,
                claim.Item
            );
        }
        else if (state != "completed")
            await Exec(
                db,
                "UPDATE ld_runs SET state=@p2,reason=@p3 WHERE library_id=@p0 AND run_id=@p1",
                claim.Library,
                claim.Run,
                state,
                reason
            );
        await Event(db, claim.Library, claim.Job, state, reason);
        await tx.CommitAsync();
    }

    public async Task PauseClaim(Claim claim)
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913002)");
        await Fence(db, claim);
        if (claim.Item != null)
        {
            var batch = (string)
                await Scalar(
                    db,
                    "SELECT batch_id FROM ld_items WHERE library_id=@p0 AND item_id=@p1",
                    claim.Library,
                    claim.Item
                );
            await PauseBatch(
                db,
                claim.Library,
                batch,
                "Worker stopped; explicit continuation required."
            );
        }
        else
        {
            await Exec(
                db,
                "UPDATE ld_jobs SET state='paused',lease_token=NULL,lease_until=NULL WHERE library_id=@p0 AND job_id=@p1",
                claim.Library,
                claim.Job
            );
            await Exec(
                db,
                "UPDATE ld_runs SET state='paused',reason='Worker stopped; repeat search explicitly.' WHERE library_id=@p0 AND run_id=@p1",
                claim.Library,
                claim.Run
            );
        }
        await Event(
            db,
            claim.Library,
            claim.Job,
            "paused",
            "Worker stopped; uncompleted batch work paused together."
        );
        await tx.CommitAsync();
    }

    private static async Task PauseBatch(
        Npgsql.NpgsqlConnection db,
        Guid library,
        string batch,
        string reason
    )
    {
        await Exec(
            db,
            "UPDATE ld_jobs j SET state='paused',lease_token=NULL,lease_until=NULL,reason=@p2 FROM ld_items i WHERE j.library_id=@p0 AND i.library_id=j.library_id AND i.item_id=j.item_id AND i.batch_id=@p1 AND j.state IN ('queued','running')",
            library,
            batch,
            reason
        );
        await Exec(
            db,
            "UPDATE ld_items SET state='paused',reason=@p2 WHERE library_id=@p0 AND batch_id=@p1 AND state IN ('queued','running','waiting','downloading','validating','publishing','resolving','redirecting')",
            library,
            batch,
            reason
        );
        await Exec(
            db,
            "UPDATE ld_batches SET state='paused' WHERE library_id=@p0 AND batch_id=@p1",
            library,
            batch
        );
    }

    public async Task Control(Guid library, string batch, string action)
    {
        if (action is not ("paused" or "cancelled" or "resume" or "retry"))
            throw new ArgumentException("Invalid control action.");
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913002)");
        var state =
            await Scalar(
                db,
                "SELECT state FROM ld_batches WHERE library_id=@p0 AND batch_id=@p1 FOR UPDATE",
                library,
                batch
            ) as string;
        if (state == null)
            throw new KeyNotFoundException();
        if (action == "resume" && state != "paused" || action == "retry" && state == "running")
            throw new InvalidOperationException("Batch must settle before continuation.");
        if (action is "paused" or "cancelled")
        {
            if (state is "completed" or "completed_with_errors")
                throw new InvalidOperationException("Settled batches have no active work to stop.");
            await Exec(
                db,
                "UPDATE ld_jobs j SET state=@p2,lease_token=NULL,lease_until=NULL,reason='Explicit batch control.' FROM ld_items i WHERE j.library_id=@p0 AND i.library_id=j.library_id AND i.item_id=j.item_id AND i.batch_id=@p1 AND j.state IN ('queued','running')",
                library,
                batch,
                action
            );
            await Exec(
                db,
                "UPDATE ld_items SET state=@p2,reason='Explicit batch control.' WHERE library_id=@p0 AND batch_id=@p1 AND state IN ('queued','running','waiting','downloading','validating','publishing','resolving','redirecting','paused')",
                library,
                batch,
                action
            );
        }
        else
        {
            var items = await Rows(
                db,
                "SELECT item_id,search_id FROM ld_items WHERE library_id=@p0 AND batch_id=@p1 AND state IN ('paused','cancelled','failed','unavailable','needs_login')",
                library,
                batch
            );
            if (items.Count == 0)
                throw new InvalidOperationException(
                    "No eligible items; batch state remains unchanged."
                );
            foreach (var item in items)
            {
                var job = "JOB-" + Guid.NewGuid().ToString("N");
                await Exec(
                    db,
                    "INSERT INTO ld_jobs(library_id,job_id,kind,item_id,search_id,state) VALUES(@p0,@p1,'acquire',@p2,@p3,'queued')",
                    library,
                    job,
                    item["item_id"],
                    item["search_id"]
                );
                await Exec(
                    db,
                    "UPDATE ld_items SET state='queued',last_job_id=@p2,reason='Explicit continuation; prior attempt retained.' WHERE library_id=@p0 AND item_id=@p1",
                    library,
                    item["item_id"],
                    job
                );
            }
        }
        await Exec(
            db,
            "UPDATE ld_batches SET state=@p2 WHERE library_id=@p0 AND batch_id=@p1",
            library,
            batch,
            action is "retry" or "resume" ? "queued" : action
        );
        await Event(db, library, null, action, "Batch " + batch);
        await tx.CommitAsync();
    }

    public async Task RecoverExpired()
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913002)");
        var expired = await Rows(
            db,
            "SELECT * FROM ld_jobs WHERE state='running' AND lease_until<now() FOR UPDATE SKIP LOCKED LIMIT 100"
        );
        foreach (var row in expired)
        {
            var library = (Guid)row["library_id"];
            var job = (string)row["job_id"];
            if (row["item_id"] is string item)
            {
                var batch = (string)
                    await Scalar(
                        db,
                        "SELECT batch_id FROM ld_items WHERE library_id=@p0 AND item_id=@p1",
                        library,
                        item
                    );
                await PauseBatch(
                    db,
                    library,
                    batch,
                    "Worker lease expired; explicit continuation required."
                );
            }
            await Exec(
                db,
                "UPDATE ld_jobs SET state='paused',lease_token=NULL,lease_until=NULL,reason='Worker lease expired; explicit retry required.' WHERE library_id=@p0 AND job_id=@p1",
                library,
                job
            );
            await Exec(
                db,
                "UPDATE ld_items SET state='paused',reason='Worker lease expired.' WHERE library_id=@p0 AND last_job_id=@p1",
                library,
                job
            );
            await Exec(
                db,
                "UPDATE ld_batches SET state='paused' WHERE library_id=@p0 AND batch_id=(SELECT batch_id FROM ld_items WHERE library_id=@p0 AND last_job_id=@p1)",
                library,
                job
            );
            await Exec(
                db,
                "UPDATE ld_runs SET state='paused',reason='Search interrupted; repeat explicitly; fetched results retained.' WHERE library_id=@p0 AND run_id=@p1",
                library,
                row["run_id"]
            );
            await Event(
                db,
                library,
                job,
                "paused",
                "Lease expired; source files and attempts retained."
            );
        }
        await tx.CommitAsync();
    }
}
