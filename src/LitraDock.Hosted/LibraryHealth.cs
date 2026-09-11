using System.Security.Cryptography;

namespace Literature.Service;

public sealed partial class PgStore
{
    public async Task<object> InspectHealth(Guid library, OriginalStore originals, int offset = 0)
    {
        if (offset < 0 || offset > OriginalStore.EntryLimit)
            throw new ArgumentException("Invalid health offset.");
        await using var db = await Data.OpenConnectionAsync();
        var expected = new Dictionary<string, string>(StringComparer.Ordinal);
        var files = await Rows(
            db,
            "SELECT hash,kind FROM ld_files WHERE library_id=@p0 LIMIT 10001",
            library
        );
        if (files.Count > 10000)
            throw new IOException("Health reference limit exceeded; no truncation.");
        foreach (var file in files)
            expected[
                "objects/"
                    + ((string)file["hash"]).ToLowerInvariant()
                    + ((string)file["kind"] == OriginalValidation.PdfKind ? ".pdf" : ".xml")
            ] = (string)file["hash"];
        var manual = await Rows(
            db,
            "SELECT m.stage_token,m.hash FROM ld_manual_inputs m JOIN ld_jobs j USING(library_id,job_id) WHERE m.library_id=@p0 AND j.state<>'completed' LIMIT 10001",
            library
        );
        if (manual.Count > 10000)
            throw new IOException("Health staging reference limit exceeded.");
        foreach (var input in manual)
        {
            if (!Guid.TryParseExact((string)input["stage_token"], "N", out _))
                throw new IOException("Unsafe stored staging reference.");
            expected["staging/" + input["stage_token"] + ".part"] = (string)input["hash"];
        }
        var root = Path.Combine(originals.Root, library.ToString("N"));
        var physical = new SortedSet<string>(expected.Keys, StringComparer.Ordinal);
        var pending = new Stack<string>();
        if (Directory.Exists(root))
            pending.Push(root);
        int entries = 0;
        long physicalBytes = 0;
        while (pending.Count > 0)
            foreach (var path in Directory.EnumerateFileSystemEntries(pending.Pop()))
            {
                if (++entries > OriginalStore.EntryLimit)
                    throw new IOException("Health filesystem inventory limit reached.");
                var attrs = File.GetAttributes(path);
                if ((attrs & FileAttributes.ReparsePoint) != 0)
                {
                    physical.Add(Path.GetRelativePath(root, path).Replace('\\', '/'));
                    continue;
                }
                if ((attrs & FileAttributes.Directory) != 0)
                    pending.Push(path);
                else
                {
                    physical.Add(Path.GetRelativePath(root, path).Replace('\\', '/'));
                    physicalBytes = checked(physicalBytes + new FileInfo(path).Length);
                }
            }
        var rows = new List<object>();
        long scanned = 0;
        int processed = 0;
        foreach (var relative in physical.Skip(offset).Take(50))
        {
            if (scanned >= 128L * 1024 * 1024)
                break;
            var path = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            expected.TryGetValue(relative, out var hash);
            string state,
                actual = null,
                reason;
            long length = 0;
            try
            {
                if (!File.Exists(path))
                {
                    state = "missing";
                    reason = "Referenced bytes are absent.";
                }
                else if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                {
                    state = "unsafe_link";
                    reason = "Linked entry retained without following it.";
                }
                else
                {
                    length = new FileInfo(path).Length;
                    if (hash == null)
                    {
                        state = "unreferenced";
                        reason =
                            "Unknown, staging or retained transfer bytes preserved; no automatic deletion.";
                    }
                    else if (length > 32L * 1024 * 1024)
                    {
                        state = "corrupt";
                        reason = "Referenced file exceeds its supported validation bound.";
                    }
                    else
                    {
                        using var stream = new FileStream(
                            path,
                            FileMode.Open,
                            FileAccess.Read,
                            FileShare.Read
                        );
                        actual = Convert.ToHexString(SHA256.HashData(stream));
                        scanned += length;
                        state = actual.Equals(hash, StringComparison.OrdinalIgnoreCase)
                            ? "valid"
                            : "corrupt";
                        reason =
                            state == "valid"
                                ? "Exact referenced bytes verified."
                                : "Hash differs; original preserved for review.";
                    }
                }
            }
            catch (IOException)
            {
                state = "unreadable";
                reason = "File could not be read; retained for review.";
            }
            await Exec(
                db,
                "INSERT INTO ld_health VALUES(@p0,@p1,@p2,@p3,@p4,@p5,now(),@p6) ON CONFLICT(library_id,path) DO UPDATE SET state=excluded.state,expected_hash=excluded.expected_hash,actual_hash=excluded.actual_hash,bytes=excluded.bytes,checked_at=excluded.checked_at,reason=excluded.reason",
                library,
                relative,
                state,
                hash,
                actual,
                length,
                reason
            );
            if (state is "missing" or "corrupt" or "unreadable")
            {
                await Event(
                    db,
                    library,
                    null,
                    "file_" + state,
                    relative + ": " + reason + " Expected " + hash + "; observed " + actual
                );
                await Exec(
                    db,
                    "UPDATE ld_items SET state='missing_file',reason='File health requires review; record and original evidence retained.' WHERE library_id=@p0 AND state='completed' AND search_id IN (SELECT search_id FROM ld_article_files WHERE library_id=@p0 AND hash=@p1)",
                    library,
                    hash
                );
            }
            rows.Add(
                new
                {
                    path = relative,
                    state,
                    expectedHash = hash,
                    actualHash = actual,
                    bytes = length,
                    reason,
                }
            );
            processed++;
        }
        await Exec(
            db,
            "UPDATE ld_batches b SET state='completed_with_errors' WHERE b.library_id=@p0 AND b.state='completed' AND EXISTS(SELECT 1 FROM ld_items i WHERE i.library_id=b.library_id AND i.batch_id=b.batch_id AND i.state='missing_file')",
            library
        );
        return new
        {
            total = physical.Count,
            offset,
            nextOffset = offset + processed < physical.Count ? offset + processed : 0,
            processed,
            scannedBytes = scanned,
            physicalBytes,
            libraryLimit = OriginalStore.LibraryLimit,
            items = rows,
        };
    }
}
