using System.Text.Json;
using LitraDock.Core;

namespace Literature.Service;

public sealed partial class PgStore
{
    public async Task<object> ManualItem(Guid library, string article)
    {
        var record = await Article(library, article);
        var scope = "SCOPE-" + Guid.NewGuid().ToString("N");
        var batch = "BATCH-" + Guid.NewGuid().ToString("N");
        var item = "ITEM-" + Guid.NewGuid().ToString("N");
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(
            db,
            "INSERT INTO ld_scopes VALUES(@p0,@p1,NULL,NULL,'Manual original continuation')",
            library,
            scope
        );
        await Exec(
            db,
            "INSERT INTO ld_members VALUES(@p0,@p1,@p2,1,true)",
            library,
            scope,
            article
        );
        await Exec(
            db,
            "INSERT INTO ld_batches VALUES(@p0,@p1,@p2,'paused',@p3)",
            library,
            batch,
            scope,
            Naming.DefaultTemplate
        );
        await Exec(
            db,
            "INSERT INTO ld_items VALUES(@p0,@p1,@p2,@p3,1,'paused',0,NULL,'Waiting for user original',@p4)",
            library,
            item,
            batch,
            article,
            Naming.Preview(record)
        );
        await Event(
            db,
            library,
            null,
            "manual_item",
            "Manual item " + item + " created without a source request."
        );
        await tx.CommitAsync();
        return new
        {
            scope,
            batch,
            item,
        };
    }

    public async Task<string> QueueManual(
        Guid library,
        string article,
        string item,
        byte[] bytes,
        string sourceUri,
        string version,
        OriginalStore originals
    )
    {
        if (version is not ("published" or "accepted-manuscript" or "preprint" or "unspecified"))
            throw new ArgumentException("Choose a supported version label.");
        if (
            sourceUri.Length > 2000
            || (
                sourceUri.Length > 0
                && (
                    !Uri.TryCreate(sourceUri, UriKind.Absolute, out var location)
                    || location.Scheme != "https"
                    || location.UserInfo != ""
                    || location.Query != ""
                    || location.Fragment != ""
                    || !location.IsDefaultPort
                )
            )
        )
            throw new ArgumentException(
                "Use a stable HTTPS source location without credentials, query or fragment, or leave it blank."
            );
        var record = await Article(library, article);
        ArtifactInfo info;
        var state = "queued";
        try
        {
            info = OriginalValidation.Validate(bytes, record);
        }
        catch (SourceException error) when (error.State == "needs_review")
        {
            info = OriginalValidation.Validate(bytes, record, true);
            info.Validation =
                "Saved original passed format bounds; identity pending explicit user review, not machine verified.";
            state = "needs_review";
        }
        var kind = OriginalValidation.Kind(bytes);
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913002)");
        var row = (
            await Rows(
                db,
                "SELECT i.*,b.state AS batch_state FROM ld_items i JOIN ld_batches b USING(library_id,batch_id) WHERE i.library_id=@p0 AND i.item_id=@p1 AND i.search_id=@p2 FOR UPDATE OF i,b",
                library,
                item,
                article
            )
        ).SingleOrDefault();
        if (row == null)
            throw new KeyNotFoundException();
        if ((string)row["batch_state"] is "running" or "queued")
            throw new InvalidOperationException(
                "Pause or finish this batch before associating a manual original."
            );
        var job = "JOB-" + Guid.NewGuid().ToString("N");
        var token = Guid.NewGuid();
        // 先持久化已驗證輸入，再提交可見工作；中斷留下檔案證據而不是虛假完成。
        originals.Stage(new Claim(library, job, "acquire", null, item, article, token), bytes);
        var provenance = JsonSerializer.Serialize(
            new
            {
                method = "user_upload",
                identityConfirmed = false,
                version,
                source = sourceUri,
                sourceStatus = "User supplied; not automatically visited",
                receivedAt = DateTime.UtcNow.ToString("o"),
                license = info.License,
                validation = info.Validation,
                hash = info.Hash,
                kind,
                locations = SourceAcquisition.Locations(record),
            }
        );
        await Exec(
            db,
            "INSERT INTO ld_jobs(library_id,job_id,kind,item_id,search_id,state) VALUES(@p0,@p1,'acquire',@p2,@p3,@p4)",
            library,
            job,
            item,
            article,
            state
        );
        await Exec(
            db,
            "INSERT INTO ld_manual_inputs VALUES(@p0,@p1,@p2,@p3,@p4,@p5)",
            library,
            job,
            token.ToString("N"),
            info.Hash,
            kind,
            provenance
        );
        await Exec(
            db,
            "UPDATE ld_items SET state=@p4,last_job_id=@p2,reason='Manual input retained; identity review or durable publication pending.',planned_name=@p3 WHERE library_id=@p0 AND item_id=@p1",
            library,
            item,
            job,
            Path.ChangeExtension((string)row["planned_name"], OriginalValidation.Extension(kind)),
            state
        );
        await Exec(
            db,
            "UPDATE ld_batches SET state=@p2 WHERE library_id=@p0 AND batch_id=@p1",
            library,
            row["batch_id"],
            state == "queued" ? "queued" : "completed_with_errors"
        );
        await Event(
            db,
            library,
            job,
            state,
            "Manual original continues item " + item + "; previous attempts retained."
        );
        await tx.CommitAsync();
        return job;
    }

    public async Task<string> ConfirmManual(Guid library, string article, string item)
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913002)");
        var row = (
            await Rows(
                db,
                "SELECT m.*,i.batch_id FROM ld_items i JOIN ld_manual_inputs m ON m.library_id=i.library_id AND m.job_id=i.last_job_id WHERE i.library_id=@p0 AND i.item_id=@p1 AND i.search_id=@p2 AND i.state='needs_review' FOR UPDATE OF i",
                library,
                item,
                article
            )
        ).SingleOrDefault();
        if (row == null)
            throw new KeyNotFoundException();
        var details = JsonSerializer.Deserialize<Dictionary<string, object>>(
            (string)row["provenance"]
        );
        details["identityConfirmed"] = true;
        details["identityReviewedAt"] = DateTime.UtcNow.ToString("o");
        details["validation"] =
            "Uploading account explicitly confirmed relationship; machine identity remains unverified.";
        var job = "JOB-" + Guid.NewGuid().ToString("N");
        await Exec(
            db,
            "INSERT INTO ld_jobs(library_id,job_id,kind,item_id,search_id,state) VALUES(@p0,@p1,'acquire',@p2,@p3,'queued')",
            library,
            job,
            item,
            article
        );
        await Exec(
            db,
            "INSERT INTO ld_manual_inputs VALUES(@p0,@p1,@p2,@p3,@p4,@p5)",
            library,
            job,
            row["stage_token"],
            row["hash"],
            row["kind"],
            JsonSerializer.Serialize(details)
        );
        await Exec(
            db,
            "UPDATE ld_items SET state='queued',last_job_id=@p2,reason='User confirmed original relationship; publication pending.' WHERE library_id=@p0 AND item_id=@p1",
            library,
            item,
            job
        );
        await Exec(
            db,
            "UPDATE ld_batches SET state='queued' WHERE library_id=@p0 AND batch_id=@p1",
            library,
            row["batch_id"]
        );
        await Event(
            db,
            library,
            job,
            "identity_confirmed_by_user",
            "Manual continuation of item " + item + "; automatic identity was not established."
        );
        await tx.CommitAsync();
        return job;
    }

    public static bool IdentityConfirmed(Dictionary<string, object> manual) =>
        manual != null
        && JsonSerializer
            .Deserialize<JsonElement>((string)manual["provenance"])
            .TryGetProperty("identityConfirmed", out var flag)
        && flag.ValueKind == JsonValueKind.True;

    public async Task<Dictionary<string, object>> ManualInput(Claim claim)
    {
        await using var db = await Data.OpenConnectionAsync();
        return (
            await Rows(
                db,
                "SELECT * FROM ld_manual_inputs WHERE library_id=@p0 AND job_id=@p1",
                claim.Library,
                claim.Job
            )
        ).SingleOrDefault();
    }

    public async Task<bool> IsUserConfirmed(Guid library, string article, string hash)
    {
        await using var db = await Data.OpenConnectionAsync();
        return (bool)
            await Scalar(
                db,
                "SELECT EXISTS(SELECT 1 FROM ld_object_provenance WHERE library_id=@p0 AND hash=@p2 AND search_id=@p1 AND details::jsonb->>'identityConfirmed'='true')",
                library,
                article,
                hash
            );
    }

    public async Task<List<Dictionary<string, object>>> Provenance(Guid library, string article)
    {
        await using var db = await Data.OpenConnectionAsync();
        var rows = await Rows(
            db,
            "SELECT job_id,hash,details FROM ld_object_provenance WHERE library_id=@p0 AND search_id=@p1 ORDER BY job_id LIMIT 101",
            library,
            article
        );
        if (rows.Count > 100)
            throw new ArgumentException(
                "Record has more than 100 provenance entries; use scoped export for complete evidence. No history was truncated."
            );
        return rows;
    }
}
