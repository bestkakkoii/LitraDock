using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using Literature.Service;
using LitraDock.Core;
using Npgsql;

public static class BundleAttackChecks
{
    private static void Rewrite(string input, string output, string attack)
    {
        File.Copy(input, output, true);
        using var zip = ZipFile.Open(output, ZipArchiveMode.Update);
        JsonObject Read(string path)
        {
            using var text = new StreamReader(zip.GetEntry(path).Open());
            return JsonNode.Parse(text.ReadToEnd()).AsObject();
        }
        void Put(string path, byte[] bytes)
        {
            zip.GetEntry(path)?.Delete();
            using var stream = zip.CreateEntry(path, CompressionLevel.NoCompression).Open();
            stream.Write(bytes);
        }
        var metadata = Read("metadata.json");
        var manifest = Read("manifest.json");
        if (attack == "compression-bomb")
        {
            var expandedMetadata = Encoding.UTF8.GetBytes(
                metadata.ToJsonString() + new string(' ', 2 * 1024 * 1024)
            );
            manifest["MetadataHash"] = Artifacts.Hash(expandedMetadata);
            zip.GetEntry("metadata.json").Delete();
            using (
                var stream = zip.CreateEntry("metadata.json", CompressionLevel.SmallestSize).Open()
            )
                stream.Write(expandedMetadata);
            Put("manifest.json", Encoding.UTF8.GetBytes(manifest.ToJsonString()));
            return;
        }
        if (attack == "symlink")
        {
            zip.GetEntry("metadata.json").ExternalAttributes = unchecked((int)0xA1FF0000);
            return;
        }
        if (attack == "duplicate-json")
        {
            Put(
                "manifest.json",
                Encoding.UTF8.GetBytes(manifest.ToJsonString().Insert(1, "\"Format\":1,"))
            );
            return;
        }
        if (attack == "ordinal")
            metadata["ld_records"][0]["ordinal"] = long.MaxValue;
        else if (attack == "identifier-index")
            metadata["ld_identifiers"].AsArray().First(x => x["kind"].GetValue<string>() == "pmid")[
                "value"
            ] = "88888888";
        else if (attack == "missing-current-job")
            metadata["ld_items"][0]["last_job_id"] = "JOB-missing";
        else if (attack == "cross-record-job")
        {
            var jobId = metadata["ld_items"][0]["last_job_id"].GetValue<string>();
            var job = metadata["ld_jobs"]
                .AsArray()
                .Single(x => x["job_id"].GetValue<string>() == jobId);
            job["search_id"] = metadata["ld_records"]
                .AsArray()
                .First(x =>
                    x["search_id"].GetValue<string>() != job["search_id"].GetValue<string>()
                )["search_id"]
                .GetValue<string>();
        }
        else if (attack == "false-completion")
        {
            foreach (
                var table in new[]
                {
                    "ld_files",
                    "ld_article_files",
                    "ld_object_provenance",
                    "ld_publications",
                    "ld_manual_inputs",
                }
            )
            {
                metadata[table] = new JsonArray();
                manifest["Counts"][table] = 0;
            }
            foreach (
                var entry in zip
                    .Entries.Where(x =>
                        x.FullName.StartsWith("objects/") || x.FullName.StartsWith("staging/")
                    )
                    .ToArray()
            )
                entry.Delete();
            manifest["Files"] = new JsonArray();
        }
        else if (attack == "account-field")
            metadata["ld_records"][0]["owner_id"] = Guid.NewGuid().ToString();
        else
        {
            var file = manifest["Files"]
                .AsArray()
                .First(x => x["Path"].GetValue<string>().StartsWith("objects/"));
            var name = file["Path"].GetValue<string>();
            byte[] bytes;
            using (var stream = zip.GetEntry(name).Open())
            {
                using var memory = new MemoryStream();
                stream.CopyTo(memory);
                bytes = memory.ToArray();
            }
            var hash = file["Hash"].GetValue<string>();
            if (attack == "hash-binding")
            {
                bytes = Encoding.UTF8.GetBytes(
                    Encoding
                        .UTF8.GetString(bytes)
                        .Replace("</body>", "<p>Second valid byte variant</p></body>")
                );
                Put(name, bytes);
                file["Hash"] = Artifacts.Hash(bytes);
                file["Bytes"] = bytes.Length;
                metadata["ld_files"].AsArray().Single(x => x["hash"].GetValue<string>() == hash)[
                    "bytes"
                ] = bytes.Length;
            }
            else if (attack == "kind-binding")
            {
                zip.GetEntry(name).Delete();
                var renamed = Path.ChangeExtension(name, ".pdf");
                Put(renamed, bytes);
                file["Path"] = renamed;
                metadata["ld_files"].AsArray().Single(x => x["hash"].GetValue<string>() == hash)[
                    "kind"
                ] = OriginalValidation.PdfKind;
            }
        }
        var raw = Encoding.UTF8.GetBytes(metadata.ToJsonString());
        manifest["MetadataHash"] = Artifacts.Hash(raw);
        Put("metadata.json", raw);
        Put("manifest.json", Encoding.UTF8.GetBytes(manifest.ToJsonString()));
    }

    public static async Task Run(
        PgStore store,
        string connection,
        string output,
        Guid owner,
        string archive,
        OriginalStore originals,
        Action<bool, string> check
    )
    {
        await using var db = new NpgsqlConnection(connection);
        await db.OpenAsync();
        async Task<long> Number(string sql)
        {
            await using var c = new NpgsqlCommand(sql, db);
            return Convert.ToInt64(await c.ExecuteScalarAsync());
        }
        var libraries = await Number("SELECT count(*) FROM ld_libraries");
        foreach (
            var attack in new[]
            {
                "hash-binding",
                "kind-binding",
                "account-field",
                "identifier-index",
                "compression-bomb",
                "symlink",
                "duplicate-json",
                "missing-current-job",
                "cross-record-job",
                "false-completion",
            }
        )
        {
            var path = Path.Combine(output, "attack-" + attack + ".zip");
            Rewrite(archive, path, attack);
            bool rejected = false;
            try
            {
                await store.ImportBundle(owner, path, originals);
            }
            catch (IOException error)
            {
                rejected = attack switch
                {
                    "compression-bomb" => error.Message.Contains("compression ratio"),
                    "symlink" => error.Message.Contains("symbolic links"),
                    "duplicate-json" => error.Message.Contains("Duplicate JSON"),
                    _ => true,
                };
            }
            check(
                rejected && await Number("SELECT count(*) FROM ld_libraries") == libraries,
                "Atomic rejection of coherently rehashed bundle attack: " + attack
            );
        }
        var hostile = Path.Combine(output, "attack-ordinal.zip");
        Rewrite(archive, hostile, "ordinal");
        var restored = await store.ImportBundle(owner, hostile, originals);
        check(
            await Number("SELECT last_value FROM ld_records_ordinal_seq") < 1000000,
            "Imported bigint-max ordinal cannot control shared allocator"
        );
        await using var beforeCommand = new NpgsqlCommand(
            "SELECT metadata FROM ld_records WHERE library_id=@p0 ORDER BY ordinal LIMIT 1",
            db
        );
        beforeCommand.Parameters.AddWithValue("p0", restored);
        var beforeMetadata = (string)await beforeCommand.ExecuteScalarAsync();
        var beforeArticle = System.Text.Json.JsonSerializer.Deserialize<Article>(beforeMetadata);
        var beforeFiles = (await store.Files(restored, beforeArticle.SearchId)).Count;
        await store.Search(restored, "Unrelated identity after restore", 1);
        var unrelatedClaim = await store.ClaimNext();
        var unrelated = await store.SearchInput(unrelatedClaim);
        unrelated.Total = 1;
        unrelated.State = "complete";
        unrelated.SourceIds.Add("88888888");
        unrelated.Articles.Add(
            new Article { Pmid = "88888888", Title = "Independent new synthetic paper" }
        );
        await store.SaveSearch(unrelatedClaim, unrelated);
        await store.Finish(unrelatedClaim, "completed", "Synthetic identity regression");
        check(
            (string)await beforeCommand.ExecuteScalarAsync() == beforeMetadata
                && (await store.Files(restored, beforeArticle.SearchId)).Count == beforeFiles,
            "Unrelated search in restored library cannot overwrite earlier canonical metadata or originals"
        );
        bool interrupted = false;
        try
        {
            await store.ImportBundle(
                owner,
                hostile,
                originals,
                phase =>
                {
                    if (phase == "validated")
                        throw new IOException("Controlled failure after validation");
                }
            );
        }
        catch (IOException)
        {
            interrupted = true;
        }
        check(
            interrupted && await Number("SELECT last_value FROM ld_records_ordinal_seq") < 1000000,
            "Failed-after-validation import cannot exhaust shared allocator; gaps are harmless"
        );
        var another = await store.CreateAccount(
            "ordinal-tenant-" + Guid.NewGuid().ToString("N"),
            "Synthetic-ordinal-password-2026"
        );
        var library = await store.CreateLibrary(another, "Independent tenant after hostile import");
        var run = await store.Search(library, "Synthetic unaffected allocation", 120);
        var worker = new HostedWorker(store, originals, new FixtureSource());
        await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
        check(
            System
                .Text.Json.JsonSerializer.SerializeToElement(await store.Catalog(library, 0))
                .GetProperty("runs")[0]
                .GetProperty("fetched")
                .GetInt32() == 120,
            "Another tenant can create120 records after hostile ordinal and rollback"
        );
    }
}
