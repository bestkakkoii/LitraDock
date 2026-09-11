using System;
using Microsoft.Data.Sqlite;

namespace LitraDock.Core
{
    // 僅隔離供應者 API 差異；SQL、交易順序與既有結構版本仍由共用核心負責。
    internal sealed class ModernConnection : IDisposable
    {
        internal SqliteConnection Inner { get; }
        internal SqliteTransaction Transaction { get; private set; }
        internal ModernConnection(string connectionString) { Inner = new SqliteConnection(connectionString); }
        internal void Open() { Inner.Open(); }
        internal SqliteTransaction BeginTransaction()
        {
            Transaction = Inner.BeginTransaction();
            return Transaction;
        }
        internal void BackupDatabase(ModernConnection destination, string target, string source, int pages, object callback, int retry)
        { Inner.BackupDatabase(destination.Inner, target, source); }
        public void Dispose() { Inner.Dispose(); }
    }
}
