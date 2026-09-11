using System.Text.Json;
using Microsoft.Data.Sqlite;
using Npgsql;

namespace Literature.Verification;

public static class MigrationAudit
{
    public static async Task<int> Compare(string connection, string database, Guid library)
    {
        var expected = new Dictionary<string, string>();
        await using (
            var source = new SqliteConnection(
                new SqliteConnectionStringBuilder
                {
                    DataSource = database,
                    Mode = SqliteOpenMode.ReadOnly,
                    Pooling = false,
                }.ConnectionString
            )
        )
        {
            await source.OpenAsync();
            await using var tx = source.BeginTransaction(deferred: true);
            foreach (
                var table in new[]
                {
                    "articles",
                    "identifiers",
                    "revisions",
                    "search_runs",
                    "search_results",
                    "files",
                    "article_files",
                    "jobs",
                    "activity",
                    "saved_scopes",
                    "scope_members",
                    "batches",
                    "batch_items",
                    "publication_intents",
                    "artifact_names",
                }
            )
            {
                using var cmd = source.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = "SELECT * FROM " + table + " ORDER BY rowid";
                using var reader = cmd.ExecuteReader();
                var number = 0;
                while (reader.Read())
                    expected.Add(
                        table + ":" + (++number),
                        JsonSerializer.Serialize(
                            Enumerable
                                .Range(0, reader.FieldCount)
                                .ToDictionary(
                                    reader.GetName,
                                    i => reader.IsDBNull(i) ? null : reader.GetValue(i)
                                )
                        )
                    );
            }
        }
        await using var target = new NpgsqlConnection(connection);
        await target.OpenAsync();
        await using var query = new NpgsqlCommand(
            "SELECT table_name,row_number,data FROM ld_legacy_rows WHERE library_id=$1",
            target
        );
        query.Parameters.AddWithValue(library);
        await using var rows = await query.ExecuteReaderAsync();
        var actual = new Dictionary<string, string>();
        while (await rows.ReadAsync())
            actual.Add(rows.GetString(0) + ":" + rows.GetInt64(1), rows.GetString(2));
        if (
            actual.Count != expected.Count
            || expected.Any(row =>
                !actual.TryGetValue(row.Key, out var value) || value != row.Value
            )
        )
            throw new Exception("Copied SQLite raw row/identifier/provenance parity failed.");
        return actual.Count;
    }
}
