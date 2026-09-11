using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LitraDock.Core;
using Microsoft.AspNetCore.Identity;
using Npgsql;

namespace Literature.Service;

public sealed partial class PgStore : IAsyncDisposable
{
    internal readonly NpgsqlDataSource Data;

    public PgStore(string connection)
    {
        var config = new NpgsqlConnectionStringBuilder(connection)
        {
            IncludeErrorDetail = false,
            MaxPoolSize = 12,
            Timeout = 5,
            CommandTimeout = 15,
        };
        if (
            config.Host is not ("127.0.0.1" or "localhost" or "::1")
            && config.SslMode != SslMode.VerifyFull
        )
            throw new ArgumentException(
                "Remote PostgreSQL requires certificate and hostname verification."
            );
        Data = NpgsqlDataSource.Create(config.ConnectionString);
    }

    public ValueTask DisposeAsync() => Data.DisposeAsync();

    internal static NpgsqlCommand Cmd(NpgsqlConnection db, string sql, params object[] values)
    {
        var cmd = new NpgsqlCommand(sql, db);
        for (var i = 0; i < values.Length; i++)
            cmd.Parameters.AddWithValue("p" + i, values[i] ?? DBNull.Value);
        return cmd;
    }

    internal static async Task<int> Exec(NpgsqlConnection db, string sql, params object[] values)
    {
        await using var cmd = Cmd(db, sql, values);
        return await cmd.ExecuteNonQueryAsync();
    }

    internal static async Task<object> Scalar(
        NpgsqlConnection db,
        string sql,
        params object[] values
    )
    {
        await using var cmd = Cmd(db, sql, values);
        return await cmd.ExecuteScalarAsync();
    }

    internal static async Task<List<Dictionary<string, object>>> Rows(
        NpgsqlConnection db,
        string sql,
        params object[] values
    )
    {
        await using var cmd = Cmd(db, sql, values);
        await using var reader = await cmd.ExecuteReaderAsync();
        var result = new List<Dictionary<string, object>>();
        while (await reader.ReadAsync())
            result.Add(
                Enumerable
                    .Range(0, reader.FieldCount)
                    .ToDictionary(
                        reader.GetName,
                        i => reader.IsDBNull(i) ? null : reader.GetValue(i)
                    )
            );
        return result;
    }

    public async Task Migrate()
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(724913001)");
        if (await Scalar(db, "SELECT to_regclass('public.ld_schema')::text") is DBNull or null)
        {
            using var stream = typeof(PgStore).Assembly.GetManifestResourceStream(
                "LitraDock.Hosted.migrations.001.sql"
            );
            using var text = new StreamReader(stream);
            await Exec(db, await text.ReadToEndAsync());
        }
        if (Convert.ToInt32(await Scalar(db, "SELECT max(version) FROM ld_schema")) == 1)
        {
            using var upgrade = typeof(PgStore).Assembly.GetManifestResourceStream(
                "LitraDock.Hosted.migrations.002.sql"
            );
            using var upgradeText = new StreamReader(upgrade);
            await Exec(db, await upgradeText.ReadToEndAsync());
        }
        if (Convert.ToInt32(await Scalar(db, "SELECT max(version) FROM ld_schema")) != 2)
            throw new InvalidOperationException("Unsupported hosted schema.");
        await tx.CommitAsync();
    }

    public async Task VerifySchema()
    {
        await using var db = await Data.OpenConnectionAsync();
        if (Convert.ToInt32(await Scalar(db, "SELECT max(version) FROM ld_schema")) != 2)
            throw new InvalidOperationException("Run the reviewed schema migration first.");
    }

    public static string Token() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    public static string Digest(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    public static bool Equal(string a, string b) =>
        a != null
        && b != null
        && CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(a),
            Encoding.UTF8.GetBytes(b)
        );

    public async Task<Guid> CreateAccount(string login, string password)
    {
        login = login.Trim().ToLowerInvariant();
        if (login.Length is < 3 or > 120 || password.Length is < 12 or > 256)
            throw new ArgumentException("Login or password length is invalid.");
        var id = Guid.NewGuid();
        var hash = new PasswordHasher<string>().HashPassword(login, password);
        await using var db = await Data.OpenConnectionAsync();
        await Exec(
            db,
            "INSERT INTO ld_accounts VALUES(@p0,@p1,@p2,true)",
            id,
            login.Trim().ToLowerInvariant(),
            hash
        );
        return id;
    }

    public async Task<(string Token, Session Session)?> Login(string login, string password)
    {
        if (login.Length > 120 || password.Length > 256)
            return null;
        await using var db = await Data.OpenConnectionAsync();
        var account = (
            await Rows(
                db,
                "SELECT account_id,password_hash FROM ld_accounts WHERE login=@p0 AND enabled",
                login.Trim().ToLowerInvariant()
            )
        ).SingleOrDefault();
        // 不在日誌輸出帳密或雜湊；不存在的帳號也執行同成本雜湊以降低列舉訊號。
        var hasher = new PasswordHasher<string>();
        if (account == null)
        {
            hasher.HashPassword("missing", password);
            return null;
        }
        var result = hasher.VerifyHashedPassword(login, (string)account["password_hash"], password);
        if (result == PasswordVerificationResult.Failed)
            return null;
        var token = Token();
        var session = new Session((Guid)account["account_id"], Token(), Digest(token));
        await Exec(
            db,
            "INSERT INTO ld_sessions VALUES(@p0,@p1,@p2,now()+interval '8 hours')",
            session.Hash,
            session.Account,
            session.Csrf
        );
        await Exec(db, "DELETE FROM ld_sessions WHERE expires_at<now()");
        return (token, session);
    }

    public async Task<Session> Authenticate(string token)
    {
        if (token == null || token.Length != 64)
            return null;
        await using var db = await Data.OpenConnectionAsync();
        var row = (
            await Rows(
                db,
                "SELECT s.account_id,s.csrf FROM ld_sessions s JOIN ld_accounts a USING(account_id) WHERE token_hash=@p0 AND expires_at>now() AND a.enabled",
                Digest(token)
            )
        ).SingleOrDefault();
        return row == null
            ? null
            : new Session((Guid)row["account_id"], (string)row["csrf"], Digest(token));
    }

    public async Task Revoke(Session session)
    {
        await using var db = await Data.OpenConnectionAsync();
        await Exec(db, "DELETE FROM ld_sessions WHERE token_hash=@p0", session.Hash);
    }

    public async Task<Guid> CreateLibrary(Guid account, string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 120)
            throw new ArgumentException("Library name must be 1–120 characters.");
        var id = Guid.NewGuid();
        await using var db = await Data.OpenConnectionAsync();
        await Exec(db, "INSERT INTO ld_libraries VALUES(@p0,@p1,@p2,true)", id, account, name);
        return id;
    }

    public async Task<bool> Owns(Guid account, Guid library)
    {
        await using var db = await Data.OpenConnectionAsync();
        return (bool)
            await Scalar(
                db,
                "SELECT EXISTS(SELECT 1 FROM ld_libraries WHERE library_id=@p0 AND owner_id=@p1 AND ready)",
                library,
                account
            );
    }

    public async Task<object> Libraries(Guid account, int offset = 0)
    {
        if (offset < 0 || offset > 1000000)
            throw new ArgumentException("Invalid catalog offset.");
        await using var db = await Data.OpenConnectionAsync();
        return new
        {
            items = await Rows(
                db,
                "SELECT library_id,name FROM ld_libraries WHERE owner_id=@p0 AND ready ORDER BY library_id LIMIT 100 OFFSET @p1",
                account,
                offset
            ),
            total = await Scalar(
                db,
                "SELECT count(*) FROM ld_libraries WHERE owner_id=@p0 AND ready",
                account
            ),
            offset,
            limit = 100,
        };
    }

    public async Task<Article> Article(Guid library, string id)
    {
        await using var db = await Data.OpenConnectionAsync();
        var json =
            await Scalar(
                db,
                "SELECT metadata FROM ld_records WHERE library_id=@p0 AND search_id=@p1",
                library,
                id
            ) as string;
        return json == null
            ? throw new KeyNotFoundException()
            : JsonSerializer.Deserialize<Article>(json);
    }

    public async Task<object> Catalog(Guid library, int offset = 0)
    {
        if (offset < 0 || offset > 1000000)
            throw new ArgumentException("Invalid catalog offset.");
        await using var db = await Data.OpenConnectionAsync();
        return new
        {
            runs = await Rows(
                db,
                "SELECT run_id,input,total,fetched,state,reason FROM ld_runs WHERE library_id=@p0 ORDER BY run_id LIMIT 100 OFFSET @p1",
                library,
                offset
            ),
            scopes = await Rows(
                db,
                "SELECT * FROM ld_scopes WHERE library_id=@p0 ORDER BY scope_id LIMIT 100 OFFSET @p1",
                library,
                offset
            ),
            batches = await Rows(
                db,
                "SELECT * FROM ld_batches WHERE library_id=@p0 ORDER BY batch_id LIMIT 100 OFFSET @p1",
                library,
                offset
            ),
            totals = new
            {
                runs = await Scalar(
                    db,
                    "SELECT count(*) FROM ld_runs WHERE library_id=@p0",
                    library
                ),
                scopes = await Scalar(
                    db,
                    "SELECT count(*) FROM ld_scopes WHERE library_id=@p0",
                    library
                ),
                batches = await Scalar(
                    db,
                    "SELECT count(*) FROM ld_batches WHERE library_id=@p0",
                    library
                ),
            },
            offset,
            limit = 100,
        };
    }
}

public sealed record Session(Guid Account, string Csrf, string Hash);

public sealed record Claim(
    Guid Library,
    string Job,
    string Kind,
    string Run,
    string Item,
    string SearchId,
    Guid Lease
);
