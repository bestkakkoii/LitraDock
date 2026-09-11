using System;
using System.Collections.Generic;
using System.Data;
#if MODERN_SQLITE
using SQLiteConnection = LitraDock.Core.ModernConnection;
using SQLiteConnectionStringBuilder = Microsoft.Data.Sqlite.SqliteConnectionStringBuilder;
using SQLiteCommand = Microsoft.Data.Sqlite.SqliteCommand;
#else
using System.Data.SQLite;
#endif
using System.IO;
using System.Linq;
using System.Text;
using System.Xml.Serialization;

namespace LitraDock.Core
{
    public sealed partial class Library
    {
        private static readonly XmlSerializer ArticleSerializer = new XmlSerializer(typeof(Article));
        public string Root { get; }
        public string DatabasePath => Path.Combine(Root, "library.sqlite3");

        public Library(string root)
        {
            Root = Path.GetFullPath(root);
            Directory.CreateDirectory(Root);
            using (var db = Open())
            {
                var version = Convert.ToInt32(Scalar(db, "PRAGMA user_version"));
                if (version > 2) { throw new InvalidOperationException("This library needs a newer LitraDock version."); }
                if (version == 0) { Execute(db, @"
CREATE TABLE IF NOT EXISTS articles(search_id TEXT PRIMARY KEY, title TEXT NOT NULL, metadata_xml TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS identifiers(kind TEXT NOT NULL, value TEXT NOT NULL, search_id TEXT NOT NULL REFERENCES articles(search_id), PRIMARY KEY(kind,value), UNIQUE(search_id,kind));
CREATE TABLE IF NOT EXISTS revisions(revision_id INTEGER PRIMARY KEY, search_id TEXT NOT NULL REFERENCES articles(search_id), source TEXT NOT NULL, xml TEXT NOT NULL, retrieved_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS search_runs(run_id TEXT PRIMARY KEY, input TEXT NOT NULL, submitted_query TEXT NOT NULL, translation TEXT NOT NULL, started_at TEXT NOT NULL, total INTEGER NOT NULL, fetched INTEGER NOT NULL, requested_limit INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL, source_ids TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS search_results(run_id TEXT NOT NULL REFERENCES search_runs(run_id), search_id TEXT NOT NULL REFERENCES articles(search_id), source_rank INTEGER NOT NULL, PRIMARY KEY(run_id,search_id));
CREATE TABLE IF NOT EXISTS files(hash TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, kind TEXT NOT NULL, validation TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS article_files(search_id TEXT NOT NULL REFERENCES articles(search_id), hash TEXT NOT NULL REFERENCES files(hash), acquired_at TEXT NOT NULL, source_uri TEXT NOT NULL, final_uri TEXT NOT NULL, license TEXT NOT NULL, PRIMARY KEY(search_id,hash));
CREATE TABLE IF NOT EXISTS jobs(job_id TEXT PRIMARY KEY, search_id TEXT NOT NULL REFERENCES articles(search_id), state TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity(event_id INTEGER PRIMARY KEY, job_id TEXT, search_id TEXT, state TEXT NOT NULL, reason TEXT NOT NULL, occurred_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_articles_title ON articles(title);
CREATE INDEX IF NOT EXISTS idx_search_results_rank ON search_results(run_id,source_rank);
CREATE INDEX IF NOT EXISTS idx_jobs_article ON jobs(search_id,updated_at);
PRAGMA user_version=1;"); }
            }
            EnsureBatchSchema();
        }

        private SQLiteConnection Open()
        {
            var db = new SQLiteConnection(new SQLiteConnectionStringBuilder
            { DataSource = DatabasePath, ForeignKeys = true, Pooling = false, DefaultTimeout = 5 }.ConnectionString);
            db.Open();
            Execute(db, "PRAGMA synchronous=FULL");
            return db;
        }

        private static SQLiteCommand Command(SQLiteConnection db, string sql, params object[] values)
        {
#if MODERN_SQLITE
            // 新供應者要求明確指定目前交易；不可讓同一組寫入意外離開交易邊界。
            var command = new SQLiteCommand(sql, db.Inner) { Transaction = db.Transaction };
#else
            var command = new SQLiteCommand(sql, db);
#endif
            for (var i = 0; i < values.Length; i++) { command.Parameters.AddWithValue("@p" + i, values[i] ?? DBNull.Value); }
            return command;
        }

        private static void Execute(SQLiteConnection db, string sql, params object[] values)
        { using (var command = Command(db, sql, values)) { command.ExecuteNonQuery(); } }

        private static object Scalar(SQLiteConnection db, string sql, params object[] values)
        { using (var command = Command(db, sql, values)) { return command.ExecuteScalar(); } }

        private static string Serialize(Article article)
        {
            using (var text = new StringWriter(System.Globalization.CultureInfo.InvariantCulture))
            {
                using (var writer = System.Xml.XmlWriter.Create(text, new System.Xml.XmlWriterSettings { OmitXmlDeclaration = true }))
                { ArticleSerializer.Serialize(writer, article); }
                return text.ToString();
            }
        }

        private static Article Deserialize(string xml)
        {
            using (var reader = Metadata.ParseXml(Encoding.UTF8.GetBytes(xml)).CreateReader())
            { return (Article)ArticleSerializer.Deserialize(reader); }
        }

        public void StartRun(SearchSnapshot run)
        {
            using (var db = Open())
            {
                Execute(db, "INSERT INTO search_runs VALUES(@p0,@p1,'','',@p2,0,0,@p3,'searching','','')", run.RunId, run.Input, run.StartedAt, run.Limit);
            }
        }

        private static string Upsert(SQLiteConnection db, Article article)
        {
            var ids = new[] { Tuple.Create("doi", Metadata.NormalizeDoi(article.Doi)), Tuple.Create("pmid", article.Pmid), Tuple.Create("pmcid", article.Pmcid.ToUpperInvariant()) }.Where(i => i.Item2.Length > 0).ToList();
            var matches = ids.Select(id => (string)Scalar(db, "SELECT search_id FROM identifiers WHERE kind=@p0 AND value=@p1", id.Item1, id.Item2)).Where(id => id != null).Distinct().ToList();
            if (matches.Count > 1) { throw new SourceException("failed", "Identifier conflict: multiple canonical records require review."); }
            var searchId = matches.FirstOrDefault() ?? "LD-" + Guid.NewGuid().ToString("N");
            foreach (var id in ids)
            {
                var old = (string)Scalar(db, "SELECT value FROM identifiers WHERE search_id=@p0 AND kind=@p1", searchId, id.Item1);
                if (old != null && old != id.Item2) { throw new SourceException("failed", "Identifier conflict: an existing record has another " + id.Item1 + "."); }
            }
            var oldXml = (string)Scalar(db, "SELECT metadata_xml FROM articles WHERE search_id=@p0", searchId);
            if (oldXml != null)
            {
                var old = Deserialize(oldXml);
                if (article.Doi.Length == 0) { article.Doi = old.Doi; }
                if (article.Pmid.Length == 0) { article.Pmid = old.Pmid; }
                if (article.Pmcid.Length == 0) { article.Pmcid = old.Pmcid; }
                article.RetrievalState = old.RetrievalState;
                article.EqualContribution = old.EqualContribution;
                article.License = old.License;
                if (old.FullTextMetadataXml.Length > 0)
                {
                    article.FullTextMetadataXml = old.FullTextMetadataXml;
                    article.ArticleNumber = old.ArticleNumber;
                    article.Pages = old.Pages;
                }
            }
            article.SearchId = searchId;
            article.Doi = Metadata.NormalizeDoi(article.Doi);
            Execute(db, "INSERT OR IGNORE INTO articles VALUES(@p0,@p1,@p2,@p3)", searchId, article.Title, Serialize(article), article.RetrievedAt);
            Execute(db, "UPDATE articles SET title=@p1,metadata_xml=@p2 WHERE search_id=@p0", searchId, article.Title, Serialize(article));
            foreach (var id in ids) { Execute(db, "INSERT OR IGNORE INTO identifiers VALUES(@p0,@p1,@p2)", id.Item1, id.Item2, searchId); }
            Execute(db, "INSERT INTO revisions(search_id,source,xml,retrieved_at) VALUES(@p0,'PubMed',@p1,@p2)", searchId, article.RawXml, article.RetrievedAt);
            return searchId;
        }

        public void SaveRun(SearchSnapshot run) => SaveRun(run, 0);

        public void SaveRun(SearchSnapshot run, int alreadySaved)
        {
            using (var db = Open())
            using (var tx = db.BeginTransaction())
            {
                foreach (var article in run.Articles.Skip(alreadySaved))
                {
                    if (Convert.ToInt32(Scalar(db, "SELECT count(*) FROM search_results r JOIN identifiers i ON i.search_id=r.search_id WHERE r.run_id=@p0 AND i.kind='pmid' AND i.value=@p1", run.RunId, article.Pmid)) > 0) { continue; }
                    var id = Upsert(db, article);
                    Execute(db, "INSERT INTO search_results VALUES(@p0,@p1,@p2)", run.RunId, id, run.SourceIds.IndexOf(article.Pmid) + 1);
                }
                UpdateRun(db, run);
                tx.Commit();
            }
        }

        private static void UpdateRun(SQLiteConnection db, SearchSnapshot run)
        {
            Execute(db, "UPDATE search_runs SET submitted_query=@p1,translation=@p2,total=@p3,fetched=@p4,state=@p5,reason=@p6,source_ids=@p7 WHERE run_id=@p0",
                run.RunId, run.SubmittedQuery, run.Translation, run.Total, Convert.ToInt32(Scalar(db, "SELECT count(*) FROM search_results WHERE run_id=@p0", run.RunId)), run.State, run.Reason, string.Join(",", run.SourceIds));
        }

        public void FailRun(SearchSnapshot run, string reason)
        {
            run.State = "failed";
            run.Reason = reason;
            using (var db = Open())
            {
                // 已提交分批結果保留；完成數由持久化關聯計算，不將未提交下載當成完成。
                UpdateRun(db, run);
            }
        }

        public List<Article> ReadArticles(string runId = null)
        {
            using (var db = Open())
            using (var command = runId == null
                ? Command(db, "SELECT metadata_xml FROM articles ORDER BY title")
                : Command(db, "SELECT a.metadata_xml FROM articles a JOIN search_results r ON r.search_id=a.search_id WHERE r.run_id=@p0 ORDER BY r.source_rank", runId))
            using (var reader = command.ExecuteReader())
            {
                var result = new List<Article>();
                while (reader.Read()) { result.Add(Deserialize(reader.GetString(0))); }
                return result;
            }
        }

        public Article GetArticle(string searchId)
        {
            using (var db = Open())
            {
                var xml = (string)Scalar(db, "SELECT metadata_xml FROM articles WHERE search_id=@p0", searchId);
                if (xml == null) { throw new ArgumentException("Record does not exist."); }
                return Deserialize(xml);
            }
        }

        public DataTable ReadTable(string name)
        {
            if (!new[] { "search_runs", "search_results", "files", "article_files", "activity", "jobs", "identifiers", "revisions" }.Contains(name))
            { throw new ArgumentException("Unsupported report table."); }
            using (var db = Open())
            using (var command = Command(db, "SELECT * FROM " + name))
            using (var reader = command.ExecuteReader())
            { var table = new DataTable(name); table.Load(reader); return table; }
        }

        public string StartJob(string searchId)
        {
            var id = "JOB-" + Guid.NewGuid().ToString("N");
            using (var db = Open())
            { Execute(db, "INSERT INTO jobs VALUES(@p0,@p1,'resolving','',@p2)", id, searchId, DateTime.UtcNow.ToString("o")); }
            SetJob(id, "resolving", "Discovering permitted PMC full text.");
            return id;
        }

        public void SetJob(string jobId, string state, string reason)
        {
            using (var db = Open())
            using (var tx = db.BeginTransaction())
            {
                var searchId = (string)Scalar(db, "SELECT search_id FROM jobs WHERE job_id=@p0", jobId);
                var xml = (string)Scalar(db, "SELECT metadata_xml FROM articles WHERE search_id=@p0", searchId);
                var article = Deserialize(xml);
                article.RetrievalState = state;
                if ((string)Scalar(db, "SELECT job_id FROM jobs WHERE search_id=@p0 ORDER BY rowid DESC LIMIT 1", searchId) == jobId)
                { Execute(db, "UPDATE articles SET metadata_xml=@p1 WHERE search_id=@p0", searchId, Serialize(article)); }
                Execute(db, "UPDATE jobs SET state=@p1,reason=@p2,updated_at=@p3 WHERE job_id=@p0", jobId, state, reason, DateTime.UtcNow.ToString("o"));
                Execute(db, "INSERT INTO activity(job_id,search_id,state,reason,occurred_at) VALUES(@p0,@p1,@p2,@p3,@p4)", jobId, searchId, state, reason, DateTime.UtcNow.ToString("o"));
                Execute(db, "UPDATE batch_items SET state=@p1,reason=@p2 WHERE last_job_id=@p0", jobId, state, reason);
                tx.Commit();
            }
        }

        public void Attach(Article article, ArtifactInfo info, SourceResponse source, Action beforeCommit = null)
        {
            using (var db = Open())
            using (var tx = db.BeginTransaction())
            {
                var alreadyLinked = Convert.ToInt32(Scalar(db, "SELECT count(*) FROM article_files WHERE search_id=@p0 AND hash=@p1", article.SearchId, info.Hash)) > 0;
                Execute(db, "INSERT OR IGNORE INTO files VALUES(@p0,@p1,@p2,'Complete source XML',@p3)", info.Hash, info.RelativePath, info.Bytes, info.Validation);
                Execute(db, "INSERT OR IGNORE INTO article_files VALUES(@p0,@p1,@p2,@p3,@p4,@p5)", article.SearchId, info.Hash, DateTime.UtcNow.ToString("o"), source.OriginalUri, source.FinalUri, info.License);
                article.License = info.License;
                article.EqualContribution = info.EqualContribution;
                article.FullTextMetadataXml = info.MetadataXml;
                if (info.ArticleNumber.Length > 0) { article.ArticleNumber = info.ArticleNumber; article.Pages = ""; }
                Execute(db, "UPDATE articles SET metadata_xml=@p1 WHERE search_id=@p0", article.SearchId, Serialize(article));
                if (!alreadyLinked) { Execute(db, "INSERT INTO revisions(search_id,source,xml,retrieved_at) VALUES(@p0,'PMC OAI-PMH',@p1,@p2)", article.SearchId, info.MetadataXml, DateTime.UtcNow.ToString("o")); }
                beforeCommit?.Invoke();
                tx.Commit();
            }
        }

        public List<string> FilePaths(string searchId)
        {
            using (var db = Open())
            using (var command = Command(db, "SELECT relative_path FROM files f JOIN article_files a ON a.hash=f.hash WHERE a.search_id=@p0", searchId))
            using (var reader = command.ExecuteReader())
            {
                var paths = new List<string>();
                while (reader.Read()) { paths.Add(LocalPath(reader.GetString(0))); }
                return paths;
            }
        }

        public void RecoverInterrupted(Action<string> progress = null)
        {
            using (var lease = new FileStream(Path.Combine(Root, "batch.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            { RecoverAfterLease(progress); }
        }

        private void RecoverAfterLease(Action<string> progress)
        {
            progress?.Invoke("Reconciling interrupted file publications...");
            RecoverPublications(progress: progress);
            var checkedJobs = 0;
            foreach (DataRow job in RecoveryRows("jobs", "state IN ('resolving','redirecting','waiting','downloading','validating','publishing','completed')"))
            {
                progress?.Invoke("Checking saved acquisition history " + (++checkedJobs) + "; total time unknown...");
                var state = (string)job["state"];
                if (new[] { "resolving", "redirecting", "waiting", "downloading", "validating", "publishing" }.Contains(state))
                { SetJob((string)job["job_id"], "failed", "Interrupted operation; retry is safe. Staged or orphan files are retained for reconciliation."); }
                else if (state == "completed" && !Artifacts.HasVerifiedArtifact(this, GetArticle((string)job["search_id"])))
                { SetJob((string)job["job_id"], "failed", "Previously completed file is missing or corrupted; retry acquisition."); }
            }
            using (var db = Open())
            { Execute(db, "UPDATE search_runs SET state='failed',reason='Interrupted search; repeat explicitly.' WHERE state='searching'"); }
            RecoverBatches();
        }

        public string IntegrityCheck()
        { using (var db = Open()) { return (string)Scalar(db, "PRAGMA integrity_check"); } }

        public string SqliteVersion()
        { using (var db = Open()) { return (string)Scalar(db, "SELECT sqlite_version()"); } }
    }
}
