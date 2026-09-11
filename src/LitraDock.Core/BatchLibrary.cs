using System;
using System.Collections.Generic;
using System.Data;
#if MODERN_SQLITE
using SQLiteConnection = LitraDock.Core.ModernConnection;
using SQLiteConnectionStringBuilder = Microsoft.Data.Sqlite.SqliteConnectionStringBuilder;
#else
using System.Data.SQLite;
#endif
using System.IO;
using System.Linq;

namespace LitraDock.Core
{
    public sealed class ScopePage
    {
        public int Total { get; set; }
        public int Selected { get; set; }
        public List<Article> Articles { get; } = new List<Article>();
        public HashSet<string> SelectedIds { get; } = new HashSet<string>();
    }

    public sealed partial class Library
    {
        private static string Now => DateTime.UtcNow.ToString("o");

        private void EnsureBatchSchema()
        {
            using (var db = Open())
            {
                if (Convert.ToInt32(Scalar(db, "PRAGMA user_version")) >= 2) { return; }
                // 升級前透過 SQLite 線上備份取得一致快照；不以檔案複製假設 journal 已落盤。
                var backupPath = Path.Combine(Root, "schema-v1-backup-" + Guid.NewGuid().ToString("N") + ".sqlite3");
                using (var backup = new SQLiteConnection(new SQLiteConnectionStringBuilder { DataSource = backupPath, Pooling = false }.ConnectionString))
                { backup.Open(); db.BackupDatabase(backup, "main", "main", -1, null, 0); }
                using (var tx = db.BeginTransaction())
                {
                    Execute(db, @"
CREATE TABLE saved_scopes(scope_id TEXT PRIMARY KEY,parent_scope TEXT,source_run TEXT,description TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE scope_members(scope_id TEXT NOT NULL REFERENCES saved_scopes(scope_id),search_id TEXT NOT NULL REFERENCES articles(search_id),rank INTEGER NOT NULL,selected INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope_id,search_id));
CREATE INDEX idx_scope_rank ON scope_members(scope_id,rank);
CREATE TABLE batches(batch_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES saved_scopes(scope_id),state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,naming_template TEXT NOT NULL);
CREATE TABLE batch_items(item_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES batches(batch_id),search_id TEXT NOT NULL REFERENCES articles(search_id),ordinal INTEGER NOT NULL,state TEXT NOT NULL,last_job_id TEXT,reason TEXT NOT NULL,planned_name TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,UNIQUE(batch_id,search_id));
CREATE INDEX idx_batch_queue ON batch_items(batch_id,state,ordinal);
CREATE TABLE publication_intents(job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),search_id TEXT NOT NULL REFERENCES articles(search_id),stage_relative TEXT NOT NULL,object_relative TEXT NOT NULL,hash TEXT NOT NULL,source_uri TEXT NOT NULL,final_uri TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE artifact_names(search_id TEXT NOT NULL REFERENCES articles(search_id),hash TEXT NOT NULL REFERENCES files(hash),display_name TEXT NOT NULL,PRIMARY KEY(search_id,hash));
PRAGMA user_version=2;");
                    tx.Commit();
                }
            }
        }

        public string CreateScope(string runId = null, string parentScope = null, string text = "")
        {
            var scope = "SCOPE-" + Guid.NewGuid().ToString("N");
            using (var db = Open())
            using (var tx = db.BeginTransaction())
            {
                var inheritedRun = parentScope == null ? runId : Scalar(db, "SELECT source_run FROM saved_scopes WHERE scope_id=@p0", parentScope) as string;
                Execute(db, "INSERT INTO saved_scopes VALUES(@p0,@p1,@p2,@p3,@p4)", scope, parentScope, inheritedRun, text, Now);
                // 篩選固定為文字包含，不將使用者輸入當成 SQL 或 LIKE 萬用字元。
                var from = parentScope != null ? "scope_members m JOIN articles a ON a.search_id=m.search_id WHERE m.scope_id=@p1"
                    : runId != null ? "search_results m JOIN articles a ON a.search_id=m.search_id WHERE m.run_id=@p1"
                    : "articles a WHERE 1=1";
                var rank = parentScope != null ? "m.rank" : runId != null ? "m.source_rank" : "a.rowid";
                var needle = text.Trim().ToLowerInvariant();
                Execute(db, "INSERT INTO scope_members(scope_id,search_id,rank) SELECT @p0,a.search_id," + rank + " FROM " + from +
                    " AND (@p2='' OR instr(lower(a.title),@p2)>0 OR EXISTS(SELECT 1 FROM identifiers i WHERE i.search_id=a.search_id AND instr(lower(i.value),@p2)>0))", scope, parentScope ?? runId, needle);
                tx.Commit();
            }
            return scope;
        }

        public ScopePage ReadScope(string scopeId, int offset = 0, int pageSize = 50, string sort = "rank")
        {
            if (offset < 0 || pageSize < 1 || pageSize > 200) { throw new ArgumentOutOfRangeException(nameof(pageSize)); }
            var order = sort == "title" ? "a.title COLLATE NOCASE,m.rank" : "m.rank";
            var page = new ScopePage();
            using (var db = Open())
            {
                page.Total = Convert.ToInt32(Scalar(db, "SELECT count(*) FROM scope_members WHERE scope_id=@p0", scopeId));
                page.Selected = Convert.ToInt32(Scalar(db, "SELECT count(*) FROM scope_members WHERE scope_id=@p0 AND selected=1", scopeId));
                using (var command = Command(db, "SELECT a.metadata_xml,m.selected FROM scope_members m JOIN articles a ON a.search_id=m.search_id WHERE m.scope_id=@p0 ORDER BY " + order + " LIMIT @p1 OFFSET @p2", scopeId, pageSize, offset))
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var article = Deserialize(reader.GetString(0));
                        page.Articles.Add(article);
                        if (reader.GetInt32(1) == 1) { page.SelectedIds.Add(article.SearchId); }
                    }
                }
            }
            return page;
        }

        public void SelectInScope(string scopeId, string searchId, bool selected)
        {
            using (var db = Open())
            { Execute(db, "UPDATE scope_members SET selected=@p2 WHERE scope_id=@p0 AND search_id=@p1", scopeId, searchId, selected ? 1 : 0); }
        }

        public void SelectAllInScope(string scopeId, bool selected)
        {
            using (var db = Open())
            { Execute(db, "UPDATE scope_members SET selected=@p1 WHERE scope_id=@p0", scopeId, selected ? 1 : 0); }
        }

        public void SelectPage(string scope, IEnumerable<string> pageIds, IEnumerable<string> selectedIds)
        {
            var selected = new HashSet<string>(selectedIds);
            using (var db = Open())
            using (var tx = db.BeginTransaction())
            {
                foreach (var id in pageIds) { Execute(db, "UPDATE scope_members SET selected=@p2 WHERE scope_id=@p0 AND search_id=@p1", scope, id, selected.Contains(id) ? 1 : 0); }
                tx.Commit();
            }
        }

        public List<string> ScopeIds(string scope, bool selectedOnly = false)
        {
            using (var db = Open())
            using (var command = Command(db, "SELECT search_id FROM scope_members WHERE scope_id=@p0" + (selectedOnly ? " AND selected=1" : "") + " ORDER BY rank", scope))
            using (var reader = command.ExecuteReader())
            { var ids = new List<string>(); while (reader.Read()) { ids.Add(reader.GetString(0)); } return ids; }
        }

        public DataTable BatchItemsPage(string batch, int offset = 0)
        {
            using (var db = Open())
            using (var command = Command(db, "SELECT b.ordinal,b.item_id,b.search_id,a.title,(SELECT value FROM identifiers i WHERE i.search_id=b.search_id AND i.kind='pmid') AS pmid,b.state,b.attempts,b.reason,b.planned_name,b.last_job_id FROM batch_items b JOIN articles a ON a.search_id=b.search_id WHERE b.batch_id=@p0 ORDER BY b.ordinal LIMIT 100 OFFSET @p1", batch, Math.Max(0, offset)))
            using (var reader = command.ExecuteReader())
            { var rows = new DataTable(); rows.Load(reader); return rows; }
        }

        public string BatchCounts(string batch)
        {
            using (var db = Open())
            using (var command = Command(db, "SELECT state,count(*) FROM batch_items WHERE batch_id=@p0 GROUP BY state ORDER BY state", batch))
            using (var reader = command.ExecuteReader())
            { var values = new List<string>(); while (reader.Read()) { values.Add(reader.GetString(0) + ": " + reader.GetInt64(1)); } return string.Join("; ", values); }
        }

        public DataTable BatchTable(string table, string batchId = null)
        {
            if (!new[] { "saved_scopes", "batches", "batch_items", "publication_intents", "artifact_names" }.Contains(table)) { throw new ArgumentException("Unknown batch table."); }
            using (var db = Open())
            using (var command = batchId == null ? Command(db, "SELECT * FROM " + table)
                : Command(db, "SELECT * FROM batch_items WHERE batch_id=@p0 ORDER BY ordinal", batchId))
            using (var reader = command.ExecuteReader())
            { var result = new DataTable(table); result.Load(reader); return result; }
        }

        public string ScopeDescription(string scope)
        {
            using (var db = Open())
            using (var command = Command(db, "SELECT s.description,r.total,r.fetched,r.state FROM saved_scopes s LEFT JOIN search_runs r ON r.run_id=s.source_run WHERE s.scope_id=@p0", scope))
            using (var reader = command.ExecuteReader())
            {
                if (!reader.Read()) { return "Unknown scope"; }
                return reader.IsDBNull(1) ? "Saved local library snapshot. " + reader.GetString(0)
                    : "Source fetched " + reader[2] + " / " + reader[1] + " (" + reader[3] + "). " + reader.GetString(0);
            }
        }

        public string CreateBatch(string scope, bool selectedOnly, string template = Naming.DefaultTemplate)
        {
            Naming.ValidateTemplate(template);
            var batch = "BATCH-" + Guid.NewGuid().ToString("N");
            using (var db = Open())
            using (var tx = db.BeginTransaction())
            {
                Execute(db, "INSERT INTO batches VALUES(@p0,@p1,'queued',@p2,@p2,@p3)", batch, scope, Now, template);
                var count = 0;
                using (var command = Command(db, "SELECT a.search_id,a.metadata_xml FROM scope_members m JOIN articles a ON a.search_id=m.search_id WHERE m.scope_id=@p0" + (selectedOnly ? " AND m.selected=1" : "") + " ORDER BY m.rank", scope))
                using (var reader = command.ExecuteReader())
                {
                    // 逐筆讀取中繼資料，寫入另一張表；不將整個文庫的 XML 留在記憶體。
                    while (reader.Read())
                    {
                        Execute(db, "INSERT INTO batch_items VALUES(@p0,@p1,@p2,@p3,'queued',NULL,'',@p4,0)",
                            "ITEM-" + Guid.NewGuid().ToString("N"), batch, reader.GetString(0), ++count, Naming.Preview(Deserialize(reader.GetString(1)), template));
                    }
                }
                if (count == 0) { throw new ArgumentException("The requested batch scope is empty."); }
                tx.Commit();
            }
            return batch;
        }

        public string BatchState(string batch)
        { using (var db = Open()) { return (string)Scalar(db, "SELECT state FROM batches WHERE batch_id=@p0", batch); } }

        public void ControlBatch(string batch, string action, string itemId = null)
        {
            if (!new[] { "paused", "cancelled", "resume", "retry", "running" }.Contains(action)) { throw new ArgumentException("Unknown batch action."); }
            using (var db = Open())
            using (var tx = db.BeginTransaction())
            {
                var old = (string)Scalar(db, "SELECT state FROM batches WHERE batch_id=@p0", batch);
                if (old == null) { throw new ArgumentException("Batch does not exist."); }
                if ((action == "paused" || action == "cancelled") && (old == "completed" || old == "completed_with_errors"))
                { throw new InvalidOperationException("This batch has already settled; retry eligible items instead."); }
                if (action == "running" && old != "queued") { throw new InvalidOperationException("Resume or retry the saved batch before starting it."); }
                if (action == "resume" && old != "paused") { throw new InvalidOperationException("Only a paused batch can resume."); }
                if (action == "retry" && old == "running") { throw new InvalidOperationException("Wait for the active batch before retrying."); }
                var state = action == "resume" || action == "retry" ? "queued" : action;
                if (action == "resume") { Execute(db, "UPDATE batch_items SET state='queued',reason='Resume requested.' WHERE batch_id=@p0 AND state='paused'", batch); }
                if (action == "retry")
                {
                    Execute(db, "UPDATE batch_items SET state='queued',reason='Explicit retry requested.' WHERE batch_id=@p0 AND state IN ('failed','unavailable','needs_login','cancelled','paused')" + (itemId == null ? "" : " AND item_id=@p1"), batch, itemId);
                }
                if (action == "cancelled") { Execute(db, "UPDATE batch_items SET state='cancelled',reason='Batch cancelled before attempt.' WHERE batch_id=@p0 AND state IN ('queued','paused')", batch); }
                Execute(db, "UPDATE batches SET state=@p1,updated_at=@p2 WHERE batch_id=@p0", batch, state, Now);
                Execute(db, "INSERT INTO activity(state,reason,occurred_at) VALUES(@p0,@p1,@p2)", state, "Batch " + batch + ": " + action, Now);
                tx.Commit();
            }
        }

        public Tuple<string, string, string> NextAttempt(string batch)
        {
            using (var db = Open())
            using (var tx = db.BeginTransaction())
            {
                if ((string)Scalar(db, "SELECT state FROM batches WHERE batch_id=@p0", batch) != "running") { return null; }
                string item = null, article = null;
                using (var command = Command(db, "SELECT item_id,search_id FROM batch_items WHERE batch_id=@p0 AND state='queued' ORDER BY ordinal LIMIT 1", batch))
                using (var reader = command.ExecuteReader())
                { if (reader.Read()) { item = reader.GetString(0); article = reader.GetString(1); } }
                if (item == null) { return null; }
                var job = "JOB-" + Guid.NewGuid().ToString("N");
                Execute(db, "INSERT INTO jobs VALUES(@p0,@p1,'resolving','Batch attempt started.',@p2)", job, article, Now);
                Execute(db, "UPDATE batch_items SET state='resolving',last_job_id=@p1,attempts=attempts+1,reason='Batch attempt started.' WHERE item_id=@p0", item, job);
                Execute(db, "INSERT INTO activity(job_id,search_id,state,reason,occurred_at) VALUES(@p0,@p1,'resolving','Batch attempt started.',@p2)", job, article, Now);
                tx.Commit();
                return Tuple.Create(item, article, job);
            }
        }

        public void FinishBatch(string batch)
        {
            using (var db = Open())
            {
                var remaining = Convert.ToInt32(Scalar(db, "SELECT count(*) FROM batch_items WHERE batch_id=@p0 AND state IN ('queued','resolving','redirecting','waiting','downloading','validating','publishing','paused')", batch));
                if (remaining != 0) { return; }
                var errors = Convert.ToInt32(Scalar(db, "SELECT count(*) FROM batch_items WHERE batch_id=@p0 AND state!='completed'", batch));
                Execute(db, "UPDATE batches SET state=@p1,updated_at=@p2 WHERE batch_id=@p0 AND state='running'", batch, errors == 0 ? "completed" : "completed_with_errors", Now);
            }
        }

        private void RecoverBatches()
        {
            using (var db = Open())
            using (var tx = db.BeginTransaction())
            {
                Execute(db, "UPDATE batch_items SET state='paused',reason='Interrupted before durable completion; resume explicitly.' WHERE state IN ('resolving','redirecting','waiting','downloading','validating','publishing')");
                Execute(db, "UPDATE batches SET state='paused',updated_at=@p0 WHERE state='running'", Now);
                tx.Commit();
            }
        }

        public string PageQueryPlan(string scope)
        {
            using (var db = Open())
            using (var command = Command(db, "EXPLAIN QUERY PLAN SELECT a.metadata_xml FROM scope_members m JOIN articles a ON a.search_id=m.search_id WHERE m.scope_id=@p0 ORDER BY m.rank LIMIT 50 OFFSET 1000", scope))
            using (var reader = command.ExecuteReader())
            { var lines = new List<string>(); while (reader.Read()) { lines.Add(reader.GetString(3)); } return string.Join("; ", lines); }
        }
    }
}
