using System;
using System.IO;
using System.Linq;
using Microsoft.Data.Sqlite;

namespace LitraDock.Core
{
    public static class LibraryTransfer
    {
        // 操作者必須關閉舊版桌面程式；兩個檔案鎖排除已知的新服務與批次寫入者。
        // 永遠建立新目錄，失敗保留不完整副本供檢查，不覆寫來源或既有目的地。
        public static void CopyStoppedLibrary(string source, string destination, Action<string> afterFile = null)
        {
            source = Path.GetFullPath(source); destination = Path.GetFullPath(destination);
            if (!File.Exists(Path.Combine(source, "library.sqlite3"))) { throw new IOException("Source library database is missing."); }
            if (Directory.Exists(destination) || File.Exists(destination)) { throw new IOException("Destination must not exist."); }
            if (destination.StartsWith(source.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            { throw new IOException("Destination must be outside the source library."); }
            using (var host = new FileStream(Path.Combine(source, "web-host.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            using (var batch = new FileStream(Path.Combine(source, "batch.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            {
                Directory.CreateDirectory(destination);
                using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(source, "library.sqlite3"), Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ConnectionString))
                using (var backup = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(destination, "library.sqlite3"), Pooling = false }.ConnectionString))
                {
                    db.Open(); backup.Open(); db.BackupDatabase(backup);
                }
                foreach (var folder in new[] { "objects", "staging", "quarantine" })
                {
                    var original = Path.Combine(source, folder);
                    if (!Directory.Exists(original)) { continue; }
                    CopyDirectory(original, Path.Combine(destination, folder), afterFile);
                }
                File.WriteAllText(Path.Combine(destination, "migration-complete.txt"), "Copied stopped library; schema and identities unchanged. " + DateTime.UtcNow.ToString("o"));
            }
        }

        private static void CopyDirectory(string source, string destination, Action<string> afterFile)
        {
            if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) { throw new IOException("Migration does not follow links."); }
            Directory.CreateDirectory(destination);
            foreach (var file in Directory.EnumerateFiles(source))
            {
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) { throw new IOException("Migration does not follow links."); }
                var target = Path.Combine(destination, Path.GetFileName(file)); File.Copy(file, target, false);
                using (var a = File.OpenRead(file))
                using (var b = File.OpenRead(target))
                using (var sha = System.Security.Cryptography.SHA256.Create())
                { if (!sha.ComputeHash(a).SequenceEqual(sha.ComputeHash(b))) { throw new IOException("Copied file hash mismatch."); } }
                afterFile?.Invoke(target);
            }
            foreach (var directory in Directory.EnumerateDirectories(source)) { CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)), afterFile); }
        }
    }
}
