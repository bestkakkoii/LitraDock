using Literature.Service;
using LitraDock.Core;
using Npgsql;

public static class UpgradeChecks
{
    public static async Task Run(string connection, Action<bool, string> check)
    {
        await using var db = new NpgsqlConnection(connection);
        await db.OpenAsync();
        async Task<object> Sql(string sql)
        {
            await using var c = new NpgsqlCommand(sql, db);
            return await c.ExecuteScalarAsync();
        }
        if (await Sql("SELECT to_regclass('public.ld_schema')::text") is not DBNull and not null)
            throw new InvalidOperationException(
                "Migration regression requires a fresh ephemeral database."
            );
        using var original = typeof(PgStore).Assembly.GetManifestResourceStream(
            "LitraDock.Hosted.migrations.001.sql"
        );
        using var reader = new StreamReader(original);
        await Sql(await reader.ReadToEndAsync());
        await using var store = new PgStore(connection);
        var owner = await store.CreateAccount("upgrade-fixture", "Synthetic-upgrade-password-2026");
        var library = await store.CreateLibrary(owner, "Upgrade 多語文庫");
        var run = await store.Search(library, "Schema1 identity fixture", 120);
        var claim = await store.ClaimNext();
        var snapshot = await store.SearchInput(claim);
        await new FixtureSource().SearchAsync(snapshot, CancellationToken.None);
        await store.SaveSearch(claim, snapshot);
        await store.Finish(claim, "completed", "Synthetic schema1 baseline");
        var scope = await store.Scope(library, run, null, "");
        var batch = await store.Batch(library, scope, false, Naming.DefaultTemplate);
        await Sql(
            "UPDATE ld_jobs SET state='paused'; UPDATE ld_items SET state='paused'; UPDATE ld_batches SET state='paused'"
        );
        await using var tablesCommand = new NpgsqlCommand(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'ld_%' ORDER BY tablename",
            db
        );
        var tables = new List<string>();
        await using (var rows = await tablesCommand.ExecuteReaderAsync())
            while (await rows.ReadAsync())
                tables.Add(rows.GetString(0));
        var before = new Dictionary<string, string>();
        foreach (var table in tables)
            before[table] = (string)
                await Sql(
                    "SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(t) x FROM "
                        + table
                        + " t) q"
                );
        await store.Migrate();
        foreach (var table in tables.Where(t => t != "ld_schema"))
            check(
                before[table]
                    == (string)
                        await Sql(
                            "SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(t) x FROM "
                                + table
                                + " t) q"
                        ),
                "Populated PostgreSQL v1-to-v3 preserves exact rows: " + table
            );
        check(
            Convert.ToInt32(await Sql("SELECT max(version) FROM ld_schema")) == 3,
            "Populated hosted migration completes schema3 without altering paused identity graph"
        );
    }
}
