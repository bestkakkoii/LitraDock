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

    public string ObjectPath(Guid library, string hash)
    {
        if (hash.Length != 64 || hash.Any(c => !Uri.IsHexDigit(c)))
            throw new ArgumentException("Invalid content hash.");
        var path = Path.Combine(
            Root,
            library.ToString("N"),
            "objects",
            hash.ToLowerInvariant() + ".xml"
        );
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

    public void Publish(Guid library, string hash, string stage)
    {
        var target = ObjectPath(library, hash);
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
    public async Task<List<Dictionary<string, object>>> Files(Guid library, string article)
    {
        await using var db = await Data.OpenConnectionAsync();
        return await Rows(
            db,
            "SELECT a.*,f.kind,f.bytes FROM ld_article_files a JOIN ld_files f USING(library_id,hash) WHERE a.library_id=@p0 AND a.search_id=@p1 ORDER BY hash LIMIT 100",
            library,
            article
        );
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
            JsonSerializer.Serialize(info),
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
        string stage
    )
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Fence(db, claim);
        originals.Publish(claim.Library, info.Hash, stage);
        originals.Read(claim.Library, info.Hash);
        await Exec(
            db,
            "INSERT INTO ld_files VALUES(@p0,@p1,@p2,'PMC source XML',@p3) ON CONFLICT(library_id,hash) DO NOTHING",
            claim.Library,
            info.Hash,
            info.Bytes,
            info.Validation
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
        var current = JsonSerializer.Deserialize<Article>(
            (string)
                await Scalar(
                    db,
                    "SELECT metadata FROM ld_records WHERE library_id=@p0 AND search_id=@p1 FOR UPDATE",
                    claim.Library,
                    article.SearchId
                )
        );
        current.FullTextMetadataXml = info.MetadataXml;
        current.ArticleNumber = info.ArticleNumber;
        current.EqualContribution = info.EqualContribution;
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
