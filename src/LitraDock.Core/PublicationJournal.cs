using System;
using System.Data;
using System.Collections.Generic;
using System.IO;

namespace LitraDock.Core
{
    public enum PublicationPoint { BeforeStageWrite, AfterStageWrite, AfterPublish, DuringAttach, AfterAttach }

    public sealed class InterruptedProcessException : Exception
    {
        public InterruptedProcessException() : base("Injected process interruption.") { }
    }

    public sealed partial class Library
    {
        public bool IsKnownHash(string searchId, string hash)
        { using (var db = Open()) { return Convert.ToInt32(Scalar(db, "SELECT count(*) FROM article_files WHERE search_id=@p0 AND hash=@p1", searchId, hash)) > 0; } }

        public void RecordNamedExport(string searchId, string hash, string name)
        {
            using (var db = Open())
            using (var tx = db.BeginTransaction())
            {
                Execute(db, "INSERT OR REPLACE INTO artifact_names VALUES(@p0,@p1,@p2)", searchId, hash, name);
                Execute(db, "INSERT INTO activity(search_id,state,reason,occurred_at) VALUES(@p0,'exported',@p1,@p2)", searchId, "Original source XML exported as " + name, Now);
                tx.Commit();
            }
        }

        internal string PreparePublication(string job, Article article, ArtifactInfo info, SourceResponse source)
        {
            var stage = Path.Combine("staging", job + ".xml.part");
            using (var db = Open())
            { Execute(db, "INSERT INTO publication_intents VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,'prepared',@p7)", job, article.SearchId, stage, info.RelativePath, info.Hash, source.OriginalUri, source.FinalUri, Now); }
            return Path.Combine(Root, stage);
        }

        internal void PublicationState(string job, string state)
        { using (var db = Open()) { Execute(db, "UPDATE publication_intents SET state=@p1,updated_at=@p2 WHERE job_id=@p0", job, state, Now); } }

        internal string LocalPath(string relative)
        {
            // 舊 Windows 文庫可能儲存反斜線；跨平台讀取時正規化分隔符，並使用平台適當的大小寫比較。
            relative = relative.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar);
            var path = Path.GetFullPath(Path.Combine(Root, relative));
            var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (!path.StartsWith(Root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, comparison))
            { throw new IOException("Stored path escapes the managed library."); }
            return path;
        }

        internal void PublishStaged(string stage, string destination, string hash)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            if (File.Exists(destination))
            {
                if (new FileInfo(destination).Length <= NcbiTransport.MaximumBytes && Artifacts.Hash(Artifacts.ReadBoundedFile(destination)) == hash)
                { if (File.Exists(stage)) { File.Delete(stage); } return; }
                // 損壞版本先隔離保留；從不以新下載覆寫損壞原檔，也不將損壞內容視為已完成。
                var quarantine = Path.Combine(Root, "quarantine");
                Directory.CreateDirectory(quarantine);
                File.Move(destination, Path.Combine(quarantine, hash + "-" + Guid.NewGuid().ToString("N") + ".corrupt"));
            }
            File.Move(stage, destination);
        }

        internal void RecoverPublications(bool includeStopped = false, string batch = null, Action<string> progress = null)
        {
            var count = 0;
            foreach (DataRow intent in RecoveryRows("publication_intents", "state NOT IN ('completed','needs_retry')"))
            {
                progress?.Invoke("Checking interrupted publication " + (++count) + "; original files are retained...");
                var job = (string)intent["job_id"];
                if ((string)intent["state"] == "completed" || (string)intent["state"] == "needs_retry") { continue; }
                using (var db = Open())
                {
                    if (batch != null && Convert.ToInt32(Scalar(db, "SELECT count(*) FROM batch_items WHERE batch_id=@p0 AND last_job_id=@p1 AND state='queued'", batch, job)) == 0) { continue; }
                    var jobState = (string)Scalar(db, "SELECT state FROM jobs WHERE job_id=@p0", job);
                    if (!includeStopped && (jobState == "paused" || jobState == "cancelled")) { continue; }
                }
                try
                {
                    var article = GetArticle((string)intent["search_id"]);
                    var destination = LocalPath((string)intent["object_relative"]);
                    var stage = LocalPath((string)intent["stage_relative"]);
                    var hash = (string)intent["hash"];
                    var candidate = File.Exists(destination) && new FileInfo(destination).Length <= NcbiTransport.MaximumBytes && Artifacts.Hash(Artifacts.ReadBoundedFile(destination)) == hash ? destination : stage;
                    if (!File.Exists(candidate) || new FileInfo(candidate).Length > NcbiTransport.MaximumBytes)
                    { PublicationState(job, "needs_retry"); FailPublicationRecovery(job, "Interrupted acquisition has no complete staged file; original evidence retained, retry explicitly.", batch); continue; }
                    var bytes = Artifacts.ReadBoundedFile(candidate);
                    if (Artifacts.Hash(bytes) != hash)
                    { PublicationState(job, "needs_retry"); FailPublicationRecovery(job, "Incomplete or corrupt staged file retained; retry explicitly.", batch); continue; }
                    var info = Artifacts.ValidateXml(bytes, article);
                    if (candidate == stage) { PublishStaged(stage, destination, hash); }
                    Attach(article, info, new SourceResponse { OriginalUri = (string)intent["source_uri"], FinalUri = (string)intent["final_uri"] });
                    if (!Artifacts.HasVerifiedArtifact(this, article)) { throw new IOException("Recovered file verification failed."); }
                    SetJob(job, "completed", "Recovered validated original XML from publication journal; no repeat download.");
                    PublicationState(job, "completed");
                }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is SourceException || error is System.Xml.XmlException)
                { FailPublicationRecovery(job, "Publication reconciliation failed: " + Artifacts.SafeMessage(error), batch); }
            }
        }

        private void FailPublicationRecovery(string job, string reason, string retryBatch)
        {
            SetJob(job, "failed", reason);
            // 使用者本次已明確要求重試；前次缺少完整 staging 不能吃掉新的一次佇列要求。
            if (retryBatch == null) { return; }
            using (var db = Open())
            { Execute(db, "UPDATE batch_items SET state='queued',reason='Prior publication could not reconcile; requested retry remains queued.' WHERE batch_id=@p0 AND last_job_id=@p1", retryBatch, job); }
        }

        // 恢復掃描採 rowid 游標，每次只持有 100 筆，不隨歷史紀錄數量增加記憶體。
        private IEnumerable<DataRow> RecoveryRows(string table, string predicate)
        {
            long after = 0;
            while (true)
            {
                var page = new DataTable();
                using (var db = Open())
                using (var command = Command(db, "SELECT rowid AS recovery_rowid,* FROM " + table + " WHERE rowid>@p0 AND (" + predicate + ") ORDER BY rowid LIMIT 100", after))
                using (var reader = command.ExecuteReader()) { page.Load(reader); }
                if (page.Rows.Count == 0) { yield break; }
                foreach (DataRow row in page.Rows) { after = Convert.ToInt64(row["recovery_rowid"]); yield return row; }
            }
        }
    }
}
