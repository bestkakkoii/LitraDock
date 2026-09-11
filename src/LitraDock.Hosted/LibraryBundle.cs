using System.Data;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using LitraDock.Core;

namespace Literature.Service;

public sealed record BundleFile(string Path, string Hash, long Bytes, string State);

public sealed record BundleManifest(
    int Format,
    int Schema,
    Guid OriginLibrary,
    string Coverage,
    string MetadataHash,
    Dictionary<string, int> Counts,
    List<BundleFile> Files,
    string Notice
);

public sealed partial class PgStore
{
    public const long BundleLimit = 256L * 1024 * 1024;
    public const int MetadataLimit = 32 * 1024 * 1024;
    internal static readonly string[] BundleTables =
    [
        "ld_records",
        "ld_identifiers",
        "ld_runs",
        "ld_results",
        "ld_scopes",
        "ld_members",
        "ld_batches",
        "ld_items",
        "ld_jobs",
        "ld_events",
        "ld_files",
        "ld_article_files",
        "ld_publications",
        "ld_legacy_rows",
        "ld_manual_inputs",
        "ld_object_provenance",
        "ld_retry",
    ];

    public async Task<string> ExportBundle(Guid library, OriginalStore originals)
    {
        originals.Admit(library, BundleLimit);
        var directory = Path.Combine(originals.Root, library.ToString("N"), "transfers");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".bundle");
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        if (
            !Convert.ToBoolean(
                await Scalar(db, "SELECT ready FROM ld_libraries WHERE library_id=@p0", library)
            )
        )
            throw new KeyNotFoundException();
        var tables = new JsonObject();
        var counts = new Dictionary<string, int>();
        int metadataBytes = 0;
        foreach (var table in BundleTables)
        {
            var rows = await Rows(
                db,
                $"SELECT (to_jsonb(t)-'library_id'-'lease_token'-'lease_until')::text AS value FROM {table} t WHERE library_id=@p0 LIMIT 10001",
                library
            );
            if (rows.Count > 10000)
                throw new IOException("Portable transfer table exceeds 10000 rows; no truncation.");
            var array = new JsonArray();
            foreach (var row in rows)
            {
                var text = (string)row["value"];
                metadataBytes = checked(metadataBytes + Encoding.UTF8.GetByteCount(text));
                if (metadataBytes > MetadataLimit)
                    throw new IOException("Portable metadata exceeds 32 MiB; no truncation.");
                array.Add(JsonNode.Parse(text));
            }
            tables[table] = array;
            counts[table] = rows.Count;
        }
        var metadata = Encoding.UTF8.GetBytes(tables.ToJsonString());
        if (metadata.Length > MetadataLimit)
            throw new IOException("Portable metadata exceeds 32 MiB.");
        var files = new List<BundleFile>();
        long total = metadata.Length;
        using (
            var file = new FileStream(
                path,
                FileMode.CreateNew,
                FileAccess.ReadWrite,
                FileShare.None
            )
        )
        {
            using (var zip = new ZipArchive(file, ZipArchiveMode.Create, true))
            {
                WriteEntry(zip, "metadata.json", metadata);
                var requested = new Dictionary<string, string>();
                foreach (var row in tables["ld_files"].AsArray())
                {
                    var hash = row["hash"].GetValue<string>();
                    var kind = row["kind"].GetValue<string>();
                    if (kind is not (OriginalValidation.PdfKind or OriginalValidation.XmlKind))
                        throw new IOException("Unsupported artifact kind; no lossy transfer.");
                    requested[
                        "objects/"
                            + hash.ToLowerInvariant()
                            + (kind == OriginalValidation.PdfKind ? ".pdf" : ".xml")
                    ] = hash;
                }
                foreach (var row in tables["ld_manual_inputs"].AsArray())
                {
                    var job = tables["ld_jobs"]
                        .AsArray()
                        .First(x =>
                            x["job_id"].GetValue<string>() == row["job_id"].GetValue<string>()
                        );
                    var token = row["stage_token"].GetValue<string>();
                    if (!Guid.TryParseExact(token, "N", out _))
                        throw new IOException("Invalid retained staging identifier.");
                    if (job["state"].GetValue<string>() != "completed")
                        requested["staging/" + token + ".part"] = row["hash"].GetValue<string>();
                }
                foreach (var pair in requested)
                {
                    var source = Path.Combine(
                        originals.Root,
                        library.ToString("N"),
                        pair.Key.Replace('/', Path.DirectorySeparatorChar)
                    );
                    try
                    {
                        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0)
                            throw new IOException("Linked file.");
                        var bytes = Artifacts.ReadBoundedFile(source);
                        var actual = Artifacts.Hash(bytes);
                        if (!actual.Equals(pair.Value, StringComparison.OrdinalIgnoreCase))
                            throw new IOException("Hash mismatch.");
                        total = checked(total + bytes.Length);
                        if (total > BundleLimit - MetadataLimit)
                            throw new IOException("Portable file budget exceeds 224 MiB.");
                        WriteEntry(zip, pair.Key, bytes);
                        files.Add(new(pair.Key, pair.Value, bytes.Length, "valid"));
                    }
                    catch (IOException) when (!File.Exists(source))
                    {
                        files.Add(new(pair.Key, pair.Value, 0, "missing"));
                    }
                }
                var manifest = new BundleManifest(
                    1,
                    3,
                    library,
                    "all records and complete library relations",
                    Artifacts.Hash(metadata),
                    counts,
                    files,
                    "Private unencrypted library transfer: raw metadata and original bytes retained; no accounts, sessions, provider budgets or worker leases. Restore creates a new owned library and pauses unfinished work. Missing files prevent restore."
                );
                WriteEntry(zip, "manifest.json", JsonSerializer.SerializeToUtf8Bytes(manifest));
            }
            file.Flush(true);
        }
        await tx.CommitAsync();
        return path;
    }

    private static void WriteEntry(ZipArchive zip, string name, byte[] bytes)
    {
        using var output = zip.CreateEntry(name, CompressionLevel.NoCompression).Open();
        output.Write(bytes);
    }

    internal static byte[] ReadEntry(ZipArchiveEntry entry, long limit)
    {
        if (
            entry.Length < 0
            || entry.Length > limit
            || entry.CompressedLength > BundleLimit
            || (
                entry.Length > 1024 * 1024
                && entry.Length > Math.Max(1, entry.CompressedLength) * 100
            )
        )
            throw new IOException("Archive entry exceeds safe size or compression ratio.");
        if (((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000)
            throw new IOException("Archive symbolic links are forbidden.");
        using var input = entry.Open();
        using var output = new MemoryStream();
        var chunk = new byte[65536];
        int n;
        while ((n = input.Read(chunk)) > 0)
        {
            if (output.Length + n > limit)
                throw new IOException("Expanded entry exceeds size limit.");
            output.Write(chunk, 0, n);
        }
        if (output.Length != entry.Length)
            throw new IOException("Truncated archive entry.");
        return output.ToArray();
    }

    // 僅還原固定資料表的值；輸入不包含 SQL、帳號權限、租約或可執行排程。
    public async Task<Guid> ImportBundle(
        Guid owner,
        string path,
        OriginalStore originals,
        Action<string> checkpoint = null
    )
    {
        if (new FileInfo(path).Length > BundleLimit)
            throw new IOException("Bundle exceeds 256 MiB.");
        using var zip = ZipFile.OpenRead(path);
        if (zip.Entries.Count is < 2 or > 20002)
            throw new IOException("Archive entry count is invalid.");
        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        long expanded = 0;
        foreach (var entry in zip.Entries)
        {
            if (
                !entries.TryAdd(entry.FullName, entry)
                || entry.FullName.Contains('\\')
                || entry.FullName.Contains(':')
                || entry.FullName.Split('/').Any(x => x is "" or "." or "..")
            )
                throw new IOException("Duplicate or unsafe archive path.");
            expanded = checked(expanded + entry.Length);
            if (expanded > BundleLimit)
                throw new IOException("Expanded bundle exceeds 256 MiB.");
        }
        if (!entries.ContainsKey("manifest.json") || !entries.ContainsKey("metadata.json"))
            throw new IOException("Bundle metadata is missing.");
        var manifest =
            JsonSerializer.Deserialize<BundleManifest>(
                ReadEntry(entries["manifest.json"], 4 * 1024 * 1024)
            ) ?? throw new IOException("Missing manifest.");
        if (
            manifest.Format != 1
            || manifest.Schema != 3
            || manifest.Coverage != "all records and complete library relations"
        )
            throw new IOException("Unsupported bundle format, schema or coverage.");
        var metadata = ReadEntry(entries["metadata.json"], MetadataLimit);
        if (
            !Artifacts
                .Hash(metadata)
                .Equals(manifest.MetadataHash, StringComparison.OrdinalIgnoreCase)
        )
            throw new IOException("Metadata hash mismatch.");
        var deadline = System.Diagnostics.Stopwatch.StartNew();
        void TimeBound()
        {
            if (deadline.Elapsed > TimeSpan.FromMinutes(2))
                throw new IOException(
                    "Portable restore time budget exceeded; no completion recorded."
                );
        }
        var tables = JsonNode.Parse(metadata).AsObject();
        if (!tables.Select(x => x.Key).Order().SequenceEqual(BundleTables.Order()))
            throw new IOException("Unexpected or missing library tables.");
        var expected = new HashSet<string>(StringComparer.Ordinal)
        {
            "manifest.json",
            "metadata.json",
        };
        foreach (var item in manifest.Files)
        {
            if (
                item.State != "valid"
                || !expected.Add(item.Path)
                || !entries.TryGetValue(item.Path, out var entry)
                || item.Bytes != entry.Length
            )
                throw new IOException("Missing, repeated or incomplete original in bundle.");
            if (
                !System.Text.RegularExpressions.Regex.IsMatch(
                    item.Path,
                    @"^(objects/[a-f0-9]{64}\.(xml|pdf)|staging/[a-f0-9]{32}\.part)$"
                )
            )
                throw new IOException("Unsupported original path or executable entry.");
            var bytes = ReadEntry(entry, NcbiTransport.MaximumBytes);
            if (!Artifacts.Hash(bytes).Equals(item.Hash, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Original hash mismatch.");
        }
        if (expected.Count != entries.Count || entries.Keys.Any(x => !expected.Contains(x)))
            throw new IOException("Unexpected archive content.");
        var id = Guid.NewGuid();
        originals.Admit(id, expanded * 2);
        var transfer = Guid.NewGuid();
        var stage = Path.Combine(originals.Root, "transfer-staging", transfer.ToString("N"));
        var target = Path.Combine(originals.Root, id.ToString("N"));
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(
            db,
            "INSERT INTO ld_libraries VALUES(@p0,@p1,@p2,false)",
            id,
            owner,
            "Restored library"
        );
        foreach (var table in BundleTables)
        {
            var array = tables[table].AsArray();
            if (
                array.Count > 10000
                || !manifest.Counts.TryGetValue(table, out var count)
                || count != array.Count
            )
                throw new IOException("Table row count mismatch.");
            var columns = (
                await Rows(
                    db,
                    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=@p0 ORDER BY ordinal_position",
                    table
                )
            )
                .Select(r => (string)r["column_name"])
                .ToArray();
            var permitted = columns
                .Where(c => c is not ("library_id" or "lease_token" or "lease_until"))
                .Order()
                .ToArray();
            foreach (var node in array)
            {
                TimeBound();
                var row = node.AsObject();
                if (!row.Select(x => x.Key).Order().SequenceEqual(permitted))
                    throw new IOException("Unexpected or missing record fields.");
                row["library_id"] = id.ToString();
                if (table == "ld_jobs")
                {
                    row["lease_token"] = null;
                    row["lease_until"] = null;
                }
                if (table is "ld_jobs" or "ld_items" or "ld_batches" or "ld_runs")
                {
                    var state = row["state"].GetValue<string>();
                    if (
                        state
                        is "running"
                            or "queued"
                            or "scheduled"
                            or "searching"
                            or "resolving"
                            or "waiting"
                            or "downloading"
                            or "validating"
                            or "publishing"
                            or "redirecting"
                    )
                        row["state"] = "paused";
                }
                if (table == "ld_retry" && row["status"].GetValue<string>() == "pending")
                    row["status"] = "paused";
                await Exec(
                    db,
                    $"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},@p0::jsonb)",
                    row.ToJsonString()
                );
            }
        }
        foreach (var row in tables["ld_records"].AsArray())
        {
            var article = JsonSerializer.Deserialize<Article>(row["metadata"].GetValue<string>());
            if (article.SearchId != row["search_id"].GetValue<string>())
                throw new IOException("Canonical metadata identity differs from record key.");
        }
        foreach (var row in tables["ld_files"].AsArray())
        {
            if (
                row["kind"].GetValue<string>()
                is not (OriginalValidation.XmlKind or OriginalValidation.PdfKind)
            )
                throw new IOException("Unsupported artifact kind.");
            if (
                !tables["ld_article_files"]
                    .AsArray()
                    .Any(x => x["hash"].GetValue<string>() == row["hash"].GetValue<string>())
            )
                throw new IOException("Original has no bibliographic association.");
        }
        // 關聯內容獨立比對，不只信任序列化器的往返；同一內容可以對應合法版本證據。
        foreach (var row in tables["ld_article_files"].AsArray())
        {
            var hash = row["hash"].GetValue<string>();
            var f = tables["ld_files"].AsArray().Single(x => x["hash"].GetValue<string>() == hash);
            var relative =
                "objects/"
                + hash.ToLowerInvariant()
                + (f["kind"].GetValue<string>() == OriginalValidation.PdfKind ? ".pdf" : ".xml");
            if (
                !entries.TryGetValue(relative, out var entry)
                || entry.Length != f["bytes"].GetValue<long>()
            )
                throw new IOException("File association is incomplete.");
            var article = JsonSerializer.Deserialize<Article>(
                tables["ld_records"]
                    .AsArray()
                    .Single(x =>
                        x["search_id"].GetValue<string>() == row["search_id"].GetValue<string>()
                    )["metadata"]
                    .GetValue<string>()
            );
            OriginalValidation.Validate(
                ReadEntry(entry, NcbiTransport.MaximumBytes),
                article,
                true
            );
        }
        foreach (var row in tables["ld_manual_inputs"].AsArray())
        {
            var job = tables["ld_jobs"]
                .AsArray()
                .Single(x => x["job_id"].GetValue<string>() == row["job_id"].GetValue<string>());
            if (job["state"].GetValue<string>() != "completed")
            {
                var relative = "staging/" + row["stage_token"].GetValue<string>() + ".part";
                if (
                    !manifest.Files.Any(x =>
                        x.Path == relative && x.Hash == row["hash"].GetValue<string>()
                    )
                )
                    throw new IOException("Retained manual input is missing.");
                var article = JsonSerializer.Deserialize<Article>(
                    tables["ld_records"]
                        .AsArray()
                        .Single(x =>
                            x["search_id"].GetValue<string>() == job["search_id"].GetValue<string>()
                        )["metadata"]
                        .GetValue<string>()
                );
                OriginalValidation.Validate(
                    ReadEntry(entries[relative], NcbiTransport.MaximumBytes),
                    article,
                    true
                );
            }
        }
        await Exec(
            db,
            "UPDATE ld_batches b SET state='paused' WHERE b.library_id=@p0 AND b.state NOT IN ('paused','cancelled') AND EXISTS(SELECT 1 FROM ld_items i WHERE i.library_id=b.library_id AND i.batch_id=b.batch_id AND i.state='paused')",
            id
        );
        await Exec(
            db,
            "SELECT setval(pg_get_serial_sequence('ld_records','ordinal'),GREATEST((SELECT last_value FROM ld_records_ordinal_seq),COALESCE((SELECT max(ordinal) FROM ld_records),1)))"
        );
        checkpoint?.Invoke("validated");
        Directory.CreateDirectory(stage);
        foreach (var item in manifest.Files)
        {
            TimeBound();
            var destination = Path.Combine(
                stage,
                item.Path.Replace('/', Path.DirectorySeparatorChar)
            );
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            using var file = new FileStream(
                destination,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None
            );
            file.Write(ReadEntry(entries[item.Path], NcbiTransport.MaximumBytes));
            file.Flush(true);
        }
        checkpoint?.Invoke("staged");
        Directory.Move(stage, target);
        checkpoint?.Invoke("published");
        await Exec(
            db,
            "INSERT INTO ld_transfers VALUES(@p0,@p1,@p2,'completed','New owned library; unfinished work paused; source IDs and private metadata preserved.',now())",
            transfer,
            id,
            manifest.OriginLibrary
        );
        await Event(
            db,
            id,
            null,
            "restored",
            "Private bundle restored from library "
                + manifest.OriginLibrary
                + "; authority and leases not imported."
        );
        await Exec(db, "UPDATE ld_libraries SET ready=true WHERE library_id=@p0", id);
        await tx.CommitAsync();
        return id;
    }
}
