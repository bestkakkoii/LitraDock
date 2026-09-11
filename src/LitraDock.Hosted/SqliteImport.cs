using System.Text.Json;
using LitraDock.Core;
using Microsoft.Data.Sqlite;

namespace Literature.Service;

public sealed partial class PgStore
{
    // 僅接受已停止並複製的文庫；新文庫直到資料、關聯與檔案驗證完成才一起提交。
    // 失敗留下新的獨立物件目錄供檢查，從不修改來源或覆寫已存在文庫。
    public async Task<Guid> ImportStoppedCopy(
        Guid owner,
        string name,
        string copiedRoot,
        OriginalStore originals,
        Action<string> snapshotCheckpoint = null
    )
    {
        var copyRoot = Path.GetFullPath(copiedRoot);
        var database = Path.Combine(copyRoot, "library.sqlite3");
        if (!File.Exists(database))
            throw new IOException(
                "Existing stopped SQLite copy is required; no source is created."
            );
        var library = Guid.NewGuid();
        using var hostLease = new FileStream(
            Path.Combine(copyRoot, "web-host.lock"),
            FileMode.OpenOrCreate,
            FileAccess.ReadWrite,
            FileShare.None
        );
        using var batchLease = new FileStream(
            Path.Combine(copyRoot, "batch.lock"),
            FileMode.OpenOrCreate,
            FileAccess.ReadWrite,
            FileShare.None
        );
        await using var sqlite = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = database,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ConnectionString
        );
        await sqlite.OpenAsync();
        await using var readTx = sqlite.BeginTransaction(deferred: true);
        using (var version = sqlite.CreateCommand())
        {
            version.Transaction = readTx;
            version.CommandText = "PRAGMA user_version";
            if (Convert.ToInt32(version.ExecuteScalar()) != 2)
                throw new InvalidOperationException(
                    "Import requires schema2; upgrade a separate copy using the preserved baseline first."
                );
        }
        var tables = new Dictionary<string, List<Dictionary<string, object>>>();
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
            using var cmd = sqlite.CreateCommand();
            cmd.Transaction = readTx;
            cmd.CommandText = "SELECT * FROM " + table + " ORDER BY rowid LIMIT 100001";
            using var reader = cmd.ExecuteReader();
            var rows = new List<Dictionary<string, object>>();
            while (reader.Read())
                rows.Add(
                    Enumerable
                        .Range(0, reader.FieldCount)
                        .ToDictionary(
                            reader.GetName,
                            i => reader.IsDBNull(i) ? null : reader.GetValue(i)
                        )
                );
            if (rows.Count > 100000)
                throw new ArgumentException(
                    "Import history limit exceeded; no truncation permitted."
                );
            tables[table] = rows;
            snapshotCheckpoint?.Invoke(table);
        }
        if (tables["articles"].Count > 10000)
            throw new ArgumentException("Import limit is 10000 records; source remains unchanged.");
        var serializer = new System.Xml.Serialization.XmlSerializer(typeof(Article));
        var articles = tables["articles"]
            .Select(row =>
            {
                using var reader = Metadata
                    .ParseXml(System.Text.Encoding.UTF8.GetBytes((string)row["metadata_xml"]))
                    .CreateReader();
                return (Article)serializer.Deserialize(reader);
            })
            .ToArray();
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "INSERT INTO ld_libraries VALUES(@p0,@p1,@p2,false)", library, owner, name);
        foreach (var (table, rows) in tables)
        {
            var index = 0;
            foreach (var row in rows)
                await Exec(
                    db,
                    "INSERT INTO ld_legacy_rows VALUES(@p0,@p1,@p2,@p3)",
                    library,
                    table,
                    (long)++index,
                    JsonSerializer.Serialize(row)
                );
        }
        foreach (var article in articles)
            await Exec(
                db,
                "INSERT INTO ld_records(library_id,search_id,metadata,title) VALUES(@p0,@p1,@p2,@p3)",
                library,
                article.SearchId,
                JsonSerializer.Serialize(article),
                article.Title
            );
        foreach (var r in tables["identifiers"])
            await Exec(
                db,
                "INSERT INTO ld_identifiers VALUES(@p0,@p1,@p2,@p3)",
                library,
                r["kind"],
                r["value"],
                r["search_id"]
            );
        foreach (var r in tables["search_runs"])
            await Exec(
                db,
                "INSERT INTO ld_runs VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8)",
                library,
                r["run_id"],
                r["input"],
                Convert.ToInt32(r["total"]),
                Convert.ToInt32(r["fetched"]),
                Convert.ToInt32(r["requested_limit"]),
                SafeState((string)r["state"]),
                r["reason"],
                JsonSerializer.Serialize(r)
            );
        foreach (var r in tables["search_results"])
            await Exec(
                db,
                "INSERT INTO ld_results VALUES(@p0,@p1,@p2,@p3)",
                library,
                r["run_id"],
                r["search_id"],
                Convert.ToInt32(r["source_rank"])
            );
        foreach (var r in tables["saved_scopes"])
            await Exec(
                db,
                "INSERT INTO ld_scopes VALUES(@p0,@p1,@p2,@p3,@p4)",
                library,
                r["scope_id"],
                r["source_run"],
                r["parent_scope"],
                r["description"]
            );
        foreach (var r in tables["scope_members"])
            await Exec(
                db,
                "INSERT INTO ld_members VALUES(@p0,@p1,@p2,@p3,@p4)",
                library,
                r["scope_id"],
                r["search_id"],
                r["rank"],
                Convert.ToInt32(r["selected"]) == 1
            );
        foreach (var r in tables["batches"])
            await Exec(
                db,
                "INSERT INTO ld_batches VALUES(@p0,@p1,@p2,@p3,@p4)",
                library,
                r["batch_id"],
                r["scope_id"],
                SafeState((string)r["state"]),
                r["naming_template"]
            );
        foreach (var r in tables["batch_items"])
            await Exec(
                db,
                "INSERT INTO ld_items VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,@p9)",
                library,
                r["item_id"],
                r["batch_id"],
                r["search_id"],
                Convert.ToInt32(r["ordinal"]),
                SafeState((string)r["state"]),
                Convert.ToInt32(r["attempts"]),
                r["last_job_id"],
                r["reason"],
                r["planned_name"]
            );
        foreach (var r in tables["jobs"])
        {
            var item = tables["batch_items"]
                .FirstOrDefault(i => Equals(i["last_job_id"], r["job_id"]));
            await Exec(
                db,
                "INSERT INTO ld_jobs(library_id,job_id,kind,item_id,search_id,state,reason) VALUES(@p0,@p1,'acquire',@p2,@p3,@p4,@p5)",
                library,
                r["job_id"],
                item?["item_id"],
                r["search_id"],
                SafeState((string)r["state"]),
                r["reason"]
            );
        }
        foreach (var r in tables["batch_items"].Where(r => (string)r["state"] == "queued"))
        {
            // 舊版尚未嘗試的排隊項目沒有 Job；匯入後保持暫停，明確 Resume 才建立新嘗試。
            await Exec(
                db,
                "UPDATE ld_items SET state='paused',reason='Imported queue; explicit continuation required.' WHERE library_id=@p0 AND item_id=@p1",
                library,
                r["item_id"]
            );
            await Exec(
                db,
                "UPDATE ld_batches SET state='paused' WHERE library_id=@p0 AND batch_id=@p1",
                library,
                r["batch_id"]
            );
        }
        foreach (var r in tables["activity"])
            await Exec(
                db,
                "INSERT INTO ld_events VALUES(@p0,@p1,@p2,@p3,@p4,@p5)",
                library,
                Convert.ToString(r["event_id"]),
                r["job_id"],
                r["state"],
                r["reason"],
                r["occurred_at"]
            );
        foreach (var r in tables["files"])
        {
            var hash = (string)r["hash"];
            var path = Path.GetFullPath(Path.Combine(copyRoot, (string)r["relative_path"]));
            if (
                !path.StartsWith(
                    Path.TrimEndingDirectorySeparator(copyRoot) + Path.DirectorySeparatorChar,
                    OperatingSystem.IsWindows()
                        ? StringComparison.OrdinalIgnoreCase
                        : StringComparison.Ordinal
                )
            )
                throw new IOException("Imported original path escapes the stopped copy.");
            var target = originals.ObjectPath(library, hash);
            if (
                path == null
                || !File.Exists(path)
                || Artifacts.Hash(Artifacts.ReadBoundedFile(path)) != hash
            )
                throw new IOException(
                    "Import original missing/corrupt; source preserved and target not activated."
                );
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            File.Copy(path, target, false);
            originals.Read(library, hash);
            await Exec(
                db,
                "INSERT INTO ld_files VALUES(@p0,@p1,@p2,@p3,@p4)",
                library,
                hash,
                r["bytes"],
                r["kind"],
                r["validation"]
            );
        }
        foreach (var r in tables["article_files"])
            await Exec(
                db,
                "INSERT INTO ld_article_files VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6)",
                library,
                r["search_id"],
                r["hash"],
                r["acquired_at"],
                r["source_uri"],
                r["final_uri"],
                r["license"]
            );
        await Event(
            db,
            library,
            null,
            "imported",
            "Stopped SQLite copy imported; original rows retained; interrupted/queued work requires explicit continuation."
        );
        await Exec(db, "UPDATE ld_libraries SET ready=true WHERE library_id=@p0", library);
        await tx.CommitAsync();
        return library;
    }

    private static string SafeState(string state) =>
        state
            is "running"
                or "searching"
                or "resolving"
                or "downloading"
                or "validating"
                or "publishing"
                or "waiting"
                or "redirecting"
            ? "paused"
            : state;
}
