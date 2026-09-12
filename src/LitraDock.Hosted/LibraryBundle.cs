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
    // 共用暫存可經由「待確認→確認→另一批次恢復」消耗；每一步都要求同一記錄、雜湊與保留發布證據。
    private static bool ConsumedHistoricalInput(JsonObject tables, JsonNode input)
    {
        var original = tables["ld_jobs"]
            .AsArray()
            .Single(x => x["job_id"].GetValue<string>() == input["job_id"].GetValue<string>());
        var search = original["search_id"]?.GetValue<string>();
        var hash = input["hash"].GetValue<string>();
        bool ProvedPublication(JsonNode attempt)
        {
            var job = attempt["job_id"].GetValue<string>();
            if (
                attempt["search_id"]?.GetValue<string>() != search
                || !tables["ld_article_files"]
                    .AsArray()
                    .Any(x =>
                        x["search_id"].GetValue<string>() == search
                        && x["hash"].GetValue<string>() == hash
                    )
            )
                return false;
            return tables["ld_object_provenance"]
                .AsArray()
                .Any(proof =>
                    proof["search_id"].GetValue<string>() == search
                    && proof["hash"].GetValue<string>() == hash
                    && tables["ld_jobs"]
                        .AsArray()
                        .Any(next =>
                            next["job_id"].GetValue<string>() == proof["job_id"].GetValue<string>()
                            && next["state"].GetValue<string>() == "completed"
                            && next["search_id"]?.GetValue<string>() == search
                        )
                    && (
                        proof["job_id"].GetValue<string>() == job
                        || (
                            JsonNode
                                .Parse(proof["details"].GetValue<string>())["recoveredFromJob"]
                                ?.GetValue<string>() == job
                            && tables["ld_publications"]
                                .AsArray()
                                .Any(p =>
                                    p["job_id"].GetValue<string>() == job
                                    && p["hash"].GetValue<string>() == hash
                                    && p["state"].GetValue<string>() == "reconciled"
                                )
                        )
                    )
                );
        }
        if (ProvedPublication(original))
            return true;
        if (
            tables["ld_items"]
                .AsArray()
                .Any(x =>
                    x["last_job_id"]?.GetValue<string>() == input["job_id"].GetValue<string>()
                )
        )
            return false;
        return tables["ld_manual_inputs"]
            .AsArray()
            .Any(other =>
                other["stage_token"].GetValue<string>() == input["stage_token"].GetValue<string>()
                && other["hash"].GetValue<string>() == hash
                && ProvedPublication(
                    tables["ld_jobs"]
                        .AsArray()
                        .Single(x =>
                            x["job_id"].GetValue<string>() == other["job_id"].GetValue<string>()
                        )
                )
            );
    }

    private static void ValidateBundleGraph(JsonObject tables)
    {
        var jobs = tables["ld_jobs"].AsArray().ToDictionary(x => x["job_id"].GetValue<string>());
        var items = tables["ld_items"].AsArray().ToDictionary(x => x["item_id"].GetValue<string>());
        var batches = tables["ld_batches"]
            .AsArray()
            .ToDictionary(x => x["batch_id"].GetValue<string>());
        bool HasOriginal(string search) =>
            tables["ld_article_files"]
                .AsArray()
                .Any(x => x["search_id"].GetValue<string>() == search);
        foreach (var item in items.Values)
        {
            var current = item["last_job_id"]?.GetValue<string>();
            if (
                current == null
                    ? item["attempts"].GetValue<int>() != 0
                        || item["state"].GetValue<string>() is not ("paused" or "cancelled")
                        || jobs.Values.Any(j =>
                            j["item_id"]?.GetValue<string>() == item["item_id"].GetValue<string>()
                        )
                    : !jobs.TryGetValue(current, out var job)
                        || job["item_id"]?.GetValue<string>() != item["item_id"].GetValue<string>()
                        || job["search_id"]?.GetValue<string>()
                            != item["search_id"].GetValue<string>()
                        || job["kind"].GetValue<string>() != "acquire"
            )
                throw new IOException("Current acquisition job and item identity graph disagree.");
            if (
                !batches.TryGetValue(item["batch_id"].GetValue<string>(), out var batch)
                || !tables["ld_members"]
                    .AsArray()
                    .Any(x =>
                        x["scope_id"].GetValue<string>() == batch["scope_id"].GetValue<string>()
                        && x["search_id"].GetValue<string>() == item["search_id"].GetValue<string>()
                    )
            )
                throw new IOException("Acquisition item is outside its batch scope.");
            if (
                item["state"].GetValue<string>() == "completed"
                && !HasOriginal(item["search_id"].GetValue<string>())
            )
                throw new IOException(
                    "Completed acquisition has no preserved original association."
                );
        }
        foreach (var job in jobs.Values.Where(x => x["kind"].GetValue<string>() == "acquire"))
        {
            if (
                job["item_id"] == null
                    ? !tables["ld_legacy_rows"]
                        .AsArray()
                        .Any(x =>
                            x["table_name"].GetValue<string>() == "jobs"
                            && JsonNode
                                .Parse(x["data"].GetValue<string>())["job_id"]
                                ?.GetValue<string>() == job["job_id"].GetValue<string>()
                        )
                    : !items.TryGetValue(job["item_id"].GetValue<string>(), out var item)
                        || job["search_id"]?.GetValue<string>()
                            != item["search_id"].GetValue<string>()
            )
                throw new IOException("Historical acquisition identity graph disagrees.");
            if (
                job["state"].GetValue<string>() == "completed"
                && !HasOriginal(job["search_id"].GetValue<string>())
            )
                throw new IOException(
                    "Completed acquisition has no preserved original association."
                );
        }
        foreach (var record in tables["ld_records"].AsArray())
        {
            var article = JsonSerializer.Deserialize<Article>(
                record["metadata"].GetValue<string>()
            );
            if (
                article.RetrievalState == "completed"
                && !HasOriginal(record["search_id"].GetValue<string>())
            )
                throw new IOException("Completed metadata has no preserved original association.");
        }
    }

    // 舊版原始 XML 種類名稱保持原值；只在驗證與副檔名判定時使用等價的標準種類。
    private static string BundleKind(string kind) =>
        kind == "Complete source XML" ? OriginalValidation.XmlKind : kind;

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
        .. ResearchTables,
    ];

    public async Task<string> ExportBundle(
        Guid library,
        OriginalStore originals,
        string scope = null,
        bool selectedOnly = false
    )
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
        if (scope != null)
        {
            if (
                await Scalar(
                    db,
                    "SELECT scope_id FROM ld_scopes WHERE library_id=@p0 AND scope_id=@p1",
                    library,
                    scope
                ) == null
            )
                throw new KeyNotFoundException();
            var selected = await Rows(
                db,
                "SELECT search_id FROM ld_members WHERE library_id=@p0 AND scope_id=@p1 AND (NOT @p2 OR selected)",
                library,
                scope,
                selectedOnly
            );
            ProjectBundle(tables, selected.Select(x => (string)x["search_id"]).ToHashSet());
            counts = tables.ToDictionary(x => x.Key, x => x.Value.AsArray().Count);
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
                    var kind = BundleKind(row["kind"].GetValue<string>());
                    if (
                        kind
                        is not (
                            OriginalValidation.PdfKind
                            or OriginalValidation.XmlKind
                            or OriginalValidation.HtmlKind
                            or OriginalValidation.TextKind
                        )
                    )
                        throw new IOException("Unsupported artifact kind; no lossy transfer.");
                    requested[
                        "objects/" + hash.ToLowerInvariant() + OriginalValidation.Extension(kind)
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
                    if (
                        job["state"].GetValue<string>() != "completed"
                        && !ConsumedHistoricalInput(tables, row)
                    )
                        requested["staging/" + token + ".part"] = row["hash"].GetValue<string>();
                }
                foreach (var conversion in tables["ld_conversions"].AsArray())
                {
                    if (conversion["state"].ToString() == "completed")
                        continue;
                    var details = JsonNode.Parse(conversion["details"].ToString());
                    if (details?["hash"] == null)
                        continue;
                    var hash = details["hash"].ToString();
                    var stage = details["stage"]?.ToString();
                    if (!Guid.TryParseExact(stage, "N", out _))
                        throw new IOException("Invalid retained conversion stage.");
                    var relative = File.Exists(
                        originals.ObjectPath(library, hash, OriginalValidation.PdfKind)
                    )
                        ? "objects/" + hash.ToLowerInvariant() + ".pdf"
                        : "staging/" + stage + ".part";
                    requested[relative] = hash;
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
                    2,
                    4,
                    library,
                    scope == null
                        ? "all records and complete library relations"
                        : "selected records and referenced library relations",
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

    // 拒絕同名 JSON 欄位，避免不同讀取器對同一封存的身份或權限資料產生歧義。
    private static void ValidateUniqueJson(byte[] bytes)
    {
        var reader = new Utf8JsonReader(bytes);
        var objects = new Stack<HashSet<string>>();
        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.StartObject)
                objects.Push(new HashSet<string>(StringComparer.Ordinal));
            else if (reader.TokenType == JsonTokenType.EndObject)
                objects.Pop();
            else if (
                reader.TokenType == JsonTokenType.PropertyName
                && !objects.Peek().Add(reader.GetString())
            )
                throw new IOException("Duplicate JSON property in private bundle.");
        }
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
        var manifestBytes = ReadEntry(entries["manifest.json"], 4 * 1024 * 1024);
        ValidateUniqueJson(manifestBytes);
        var manifest =
            JsonSerializer.Deserialize<BundleManifest>(manifestBytes)
            ?? throw new IOException("Missing manifest.");
        if (
            !(
                (manifest.Format == 1 && manifest.Schema == 3)
                || (manifest.Format == 2 && manifest.Schema == 4)
            )
            || manifest.Coverage
                is not (
                    "all records and complete library relations"
                    or "selected records and referenced library relations"
                )
        )
            throw new IOException("Unsupported bundle format, schema or coverage.");
        var metadata = ReadEntry(entries["metadata.json"], MetadataLimit);
        ValidateUniqueJson(metadata);
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
        if (manifest.Schema == 3)
        {
            if (
                !tables
                    .Select(x => x.Key)
                    .Order()
                    .SequenceEqual(BundleTables.Except(ResearchTables).Order())
            )
                throw new IOException("Unexpected legacy bundle tables.");
            foreach (var table in ResearchTables)
            {
                tables[table] = new JsonArray();
                manifest.Counts[table] = 0;
            }
        }
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
                    @"^(objects/[a-f0-9]{64}\.(xml|pdf|html|txt)|staging/[a-f0-9]{32}\.part)$"
                )
            )
                throw new IOException("Unsupported original path or executable entry.");
            if (
                item.Path.StartsWith("objects/", StringComparison.Ordinal)
                && !Path.GetFileNameWithoutExtension(item.Path)
                    .Equals(item.Hash, StringComparison.OrdinalIgnoreCase)
            )
                throw new IOException("Object path and manifest hash disagree.");
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
        await TransferCheckpoint(
            transfer,
            owner,
            id,
            manifest.OriginLibrary,
            "validating",
            "Private transfer accepted for validation; no library published."
        );
        try
        {
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
                foreach (
                    var node in (
                        table == "ld_records"
                            ? array.OrderBy(x => x["ordinal"].GetValue<long>())
                            : array.AsEnumerable()
                    )
                )
                {
                    TimeBound();
                    var row = node.AsObject();
                    if (!row.Select(x => x.Key).Order().SequenceEqual(permitted))
                        throw new IOException("Unexpected or missing record fields.");
                    row["library_id"] = id.ToString();
                    if (table is "ld_jobs" or "ld_conversions")
                    {
                        row["lease_token"] = null;
                        row["lease_until"] = null;
                    }
                    if (
                        table
                        is "ld_jobs"
                            or "ld_items"
                            or "ld_batches"
                            or "ld_runs"
                            or "ld_conversions"
                    )
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
                    var insertColumns = string.Join(
                        ",",
                        columns.Where(c => table != "ld_records" || c != "ordinal")
                    );
                    await Exec(
                        db,
                        $"INSERT INTO {table}({insertColumns}) SELECT {insertColumns} FROM jsonb_populate_record(NULL::{table},@p0::jsonb)",
                        row.ToJsonString()
                    );
                }
            }
            ValidateBundleGraph(tables);
            ValidateResearchBundle(tables);
            foreach (var row in tables["ld_records"].AsArray())
            {
                ValidateUniqueJson(Encoding.UTF8.GetBytes(row["metadata"].GetValue<string>()));
                var article = JsonSerializer.Deserialize<Article>(
                    row["metadata"].GetValue<string>()
                );
                if (article.SearchId != row["search_id"].GetValue<string>())
                    throw new IOException("Canonical metadata identity differs from record key.");
                foreach (
                    var identifier in new[]
                    {
                        ("pmid", article.Pmid),
                        ("doi", Metadata.NormalizeDoi(article.Doi)),
                        ("pmcid", article.Pmcid),
                    }
                )
                {
                    var index = tables["ld_identifiers"]
                        .AsArray()
                        .Where(x =>
                            x["search_id"].GetValue<string>() == article.SearchId
                            && x["kind"].GetValue<string>() == identifier.Item1
                        )
                        .ToArray();
                    if (
                        identifier.Item2.Length == 0
                            ? index.Length != 0
                            : index.Length != 1
                                || index[0]["value"].GetValue<string>() != identifier.Item2
                    )
                        throw new IOException("Identifier index and canonical metadata disagree.");
                }
            }
            if (
                tables["ld_identifiers"]
                    .AsArray()
                    .Any(x => x["kind"].GetValue<string>() is not ("pmid" or "doi" or "pmcid"))
            )
                throw new IOException("Unsupported identifier kind for this schema.");
            foreach (var row in tables["ld_files"].AsArray())
            {
                if (
                    BundleKind(row["kind"].GetValue<string>())
                    is not (
                        OriginalValidation.XmlKind
                        or OriginalValidation.PdfKind
                        or OriginalValidation.HtmlKind
                        or OriginalValidation.TextKind
                    )
                )
                    throw new IOException("Unsupported artifact kind.");
                if (
                    !tables["ld_article_files"]
                        .AsArray()
                        .Any(x => x["hash"].GetValue<string>() == row["hash"].GetValue<string>())
                    && !tables["ld_derivations"]
                        .AsArray()
                        .Any(x => x["hash"].ToString() == row["hash"].ToString())
                )
                    throw new IOException("Original has no bibliographic association.");
            }
            // 關聯內容獨立比對，不只信任序列化器的往返；同一內容可以對應合法版本證據。
            foreach (var row in tables["ld_article_files"].AsArray())
            {
                TimeBound();
                var hash = row["hash"].GetValue<string>();
                var f = tables["ld_files"]
                    .AsArray()
                    .Single(x => x["hash"].GetValue<string>() == hash);
                var relative =
                    "objects/"
                    + hash.ToLowerInvariant()
                    + OriginalValidation.Extension(f["kind"].GetValue<string>());
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
                var originalBytes = ReadEntry(entry, NcbiTransport.MaximumBytes);
                var validated = OriginalValidation.Validate(originalBytes, article, true);
                var declared = manifest.Files.Single(x => x.Path == relative);
                if (
                    !validated.Hash.Equals(hash, StringComparison.OrdinalIgnoreCase)
                    || !declared.Hash.Equals(hash, StringComparison.OrdinalIgnoreCase)
                    || OriginalValidation.Kind(originalBytes)
                        != BundleKind(f["kind"].GetValue<string>())
                    || validated.Bytes != f["bytes"].GetValue<long>()
                )
                    throw new IOException(
                        "Original bytes, manifest, file row and artifact kind disagree."
                    );
            }
            foreach (var derived in tables["ld_derivations"].AsArray())
            {
                var f = tables["ld_files"]
                    .AsArray()
                    .Single(x => x["hash"].ToString() == derived["hash"].ToString());
                var relative = "objects/" + derived["hash"].ToString().ToLowerInvariant() + ".pdf";
                if (
                    !entries.TryGetValue(relative, out var entry)
                    || f["kind"].ToString() != OriginalValidation.PdfKind
                    || entry.Length != f["bytes"].GetValue<long>()
                )
                    throw new IOException("Derived file association is incomplete.");
                await PdfInspection.Inspect(
                    ReadEntry(entry, NcbiTransport.MaximumBytes),
                    new Article { SearchId = derived["search_id"].ToString() },
                    false,
                    derived["kind"].ToString()
                );
            }
            foreach (var conversion in tables["ld_conversions"].AsArray())
            {
                var details = JsonNode.Parse(conversion["details"].ToString());
                if (conversion["state"].ToString() == "completed" || details?["hash"] == null)
                    continue;
                var hash = details["hash"].ToString();
                var staged = "staging/" + details["stage"] + ".part";
                if (
                    !manifest.Files.Any(x =>
                        x.Hash == hash && (x.Path == "objects/" + hash + ".pdf" || x.Path == staged)
                    )
                )
                    throw new IOException(
                        "Prepared conversion is missing its retained output bytes."
                    );
                var declared = manifest.Files.First(x =>
                    x.Hash == hash && (x.Path == "objects/" + hash + ".pdf" || x.Path == staged)
                );
                await PdfInspection.Inspect(
                    ReadEntry(entries[declared.Path], NcbiTransport.MaximumBytes),
                    new Article { SearchId = conversion["search_id"].ToString() },
                    false,
                    details["kind"].ToString()
                );
            }
            foreach (var row in tables["ld_manual_inputs"].AsArray())
            {
                TimeBound();
                var job = tables["ld_jobs"]
                    .AsArray()
                    .Single(x =>
                        x["job_id"].GetValue<string>() == row["job_id"].GetValue<string>()
                    );
                if (
                    job["state"].GetValue<string>() != "completed"
                    && !ConsumedHistoricalInput(tables, row)
                )
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
                                x["search_id"].GetValue<string>()
                                == job["search_id"].GetValue<string>()
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
            await TransferCheckpoint(
                transfer,
                owner,
                id,
                manifest.OriginLibrary,
                "staged",
                "Validated files staged; library not committed."
            );
            checkpoint?.Invoke("staged");
            Directory.Move(stage, target);
            await TransferCheckpoint(
                transfer,
                owner,
                id,
                manifest.OriginLibrary,
                "published",
                "Files moved; database association not yet committed."
            );
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
            try
            {
                await TransferCheckpoint(
                    transfer,
                    owner,
                    id,
                    manifest.OriginLibrary,
                    "completed",
                    "New library and immutable files committed; unfinished work paused."
                );
            }
            catch
            { /* 可見文庫已提交；後續狀態查詢依資料庫存在性對帳，不將成功寫入改報失敗。 */
            }
            return id;
        }
        catch
        {
            try
            {
                await TransferCheckpoint(
                    transfer,
                    owner,
                    id,
                    manifest.OriginLibrary,
                    "interrupted",
                    "Transfer completion was not confirmed; staged evidence retained for visibility reconciliation."
                );
            }
            catch
            { /* 保留原始錯誤；先前持久化階段仍可在重開後對帳。 */
            }
            throw;
        }
    }

    private async Task TransferCheckpoint(
        Guid transfer,
        Guid owner,
        Guid library,
        Guid origin,
        string phase,
        string reason
    )
    {
        await using var db = await Data.OpenConnectionAsync();
        await Exec(
            db,
            "INSERT INTO ld_transfer_attempts VALUES(@p0,@p1,@p2,@p3,@p4,now(),@p5) ON CONFLICT(transfer_id) DO UPDATE SET phase=excluded.phase,updated_at=now(),reason=excluded.reason",
            transfer,
            owner,
            library,
            origin,
            phase,
            reason
        );
    }

    public async Task<object> TransferStatus(Guid owner)
    {
        await using var db = await Data.OpenConnectionAsync();
        await Exec(
            db,
            "UPDATE ld_transfer_attempts t SET phase=CASE WHEN EXISTS(SELECT 1 FROM ld_libraries l WHERE l.library_id=t.target_library AND l.owner_id=t.owner_id AND l.ready) THEN 'completed' ELSE 'interrupted' END,reason='Reconciled durable library visibility; retained files require no overwrite.' WHERE owner_id=@p0 AND phase IN ('validating','staged','published','interrupted') AND updated_at<now()-interval '3 minutes'",
            owner
        );
        return await Rows(
            db,
            "SELECT transfer_id,target_library,origin_library,phase,updated_at,reason FROM ld_transfer_attempts WHERE owner_id=@p0 ORDER BY updated_at DESC LIMIT 100",
            owner
        );
    }
}
