using System.Text.Json;
using LitraDock.Core;

namespace Literature.Service;

// 私人原始檔僅以文庫 UUID 與內容雜湊定址；URL 不接受使用者提供的作業系統路徑。
public sealed class OriginalStore(string root)
{
    public string Root { get; } = Path.GetFullPath(root);

    public void VerifyPrivateRoot(string contentRoot)
    {
        var content = Path.TrimEndingDirectorySeparator(Path.GetFullPath(contentRoot));
        var privateRoot = Path.TrimEndingDirectorySeparator(Root);
        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        if (
            privateRoot.Equals(content, comparison)
            || privateRoot.StartsWith(content + Path.DirectorySeparatorChar, comparison)
            || content.StartsWith(privateRoot + Path.DirectorySeparatorChar, comparison)
        )
            throw new InvalidOperationException(
                "Private originals and application content must use separate directory trees."
            );
        VerifyNoLinks(content);
        VerifyNoLinks(privateRoot);
    }

    private static void VerifyNoLinks(string path)
    {
        for (var part = new DirectoryInfo(path); part != null; part = part.Parent)
            if (part.Exists && (part.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException(
                    "Symbolic links and junctions are not supported in the private storage or application path."
                );
    }

    public void VerifyWebRoot(string webRoot)
    {
        VerifyPrivateRoot(webRoot);
        if (!Directory.Exists(webRoot))
            return;
        var pending = new Stack<DirectoryInfo>();
        pending.Push(new DirectoryInfo(webRoot));
        var count = 0;
        while (pending.Count > 0)
        {
            foreach (var item in pending.Pop().EnumerateFileSystemInfos())
            {
                if (++count > 10000)
                    throw new IOException("Public content validation limit exceeded.");
                if ((item.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Linked public content is not supported.");
                if (item is DirectoryInfo directory)
                    pending.Push(directory);
            }
        }
    }

    public string ObjectPath(Guid library, string hash, string kind = null)
    {
        if (hash.Length != 64 || hash.Any(c => !Uri.IsHexDigit(c)))
            throw new ArgumentException("Invalid content hash.");
        var path = Path.Combine(
            Root,
            library.ToString("N"),
            "objects",
            hash.ToLowerInvariant() + (kind == OriginalValidation.PdfKind ? ".pdf" : ".xml")
        );
        if (kind == null && !File.Exists(path) && File.Exists(Path.ChangeExtension(path, ".pdf")))
            path = Path.ChangeExtension(path, ".pdf");
        VerifyNoLinks(Path.GetDirectoryName(path));
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Linked original files are not supported.");
        return path;
    }

    public byte[] Read(Guid library, string hash)
    {
        var bytes = Artifacts.ReadBoundedFile(ObjectPath(library, hash));
        if (!Artifacts.Hash(bytes).Equals(hash, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Original hash validation failed.");
        return bytes;
    }

    public string Stage(Claim claim, byte[] bytes)
    {
        var directory = Path.Combine(Root, claim.Library.ToString("N"), "staging");
        VerifyNoLinks(directory);
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, claim.Lease.ToString("N") + ".part");
        using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        file.Write(bytes);
        file.Flush(true);
        return path;
    }

    public string RetainedStage(Guid library, string token)
    {
        if (!Guid.TryParseExact(token, "N", out var id))
            throw new IOException("Invalid retained staging identifier.");
        var directory = Path.Combine(Root, library.ToString("N"), "staging");
        VerifyNoLinks(directory);
        var path = Path.Combine(directory, id.ToString("N") + ".part");
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Linked staging files are not supported.");
        return path;
    }

    public void Publish(Guid library, string hash, string stage)
    {
        var target = ObjectPath(
            library,
            hash,
            OriginalValidation.Kind(Artifacts.ReadBoundedFile(stage))
        );
        Directory.CreateDirectory(Path.GetDirectoryName(target));
        if (File.Exists(target))
        {
            var valid = false;
            try
            {
                Read(library, hash);
                valid = true;
            }
            catch (IOException)
            {
                var quarantine = Path.Combine(Root, library.ToString("N"), "quarantine");
                Directory.CreateDirectory(quarantine);
                File.Move(
                    target,
                    Path.Combine(quarantine, hash + "-" + Guid.NewGuid().ToString("N"))
                );
            }
            if (valid)
            {
                File.Delete(stage);
                return;
            }
        }
        // 同一內容的並行發布採不可覆寫 move；已存在時重新驗證，不破壞舊檔。
        try
        {
            File.Move(stage, target);
        }
        catch (IOException) when (File.Exists(target))
        {
            Read(library, hash);
            File.Delete(stage);
        }
    }
}

public sealed partial class PgStore
{
    public async Task<bool> RecoverPublication(
        Claim claim,
        Article article,
        OriginalStore originals,
        string requiredHash = null
    )
    {
        await using var db = await Data.OpenConnectionAsync();
        var candidates = await Rows(
            db,
            "SELECT p.* FROM ld_publications p JOIN ld_jobs j USING(library_id,job_id) WHERE p.library_id=@p0 AND j.search_id=@p1 AND p.state='prepared' AND p.job_id<>@p2 AND (@p3::text IS NULL OR p.hash=@p3) ORDER BY j.created_at LIMIT 100",
            claim.Library,
            claim.SearchId,
            claim.Job,
            requiredHash
        );
        foreach (var row in candidates)
        {
            var hash = (string)row["hash"];
            byte[] bytes;
            ArtifactInfo info;
            string retained = null;
            Dictionary<string, object> priorManual = null;
            try
            {
                if (File.Exists(originals.ObjectPath(claim.Library, hash)))
                    bytes = originals.Read(claim.Library, hash);
                else
                {
                    var saved = JsonSerializer.Deserialize<JsonElement>((string)row["info"]);
                    if (!saved.TryGetProperty("stage", out var token))
                        continue;
                    retained = originals.RetainedStage(claim.Library, token.GetString());
                    if (!File.Exists(retained))
                        continue;
                    bytes = Artifacts.ReadBoundedFile(retained);
                    if (Artifacts.Hash(bytes) != hash)
                        throw new IOException(
                            "Retained staging hash mismatch; evidence preserved."
                        );
                }
                priorManual = (
                    await Rows(
                        db,
                        "SELECT * FROM ld_manual_inputs WHERE library_id=@p0 AND job_id=@p1",
                        claim.Library,
                        row["job_id"]
                    )
                ).SingleOrDefault();
                info = OriginalValidation.Validate(bytes, article, IdentityConfirmed(priorManual));
            }
            catch (Exception error)
                when (error
                        is IOException
                            or SourceException
                            or System.Xml.XmlException
                            or JsonException
                )
            {
                await using var failed = await db.BeginTransactionAsync();
                await Fence(db, claim);
                await Event(
                    db,
                    claim.Library,
                    claim.Job,
                    "recovery_validation_failed",
                    Artifacts.SafeMessage(error) + "; retained publication " + row["job_id"]
                );
                await failed.CommitAsync();
                continue;
            }
            var response = new SourceResponse
            {
                Bytes = bytes,
                OriginalUri = (string)row["source_uri"],
                FinalUri = (string)row["final_uri"],
            };
            await PreparePublication(claim, info, response);
            var stage = originals.Stage(claim, bytes);
            var provenance = System.Text.Json.Nodes.JsonNode.Parse(
                priorManual?["provenance"] as string
                    ?? JsonSerializer.Serialize(
                        new
                        {
                            method = "retained_object",
                            source = response.OriginalUri,
                            final = response.FinalUri,
                            hash = info.Hash,
                            license = info.License,
                            validation = info.Validation,
                        }
                    )
            );
            provenance["recoveredFromJob"] = (string)row["job_id"];
            provenance["recoveredAt"] = DateTime.UtcNow.ToString("o");
            await Publish(
                claim,
                article,
                info,
                response,
                originals,
                stage,
                recoveredProvenance: provenance.ToJsonString()
            );
            await using var tx = await db.BeginTransactionAsync();
            await Fence(db, claim);
            await Exec(
                db,
                "UPDATE ld_publications SET state='reconciled' WHERE library_id=@p0 AND job_id=@p1",
                claim.Library,
                row["job_id"]
            );
            await Event(
                db,
                claim.Library,
                claim.Job,
                "reconciled",
                "Validated retained original associated without a source request; prior publication "
                    + row["job_id"]
            );
            await tx.CommitAsync();
            if (retained != null)
                File.Delete(retained);
            if (priorManual != null)
            {
                var originalInput = originals.RetainedStage(
                    claim.Library,
                    (string)priorManual["stage_token"]
                );
                if (
                    File.Exists(originalInput)
                    && Artifacts.Hash(Artifacts.ReadBoundedFile(originalInput)) == hash
                )
                    File.Delete(originalInput);
            }
            return true;
        }
        return false;
    }

    public async Task<List<Dictionary<string, object>>> Files(Guid library, string article)
    {
        await using var db = await Data.OpenConnectionAsync();
        var rows = await Rows(
            db,
            "SELECT a.*,f.kind,f.bytes FROM ld_article_files a JOIN ld_files f USING(library_id,hash) WHERE a.library_id=@p0 AND a.search_id=@p1 ORDER BY hash LIMIT 101",
            library,
            article
        );
        if (rows.Count > 100)
            throw new ArgumentException(
                "Record has more than 100 original versions; use scoped export for complete evidence. No file list was truncated."
            );
        return rows;
    }

    public async Task<bool> Associated(Guid library, string article, string hash)
    {
        await using var db = await Data.OpenConnectionAsync();
        return (bool)
            await Scalar(
                db,
                "SELECT EXISTS(SELECT 1 FROM ld_article_files WHERE library_id=@p0 AND search_id=@p1 AND hash=@p2)",
                library,
                article,
                hash
            );
    }

    public async Task PreparePublication(Claim claim, ArtifactInfo info, SourceResponse response)
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Fence(db, claim);
        await Exec(
            db,
            "INSERT INTO ld_publications VALUES(@p0,@p1,@p2,'prepared',@p3,@p4,@p5)",
            claim.Library,
            claim.Job,
            info.Hash,
            JsonSerializer.Serialize(new { artifact = info, stage = claim.Lease.ToString("N") }),
            response.OriginalUri,
            response.FinalUri
        );
        await tx.CommitAsync();
    }

    public async Task Publish(
        Claim claim,
        Article article,
        ArtifactInfo info,
        SourceResponse response,
        OriginalStore originals,
        string stage,
        Action<PublicationPoint> fault = null,
        string recoveredProvenance = null
    )
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Fence(db, claim);
        originals.Publish(claim.Library, info.Hash, stage);
        originals.Read(claim.Library, info.Hash);
        fault?.Invoke(PublicationPoint.AfterPublish);
        await Exec(
            db,
            "INSERT INTO ld_files VALUES(@p0,@p1,@p2,@p4,@p3) ON CONFLICT(library_id,hash) DO NOTHING",
            claim.Library,
            info.Hash,
            info.Bytes,
            info.Validation,
            Path.GetExtension(info.RelativePath) == ".pdf"
                ? OriginalValidation.PdfKind
                : OriginalValidation.XmlKind
        );
        await Exec(
            db,
            "INSERT INTO ld_article_files VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6) ON CONFLICT DO NOTHING",
            claim.Library,
            article.SearchId,
            info.Hash,
            DateTime.UtcNow.ToString("o"),
            response.OriginalUri,
            response.FinalUri,
            info.License
        );
        fault?.Invoke(PublicationPoint.DuringAttach);
        var manualProvenance =
            await Scalar(
                db,
                "SELECT provenance FROM ld_manual_inputs WHERE library_id=@p0 AND job_id=@p1",
                claim.Library,
                claim.Job
            ) as string;
        var details =
            recoveredProvenance
            ?? manualProvenance
            ?? JsonSerializer.Serialize(
                new
                {
                    method = "public_http",
                    provider = response.OriginalUri.Contains("ebi.ac.uk", StringComparison.Ordinal)
                        ? "europepmc"
                        : "pmc",
                    source = response.OriginalUri,
                    final = response.FinalUri,
                    retrievedAt = DateTime.UtcNow.ToString("o"),
                    license = info.License,
                    validation = info.Validation,
                    hash = info.Hash,
                    locations = SourceAcquisition.Locations(article),
                    version = "Source-supplied version; see preserved metadata",
                }
            );
        await Exec(
            db,
            "INSERT INTO ld_object_provenance VALUES(@p0,@p1,@p2,@p3,@p4) ON CONFLICT DO NOTHING",
            claim.Library,
            claim.Job,
            article.SearchId,
            info.Hash,
            details
        );
        var current = JsonSerializer.Deserialize<Article>(
            (string)
                await Scalar(
                    db,
                    "SELECT metadata FROM ld_records WHERE library_id=@p0 AND search_id=@p1 FOR UPDATE",
                    claim.Library,
                    article.SearchId
                )
        );
        if (!string.IsNullOrEmpty(info.MetadataXml))
            current.FullTextMetadataXml = info.MetadataXml;
        if (!string.IsNullOrEmpty(info.ArticleNumber))
            current.ArticleNumber = info.ArticleNumber;
        if (!string.IsNullOrEmpty(info.EqualContribution))
            current.EqualContribution = info.EqualContribution;
        if (!string.IsNullOrEmpty(info.MetadataXml))
            current.License = info.License;
        current.RetrievalState = "completed";
        await Exec(
            db,
            "UPDATE ld_records SET metadata=@p2 WHERE library_id=@p0 AND search_id=@p1",
            claim.Library,
            article.SearchId,
            JsonSerializer.Serialize(current)
        );
        await Exec(
            db,
            "UPDATE ld_publications SET state='published' WHERE library_id=@p0 AND job_id=@p1",
            claim.Library,
            claim.Job
        );
        await tx.CommitAsync();
    }

    public async Task<List<Dictionary<string, object>>> History(Guid library, int offset)
    {
        if (offset < 0 || offset > 1000000)
            throw new ArgumentException("Invalid offset.");
        await using var db = await Data.OpenConnectionAsync();
        return await Rows(
            db,
            "SELECT event_id,job_id,state,reason,occurred_at FROM ld_events WHERE library_id=@p0 ORDER BY occurred_at,event_id LIMIT 100 OFFSET @p1",
            library,
            offset
        );
    }
}
