using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Literature.Service;
using LitraDock.Core;
using Npgsql;

public static class ResearchBundleChecks
{
    private static string Rewrite(string input, string output, string attack)
    {
        File.Copy(input, output);
        using var zip = ZipFile.Open(output, ZipArchiveMode.Update);
        JsonObject Read(string path)
        {
            using var reader = new StreamReader(zip.GetEntry(path).Open());
            return JsonNode.Parse(reader.ReadToEnd()).AsObject();
        }
        void Put(string path, byte[] bytes)
        {
            zip.GetEntry(path)?.Delete();
            using var stream = zip.CreateEntry(path, CompressionLevel.NoCompression).Open();
            stream.Write(bytes);
        }
        var tables = Read("metadata.json");
        var manifest = Read("manifest.json");
        var conversion = tables["ld_conversions"]
            .AsArray()
            .Single(x => x["state"].ToString() == "completed");
        if (attack.StartsWith("prepared"))
        {
            var hash = conversion["output_hash"].ToString();
            tables["ld_derivations"].AsArray().Clear();
            var files = tables["ld_files"].AsArray();
            files.Remove(files.Single(x => x["hash"].ToString() == hash));
            conversion["state"] = "paused";
            conversion["output_hash"] = null;
            var details = JsonNode.Parse(conversion["details"].ToString());
            if (attack == "prepared-bytes")
            {
                var bytes = Encoding.UTF8.GetBytes(
                    "Executable-looking arbitrary content is not a reading PDF."
                );
                var badHash = Artifacts.Hash(bytes);
                var file = manifest["Files"].AsArray().Single(x => x["Hash"].ToString() == hash);
                zip.GetEntry(file["Path"].ToString()).Delete();
                file["Path"] = "objects/" + badHash + ".pdf";
                file["Hash"] = badHash;
                file["Bytes"] = bytes.Length;
                Put(file["Path"].ToString(), bytes);
                details["hash"] = badHash;
            }
            if (attack == "prepared-input")
                details["inputHash"] = new string('0', 64);
            if (attack == "prepared-kind")
                details["kind"] = "Original PDF";
            if (attack == "prepared-stage")
                details["stage"] = "../../outside";
            if (attack == "prepared-extra")
                details["executable"] = "/bin/sh";
            conversion["details"] = details.ToJsonString();
        }
        if (attack == "review-event")
            tables["ld_reviews"][0]["note"] = "Altered current note without event";
        if (attack == "citation-id")
        {
            var citation = tables["ld_citations"][0];
            var data = JsonNode.Parse(citation["data"].ToString());
            data["item"]["id"] = "LD-unrelated";
            citation["data"] = data.ToJsonString();
        }
        var metadata = Encoding.UTF8.GetBytes(tables.ToJsonString());
        manifest["MetadataHash"] = Artifacts.Hash(metadata);
        foreach (var table in tables)
            manifest["Counts"][table.Key] = table.Value.AsArray().Count;
        Put("metadata.json", metadata);
        Put("manifest.json", Encoding.UTF8.GetBytes(manifest.ToJsonString()));
        return output;
    }

    public static async Task Run(
        PgStore store,
        string connection,
        Guid owner,
        string bundle,
        OriginalStore files,
        string output,
        Action<bool, string> check
    )
    {
        await using var db = new NpgsqlConnection(connection);
        await db.OpenAsync();
        async Task<long> Libraries()
        {
            await using var q = new NpgsqlCommand("SELECT count(*) FROM ld_libraries", db);
            return (long)await q.ExecuteScalarAsync();
        }
        var before = await Libraries();
        foreach (
            var attack in new[]
            {
                "prepared-bytes",
                "prepared-input",
                "prepared-kind",
                "prepared-stage",
                "prepared-extra",
                "review-event",
                "citation-id",
            }
        )
        {
            var path = Rewrite(bundle, Path.Combine(output, attack + ".zip"), attack);
            var rejected = false;
            try
            {
                await store.ImportBundle(owner, path, files);
            }
            catch
            {
                rejected = true;
            }
            check(
                rejected && await Libraries() == before,
                "Actual PG malicious research bundle rolls back: " + attack
            );
        }
        var valid = Rewrite(bundle, Path.Combine(output, "prepared-valid.zip"), "prepared-valid");
        var library = await store.ImportBundle(owner, valid, files);
        await using var query = new NpgsqlCommand(
            "SELECT conversion_id,details FROM ld_conversions WHERE library_id=@l",
            db
        );
        query.Parameters.AddWithValue("l", library);
        string conversion,
            hash;
        await using (var reader = await query.ExecuteReaderAsync())
        {
            await reader.ReadAsync();
            conversion = reader.GetString(0);
            hash = JsonNode.Parse(reader.GetString(1))["hash"].ToString();
        }
        check(
            await store.ClaimConversion() == null,
            "Valid imported prepared output remains paused before explicit resume"
        );
        var bytes = files.Read(library, hash);
        await store.ControlConversion(library, conversion, "resume", owner);
        var claim = await store.ClaimConversion();
        await new ReadingWorker(store, files).Execute(claim, CancellationToken.None);
        await using var status = new NpgsqlCommand(
            "SELECT state FROM ld_conversions WHERE library_id=@l AND conversion_id=@c",
            db
        );
        status.Parameters.AddWithValue("l", library);
        status.Parameters.AddWithValue("c", conversion);
        check(
            (string)await status.ExecuteScalarAsync() == "completed"
                && files.Read(library, hash).SequenceEqual(bytes),
            "Valid interrupted reading output resumes after relocated import with exact bytes and fresh association"
        );
    }
}
