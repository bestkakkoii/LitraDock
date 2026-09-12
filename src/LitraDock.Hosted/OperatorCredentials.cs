using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Npgsql;

namespace Literature.Service;

public sealed partial class PgStore
{
    public static Guid ValidateRotation(string accountId, string password)
    {
        if (!Guid.TryParseExact(accountId, "D", out var account) || account == Guid.Empty)
            throw new ArgumentException("A nonempty canonical account UUID is required.");
        if (password == null || password.Length is < 12 or > 256
            || string.IsNullOrWhiteSpace(password) || password.Any(char.IsControl))
            throw new ArgumentException("Password must contain 12–256 characters without control characters.");
        _ = new System.Text.UTF8Encoding(false, true).GetByteCount(password);
        return account;
    }

    public async Task<AccountControlResult> RotateCredential(string accountId, string password, CancellationToken cancellation = default)
    {
        var account = ValidateRotation(accountId, password);
        cancellation.ThrowIfCancellationRequested();
        // 維護鎖與帳號列鎖順序同帳號控制；登入也鎖同列，提交後不可能用舊密碼插入新工作階段。
        await using var admission = await ResourceAdmission.Enter(this, maintenance: true);
        await using var db = await Data.OpenConnectionAsync(cancellation);
        await using var tx = await db.BeginTransactionAsync(cancellation);
        async Task<int> Execute(string sql, params object[] values)
        {
            await using var cmd = new NpgsqlCommand(sql, db, tx);
            for (int i = 0; i < values.Length; i++) cmd.Parameters.AddWithValue("p" + i, values[i]);
            return await cmd.ExecuteNonQueryAsync(cancellation);
        }
        await Execute("SET LOCAL lock_timeout='3s'");
        string login;
        bool enabled;
        await using (var cmd = new NpgsqlCommand("SELECT login,enabled FROM ld_accounts WHERE account_id=@id FOR UPDATE", db, tx))
        {
            cmd.Parameters.AddWithValue("id", account);
            await using var reader = await cmd.ExecuteReaderAsync(cancellation);
            if (!await reader.ReadAsync(cancellation)) throw new KeyNotFoundException("Account does not exist.");
            login = reader.GetString(0);
            enabled = reader.GetBoolean(1);
        }
        var hash = new PasswordHasher<string>().HashPassword(login, password);
        await Execute("UPDATE ld_accounts SET password_hash=@p1 WHERE account_id=@p0", account, hash);
        var revoked = await Execute("DELETE FROM ld_sessions WHERE account_id=@p0", account);
        await tx.CommitAsync(cancellation);
        return new AccountControlResult(account, "rotate-credential", enabled, revoked);
    }
}

public static class OperatorCredentials
{
    public static async Task Run(string[] args)
    {
        string password = Environment.GetEnvironmentVariable("LITRADOCK_NEW_PASSWORD");
        // 僅接受環境中的秘密；立刻移除避免再傳給子程序，且不使用可由 argv 覆寫的設定提供者。
        Environment.SetEnvironmentVariable("LITRADOCK_NEW_PASSWORD", null);
        using var interrupted = new CancellationTokenSource();
        ConsoleCancelEventHandler cancel = (_, e) => { e.Cancel = true; interrupted.Cancel(); };
        Console.CancelKeyPress += cancel;
        using var terminate = OperatingSystem.IsWindows() ? null : PosixSignalRegistration.Create(PosixSignal.SIGTERM,
            context => { context.Cancel = true; interrupted.Cancel(); });
        try
        {
            if (args.Length != 1 || args[0] != "--rotate-credential"
                || Environment.GetEnvironmentVariable("LITRADOCK_SERVICE_STOPPED") != "yes")
                throw new ArgumentException("Use the stopped-service operator procedure.");
            var account = Environment.GetEnvironmentVariable("LITRADOCK_ACCOUNT_ID");
            PgStore.ValidateRotation(account, password);
            var connection = Environment.GetEnvironmentVariable("LITRADOCK_POSTGRES");
            var storage = Environment.GetEnvironmentVariable("LITRADOCK_OBJECTS");
            if (string.IsNullOrWhiteSpace(connection) || string.IsNullOrWhiteSpace(storage))
                throw new ArgumentException("Protected database and object configuration required.");
            await using var store = new PgStore(connection);
            var originals = new OriginalStore(storage);
            originals.VerifyPrivateRoot(Directory.GetCurrentDirectory());
            originals.VerifyWebRoot(Path.Combine(Directory.GetCurrentDirectory(), "wwwroot"));
            await store.VerifySchema();
            await store.VerifyOperational();
            var result = await store.RotateCredential(account, password, interrupted.Token);
            Console.WriteLine(JsonSerializer.Serialize(new { operation = "rotate_credential", outcome = "succeeded", result.Account, result.Enabled, result.Revoked }));
        }
        catch (Exception error)
        {
            // 提交途中斷線的結果可能不明；封閉原因碼不謊稱已回復，也不輸出例外、秘密或雜湊。
            var reason = error is ResourceBusyException ? "busy"
                : error is ArgumentException ? "invalid_input"
                : error is KeyNotFoundException ? "unknown_account"
                : error is PostgresException { SqlState: "55P03" } ? "contention"
                : error is OperationCanceledException ? "interrupted_or_commit_unconfirmed"
                : "database_failure_or_commit_unconfirmed";
            Console.Error.WriteLine(JsonSerializer.Serialize(new { operation = "rotate_credential", outcome = "failed", reason }));
            Environment.ExitCode = 1;
        }
        finally
        {
            password = null;
            Console.CancelKeyPress -= cancel;
        }
    }
}
