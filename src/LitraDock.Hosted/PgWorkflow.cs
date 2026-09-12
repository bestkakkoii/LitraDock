using System.Text.Json;
using LitraDock.Core;
using Npgsql;

namespace Literature.Service;

public sealed partial class PgStore
{
    public async Task<string> Search(Guid library, string query, int limit)
    {
        if (string.IsNullOrWhiteSpace(query) || query.Length > 2000 || limit is < 1 or > 10000)
            throw new ArgumentException("Search needs a query and limit 1–10000.");
        if (Demo != null && limit > DemoPolicy.SearchLimit)
            throw new ArgumentException("Demo searches support up to 100 results per run; refine the query for more focused results.");
        var run = "RUN-" + Guid.NewGuid().ToString("N");
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await DemoLibraryAdmission(db, library, "search");
        await DemoLibraryAdmission(db, library, "jobs");
        await Exec(
            db,
            "INSERT INTO ld_runs(library_id,run_id,input,requested_limit,state) VALUES(@p0,@p1,@p2,@p3,'queued')",
            library,
            run,
            query,
            limit
        );
        await Exec(
            db,
            "INSERT INTO ld_jobs(library_id,job_id,kind,run_id,state) VALUES(@p0,@p1,'search',@p2,'queued')",
            library,
            "JOB-" + Guid.NewGuid().ToString("N"),
            run
        );
        await tx.CommitAsync();
        return run;
    }

    public async Task<SearchSnapshot> SearchInput(Claim claim)
    {
        await using var db = await Data.OpenConnectionAsync();
        var row = (
            await Rows(
                db,
                "SELECT input,requested_limit FROM ld_runs WHERE library_id=@p0 AND run_id=@p1",
                claim.Library,
                claim.Run
            )
        ).Single();
        return new SearchSnapshot
        {
            RunId = claim.Run,
            Input = (string)row["input"],
            Limit = (int)row["requested_limit"],
        };
    }

    internal static async Task Fence(NpgsqlConnection db, Claim claim)
    {
        var found = await Scalar(
            db,
            "SELECT job_id FROM ld_jobs WHERE library_id=@p0 AND job_id=@p1 AND lease_token=@p2 AND lease_until>now() AND state='running' FOR UPDATE",
            claim.Library,
            claim.Job,
            claim.Lease
        );
        if (found == null)
            throw new OperationCanceledException("Worker lease is no longer active.");
    }

    public async Task SaveSearch(Claim claim, SearchSnapshot run)
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Fence(db, claim);
        await Exec(
            db,
            "SELECT pg_advisory_xact_lock(hashtextextended(@p0,0))",
            claim.Library.ToString()
        );
        foreach (var article in run.Articles)
        {
            var identifiers = new[]
            {
                ("pmid", article.Pmid),
                ("doi", Metadata.NormalizeDoi(article.Doi)),
                ("pmcid", article.Pmcid),
            }
                .Where(x => x.Item2.Length > 0)
                .ToArray();
            var matches = new HashSet<string>();
            foreach (var (kind, value) in identifiers)
            {
                var match =
                    await Scalar(
                        db,
                        "SELECT search_id FROM ld_identifiers WHERE library_id=@p0 AND kind=@p1 AND value=@p2",
                        claim.Library,
                        kind,
                        value
                    ) as string;
                if (match != null)
                    matches.Add(match);
            }
            if (matches.Count > 1)
                throw new SourceException(
                    "failed",
                    "Identifier conflict requires review; prior records preserved."
                );
            var id = matches.FirstOrDefault() ?? "LD-" + Guid.NewGuid().ToString("N");
            article.SearchId = id;
            if (
                (bool)
                    await Scalar(
                        db,
                        "SELECT EXISTS(SELECT 1 FROM ld_results WHERE library_id=@p0 AND run_id=@p1 AND search_id=@p2)",
                        claim.Library,
                        run.RunId,
                        id
                    )
            )
                continue;
            var old =
                await Scalar(
                    db,
                    "SELECT metadata FROM ld_records WHERE library_id=@p0 AND search_id=@p1 FOR UPDATE",
                    claim.Library,
                    id
                ) as string;
            if (old != null)
            {
                var previous = JsonSerializer.Deserialize<Article>(old);
                article.FullTextMetadataXml = previous.FullTextMetadataXml;
                article.RetrievalState = previous.RetrievalState;
                article.License = previous.License;
                article.ArticleNumber = previous.ArticleNumber;
                article.EqualContribution = previous.EqualContribution;
                if (article.Doi.Length == 0)
                    article.Doi = previous.Doi;
                if (article.Pmid.Length == 0)
                    article.Pmid = previous.Pmid;
                if (article.Pmcid.Length == 0)
                    article.Pmcid = previous.Pmcid;
            }
            await Exec(
                db,
                "INSERT INTO ld_records(library_id,search_id,metadata,title) VALUES(@p0,@p1,@p2,@p3) ON CONFLICT(library_id,search_id) DO UPDATE SET metadata=excluded.metadata,title=excluded.title",
                claim.Library,
                id,
                JsonSerializer.Serialize(article),
                article.Title
            );
            foreach (var (kind, value) in identifiers)
                await Exec(
                    db,
                    "INSERT INTO ld_identifiers VALUES(@p0,@p1,@p2,@p3) ON CONFLICT(library_id,kind,value) DO NOTHING",
                    claim.Library,
                    kind,
                    value,
                    id
                );
            await Exec(
                db,
                "INSERT INTO ld_results VALUES(@p0,@p1,@p2,@p3)",
                claim.Library,
                run.RunId,
                id,
                run.SourceIds.IndexOf(article.Pmid) + 1
            );
            await Event(
                db,
                claim.Library,
                claim.Job,
                "metadata_saved",
                JsonSerializer.Serialize(article)
            );
        }
        await Exec(
            db,
            "UPDATE ld_runs SET total=@p2,fetched=(SELECT count(*) FROM ld_results WHERE library_id=@p0 AND run_id=@p1),state=@p3,reason=@p4,snapshot=@p5 WHERE library_id=@p0 AND run_id=@p1",
            claim.Library,
            run.RunId,
            run.Total,
            run.State,
            run.Reason,
            JsonSerializer.Serialize(
                new
                {
                    run.SubmittedQuery,
                    run.Translation,
                    run.StartedAt,
                    run.SourceIds,
                }
            )
        );
        await tx.CommitAsync();
    }

    public async Task<string> Scope(Guid library, string run, string parent, string text)
    {
        if ((text ?? "").Length > 200)
            throw new ArgumentException("Refinement limit is 200 characters.");
        var id = "SCOPE-" + Guid.NewGuid().ToString("N");
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await DemoLibraryAdmission(db, library, "scope");
        if (parent != null)
            run =
                await Scalar(
                    db,
                    "SELECT run_id FROM ld_scopes WHERE library_id=@p0 AND scope_id=@p1",
                    library,
                    parent
                ) as string;
        await Exec(
            db,
            "INSERT INTO ld_scopes VALUES(@p0,@p1,@p2,@p3,@p4)",
            library,
            id,
            run,
            parent,
            text ?? ""
        );
        var from =
            parent != null
                ? "ld_members m JOIN ld_records r USING(library_id,search_id) WHERE m.library_id=@p0 AND m.scope_id=@p2"
            : run != null
                ? "ld_results m JOIN ld_records r USING(library_id,search_id) WHERE m.library_id=@p0 AND m.run_id=@p2"
            : "ld_records r WHERE r.library_id=@p0 AND @p2::text IS NULL";
        var rank = parent != null || run != null ? "m.rank" : "r.ordinal";
        await Exec(
            db,
            "INSERT INTO ld_members(library_id,scope_id,search_id,rank) SELECT @p0,@p1,r.search_id,"
                + rank
                + " FROM "
                + from
                + " AND (@p3='' OR strpos(lower(r.title),lower(@p3))>0 OR EXISTS(SELECT 1 FROM ld_identifiers i WHERE i.library_id=r.library_id AND i.search_id=r.search_id AND strpos(lower(i.value),lower(@p3))>0))",
            library,
            id,
            parent ?? run,
            text ?? ""
        );
        await tx.CommitAsync();
        return id;
    }

    public async Task<object> Page(Guid library, string scope, int offset)
    {
        if (offset < 0 || offset > 1000000)
            throw new ArgumentException("Invalid page offset.");
        await using var db = await Data.OpenConnectionAsync();
        var rows = await Rows(
            db,
            "SELECT r.metadata,m.selected FROM ld_members m JOIN ld_records r USING(library_id,search_id) WHERE m.library_id=@p0 AND m.scope_id=@p1 ORDER BY m.rank,r.search_id LIMIT 50 OFFSET @p2",
            library,
            scope,
            offset
        );
        return new
        {
            total = await Scalar(
                db,
                "SELECT count(*) FROM ld_members WHERE library_id=@p0 AND scope_id=@p1",
                library,
                scope
            ),
            selected = await Scalar(
                db,
                "SELECT count(*) FROM ld_members WHERE library_id=@p0 AND scope_id=@p1 AND selected",
                library,
                scope
            ),
            records = rows.Select(r => new
            {
                article = JsonSerializer.Deserialize<Article>((string)r["metadata"]),
                selected = (bool)r["selected"],
            }),
        };
    }

    public async Task Select(Guid library, string scope, string id, bool selected)
    {
        await using var db = await Data.OpenConnectionAsync();
        await Exec(
            db,
            "UPDATE ld_members SET selected=@p2 WHERE library_id=@p0 AND scope_id=@p1 AND (@p3::text IS NULL OR search_id=@p3)",
            library,
            scope,
            selected,
            id
        );
    }

    public async Task<string> Batch(Guid library, string scope, bool selected, string template)
    {
        Naming.ValidateTemplate(template);
        var batch = "BATCH-" + Guid.NewGuid().ToString("N");
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(
            db,
            "INSERT INTO ld_batches VALUES(@p0,@p1,@p2,'queued',@p3)",
            library,
            batch,
            scope,
            template
        );
        // 先具體化選取集合；配額與新增項目共用此快照，並行選取只影響下一批。
        var rows = await Rows(
            db,
            "SELECT r.metadata,m.rank FROM ld_members m JOIN ld_records r USING(library_id,search_id) WHERE m.library_id=@p0 AND m.scope_id=@p1 AND (NOT @p2 OR selected) ORDER BY m.rank",
            library,
            scope,
            selected
        );
        var count = rows.Count;
        if (count is < 1 or > 10000)
            throw new ArgumentException("Choose 1–10000 records; no silent truncation.");
        if (Demo != null && count > DemoPolicy.BatchLimit)
            throw new ArgumentException("Demo batches support up to 10 records; select a smaller batch. No records were queued.");
        await DemoLibraryAdmission(db, library, "jobs", count);
        var index = 0;
        foreach (var row in rows)
        {
            var article = JsonSerializer.Deserialize<Article>((string)row["metadata"]);
            var item = "ITEM-" + Guid.NewGuid().ToString("N");
            var job = "JOB-" + Guid.NewGuid().ToString("N");
            await Exec(
                db,
                "INSERT INTO ld_items VALUES(@p0,@p1,@p2,@p3,@p4,'queued',0,@p5,'',@p6)",
                library,
                item,
                batch,
                article.SearchId,
                ++index,
                job,
                Naming.Preview(article, template)
            );
            await Exec(
                db,
                "INSERT INTO ld_jobs(library_id,job_id,kind,item_id,search_id,state) VALUES(@p0,@p1,'acquire',@p2,@p3,'queued')",
                library,
                job,
                item,
                article.SearchId
            );
        }
        await tx.CommitAsync();
        return batch;
    }

    public async Task<object> BatchStatus(Guid library, string batch, int offset)
    {
        if (offset < 0 || offset > 10000)
            throw new ArgumentException("Invalid item offset.");
        await using var db = await Data.OpenConnectionAsync();
        return new
        {
            state = await Scalar(
                db,
                "SELECT state FROM ld_batches WHERE library_id=@p0 AND batch_id=@p1",
                library,
                batch
            ),
            counts = await Rows(
                db,
                "SELECT state,count(*) AS count FROM ld_items WHERE library_id=@p0 AND batch_id=@p1 GROUP BY state ORDER BY state",
                library,
                batch
            ),
            items = await Rows(
                db,
                "SELECT * FROM ld_items WHERE library_id=@p0 AND batch_id=@p1 ORDER BY rank LIMIT 100 OFFSET @p2",
                library,
                batch,
                offset
            ),
        };
    }

    internal static Task<int> Event(
        NpgsqlConnection db,
        Guid library,
        string job,
        string state,
        string reason
    ) =>
        Exec(
            db,
            "INSERT INTO ld_events VALUES(@p0,@p1,@p2,@p3,@p4,@p5)",
            library,
            "EVENT-" + Guid.NewGuid().ToString("N"),
            job,
            state,
            reason,
            DateTime.UtcNow.ToString("o")
        );
}
