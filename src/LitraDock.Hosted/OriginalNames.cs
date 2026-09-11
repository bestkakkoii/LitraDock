using LitraDock.Core;

namespace Literature.Service;

public sealed partial class PgStore
{
    public async Task<string> OriginalName(Guid library, string id, string hash, string kind)
    {
        if (!await Associated(library, id, hash))
            throw new KeyNotFoundException();
        await using var db = await Data.OpenConnectionAsync();
        var rows = await Rows(
            db,
            "SELECT b.template FROM ld_object_provenance p JOIN ld_jobs j USING(library_id,job_id) JOIN ld_items i USING(library_id,item_id) JOIN ld_batches b USING(library_id,batch_id) WHERE p.library_id=@p0 AND p.search_id=@p1 AND p.hash=@p2 ORDER BY j.created_at DESC LIMIT 1",
            library,
            id,
            hash
        );
        var template = rows.Count == 0 ? Naming.DefaultTemplate : (string)rows[0]["template"];
        var preview = Naming.Preview(await Article(library, id), template);
        return Path.GetFileNameWithoutExtension(preview)
            + "_"
            + hash[..8]
            + OriginalValidation.Extension(kind);
    }
}
