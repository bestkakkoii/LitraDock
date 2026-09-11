using Npgsql;

namespace Literature.Service;

public sealed class ResourceBusyException()
    : IOException("Service resource capacity is in use; retry shortly.");

// 連線存活即持有鎖；程序結束由 PostgreSQL 釋放，不靠租約到期允許舊程序繼續寫入。
public sealed class ResourceAdmission : IAsyncDisposable
{
    private readonly NpgsqlConnection connection;
    private readonly bool heavy;
    private readonly bool maintenance;

    private ResourceAdmission(NpgsqlConnection db, bool heavy, bool maintenance)
    {
        connection = db;
        this.heavy = heavy;
        this.maintenance = maintenance;
    }

    public static async Task<ResourceAdmission> Enter(
        PgStore store,
        bool heavy = false,
        bool maintenance = false
    )
    {
        var db = await store.Data.OpenConnectionAsync();
        try
        {
            var lockSql = maintenance ? "pg_try_advisory_lock" : "pg_try_advisory_lock_shared";
            if (!(bool)await PgStore.Scalar(db, $"SELECT {lockSql}(724913010)"))
                throw new ResourceBusyException();
            if (heavy && !(bool)await PgStore.Scalar(db, "SELECT pg_try_advisory_lock(724913011)"))
                throw new ResourceBusyException();
            return new ResourceAdmission(db, heavy, maintenance);
        }
        catch
        {
            try
            {
                await PgStore.Exec(db, "SELECT pg_advisory_unlock_all()");
            }
            catch
            {
                NpgsqlConnection.ClearPool(db);
            }
            finally
            {
                await db.DisposeAsync();
            }
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await PgStore.Exec(connection, "SELECT pg_advisory_unlock_all()");
        }
        catch
        {
            NpgsqlConnection.ClearPool(connection);
        }
        finally
        {
            await connection.DisposeAsync();
        }
    }
}

public sealed partial class OriginalStore
{
    public const long LibraryLimit = 1024L * 1024 * 1024;
    public const long DeploymentLimit = 8L * 1024 * 1024 * 1024;
    public const int EntryLimit = 20000;

    public long Measure(Guid? library = null)
    {
        var root = library.HasValue ? Path.Combine(Root, library.Value.ToString("N")) : Root;
        if (!Directory.Exists(root))
            return 0;
        long total = 0;
        int count = 0;
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0)
            foreach (var path in Directory.EnumerateFileSystemEntries(pending.Pop()))
            {
                if (++count > EntryLimit)
                    throw new IOException(
                        "Storage inventory limit reached; operator review required."
                    );
                var attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Linked storage entry requires operator review.");
                if ((attributes & FileAttributes.Directory) != 0)
                    pending.Push(path);
                else
                    total = checked(total + new FileInfo(path).Length);
            }
        return total;
    }

    public void Admit(Guid library, long reservation)
    {
        if (
            reservation < 0
            || Measure(library) + reservation > LibraryLimit
            || Measure() + reservation > DeploymentLimit
        )
            throw new IOException(
                "Storage capacity reached; no original removed. Review library storage before retrying."
            );
        var drive = new DriveInfo(Path.GetPathRoot(Root));
        if (drive.AvailableFreeSpace < reservation + 64L * 1024 * 1024)
            throw new IOException("Insufficient free disk space for safe staging.");
    }
}
