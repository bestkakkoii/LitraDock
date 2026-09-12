using System.Text.Json;
using System.Text.Json.Nodes;
using LitraDock.Core;

namespace Literature.Service;

public sealed record ReviewInput(
    string State,
    string Tags,
    string Note,
    string Reason,
    string Evidence,
    int Revision
);

public sealed partial class PgStore
{
    public async Task<string> CreateProject(Guid library, string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 200)
            throw new ArgumentException("Project name requires 1–200 characters.");
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(hashtextextended(@p0,0))", library.ToString());
        if (
            Convert.ToInt64(
                await Scalar(db, "SELECT count(*) FROM ld_projects WHERE library_id=@p0", library)
            ) >= 1000
        )
            throw new ArgumentException("Library supports up to 1000 projects.");
        var id = "PROJECT-" + Guid.NewGuid().ToString("N");
        await Exec(
            db,
            "INSERT INTO ld_projects(library_id,project_id,name) VALUES(@p0,@p1,@p2)",
            library,
            id,
            name.Trim()
        );
        await tx.CommitAsync();
        return id;
    }

    public async Task<object> Projects(Guid library)
    {
        await using var db = await Data.OpenConnectionAsync();
        return await Rows(
            db,
            "SELECT p.*,count(r.search_id) AS records FROM ld_projects p LEFT JOIN ld_reviews r USING(library_id,project_id) WHERE p.library_id=@p0 GROUP BY p.library_id,p.project_id ORDER BY p.created_at LIMIT 1000",
            library
        );
    }

    public async Task<object> Reviews(Guid library, string project, int offset = 0)
    {
        if (offset < 0 || offset > 10000)
            throw new ArgumentException("Invalid review offset.");
        await using var db = await Data.OpenConnectionAsync();
        await using var snapshot = await db.BeginTransactionAsync(
            System.Data.IsolationLevel.RepeatableRead
        );
        if (
            await Scalar(
                db,
                "SELECT project_id FROM ld_projects WHERE library_id=@p0 AND project_id=@p1",
                library,
                project
            ) == null
        )
            throw new KeyNotFoundException();
        return new
        {
            total = await Scalar(
                db,
                "SELECT count(*) FROM ld_reviews WHERE library_id=@p0 AND project_id=@p1",
                library,
                project
            ),
            records = await Rows(
                db,
                "SELECT r.*,a.metadata FROM ld_reviews r JOIN ld_records a USING(library_id,search_id) WHERE r.library_id=@p0 AND r.project_id=@p1 ORDER BY r.search_id OFFSET @p2 LIMIT 50",
                library,
                project,
                offset
            ),
        };
    }

    public async Task<int> SaveReview(
        Guid library,
        string project,
        string search,
        Guid actor,
        ReviewInput input
    )
    {
        if (
            input.State is not ("unscreened" or "included" or "excluded" or "uncertain")
            || input.Tags == null
            || input.Tags.Length > 1000
            || input.Note == null
            || input.Note.Length > 8000
            || input.Reason == null
            || input.Reason.Length > 2000
            || input.Evidence == null
            || input.Evidence.Length > 4000
        )
            throw new ArgumentException(
                "Review fields exceed bounds or screening state is invalid."
            );
        var evidence = JsonNode.Parse(input.Evidence)?.AsObject() ?? new JsonObject();
        if (
            evidence.Any(x =>
                x.Key is not ("hash" or "quote" or "section" or "page" or "pageKind" or "runId")
            )
        )
            throw new ArgumentException("Unknown evidence field.");
        var hash = evidence["hash"]?.GetValue<string>();
        var pageKind = evidence["pageKind"]?.GetValue<string>();
        if (pageKind != null && pageKind is not ("source" or "derived" or "section"))
            throw new ArgumentException("Choose source or derived page numbering explicitly.");
        if (
            evidence["page"] != null
            && (
                pageKind is not ("source" or "derived")
                || string.IsNullOrEmpty(hash)
                || evidence["page"].GetValue<string>().Length is < 1 or > 80
            )
        )
            throw new ArgumentException(
                "Page evidence needs an explicit source or derived locator."
            );
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(hashtextextended(@p0,0))", library.ToString());
        if (
            await Scalar(
                db,
                "SELECT search_id FROM ld_records WHERE library_id=@p0 AND search_id=@p1",
                library,
                search
            ) == null
            || await Scalar(
                db,
                "SELECT project_id FROM ld_projects WHERE library_id=@p0 AND project_id=@p1",
                library,
                project
            ) == null
        )
            throw new KeyNotFoundException();
        if (!string.IsNullOrEmpty(hash))
        {
            var derived = Convert.ToBoolean(
                await Scalar(
                    db,
                    "SELECT EXISTS(SELECT 1 FROM ld_derivations WHERE library_id=@p0 AND search_id=@p1 AND hash=@p2)",
                    library,
                    search,
                    hash
                )
            );
            var original = Convert.ToBoolean(
                await Scalar(
                    db,
                    "SELECT EXISTS(SELECT 1 FROM ld_article_files WHERE library_id=@p0 AND search_id=@p1 AND hash=@p2)",
                    library,
                    search,
                    hash
                )
            );
            if ((pageKind == "derived" ? !derived : !original))
                throw new ArgumentException(
                    "Evidence version is not associated with this record and locator kind."
                );
        }
        if (
            evidence["runId"] is JsonNode run
            && !Convert.ToBoolean(
                await Scalar(
                    db,
                    "SELECT EXISTS(SELECT 1 FROM ld_results WHERE library_id=@p0 AND search_id=@p1 AND run_id=@p2)",
                    library,
                    search,
                    run.GetValue<string>()
                )
            )
        )
            throw new ArgumentException("Search evidence does not contain this record.");
        if (
            Convert.ToInt64(
                await Scalar(
                    db,
                    "SELECT count(*) FROM ld_review_events WHERE library_id=@p0",
                    library
                )
            ) >= 10000
        )
            throw new ArgumentException(
                "Library decision history limit reached; no edits discarded."
            );
        var prior = await Scalar(
            db,
            "SELECT revision FROM ld_reviews WHERE library_id=@p0 AND project_id=@p1 AND search_id=@p2 FOR UPDATE",
            library,
            project,
            search
        );
        var revision = prior == null ? 0 : Convert.ToInt32(prior);
        if (revision != input.Revision)
            throw new ArgumentException(
                "Review changed since it was loaded; reload before saving."
            );
        if (
            revision == 0
            && Convert.ToInt64(
                await Scalar(db, "SELECT count(*) FROM ld_reviews WHERE library_id=@p0", library)
            ) >= 10000
        )
            throw new ArgumentException("Library review limit reached.");
        await Exec(
            db,
            "INSERT INTO ld_reviews VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,@p9,now()) ON CONFLICT(library_id,project_id,search_id) DO UPDATE SET state=excluded.state,tags=excluded.tags,note=excluded.note,reason=excluded.reason,evidence=excluded.evidence,actor=excluded.actor,revision=excluded.revision,updated_at=now()",
            library,
            project,
            search,
            input.State,
            input.Tags,
            input.Note,
            input.Reason,
            evidence.ToJsonString(),
            actor.ToString(),
            revision + 1
        );
        await Exec(
            db,
            "INSERT INTO ld_review_events VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,now())",
            library,
            "REVIEW-" + Guid.NewGuid().ToString("N"),
            project,
            search,
            revision + 1,
            JsonSerializer.Serialize(input),
            actor.ToString()
        );
        await tx.CommitAsync();
        return revision + 1;
    }

    public async Task<object> ResearchRecord(Guid library, string search, int offset = 0)
    {
        if (offset < 0 || offset > 10000)
            throw new ArgumentException("Invalid research history offset.");
        await Article(library, search);
        await using var db = await Data.OpenConnectionAsync();
        await using var snapshot = await db.BeginTransactionAsync(
            System.Data.IsolationLevel.RepeatableRead
        );
        return new
        {
            counts = new
            {
                conversions = await Scalar(
                    db,
                    "SELECT count(*) FROM ld_conversions WHERE library_id=@p0 AND search_id=@p1",
                    library,
                    search
                ),
                derivations = await Scalar(
                    db,
                    "SELECT count(*) FROM ld_derivations WHERE library_id=@p0 AND search_id=@p1",
                    library,
                    search
                ),
                history = await Scalar(
                    db,
                    "SELECT count(*) FROM ld_review_events WHERE library_id=@p0 AND search_id=@p1",
                    library,
                    search
                ),
            },
            reviews = await Rows(
                db,
                "SELECT r.*,p.name FROM ld_reviews r JOIN ld_projects p USING(library_id,project_id) WHERE r.library_id=@p0 AND r.search_id=@p1 ORDER BY p.name LIMIT 1000",
                library,
                search
            ),
            derivations = await Rows(
                db,
                "SELECT * FROM ld_derivations WHERE library_id=@p0 AND search_id=@p1 ORDER BY created_at,derivation_id OFFSET @p2 LIMIT 100",
                library,
                search,
                offset
            ),
            conversions = await Rows(
                db,
                "SELECT conversion_id,input_hash,mode,state,reason,attempts,details,created_at FROM ld_conversions WHERE library_id=@p0 AND search_id=@p1 ORDER BY created_at DESC,conversion_id OFFSET @p2 LIMIT 100",
                library,
                search,
                offset
            ),
            history = await Rows(
                db,
                "SELECT * FROM ld_review_events WHERE library_id=@p0 AND search_id=@p1 ORDER BY created_at DESC,event_id OFFSET @p2 LIMIT 100",
                library,
                search,
                offset
            ),
        };
    }
}
