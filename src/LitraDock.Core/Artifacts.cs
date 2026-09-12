using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;

namespace LitraDock.Core
{
    public sealed class ArtifactInfo
    {
        public string Hash { get; set; }
        public string RelativePath { get; set; }
        public long Bytes { get; set; }
        public string License { get; set; }
        public string RightsStatus { get; set; }
        public string RightsLicenseUri { get; set; }
        public string Validation { get; set; }
        public string ArticleNumber { get; set; }
        public string EqualContribution { get; set; }
        public string MetadataXml { get; set; }
    }

    public static class Artifacts
    {
        public static string Hash(byte[] bytes)
        { using (var sha = SHA256.Create()) { return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); } }

        public static byte[] ReadBoundedFile(string path)
        {
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (file.Length > NcbiTransport.MaximumBytes) { throw new IOException("Managed XML exceeds the 32 MiB validation limit."); }
                var bytes = new byte[checked((int)file.Length)];
                var offset = 0;
                while (offset < bytes.Length)
                {
                    var read = file.Read(bytes, offset, bytes.Length - offset);
                    if (read == 0) { throw new IOException("Managed XML ended unexpectedly."); }
                    offset += read;
                }
                return bytes;
            }
        }

        public static ArtifactInfo ValidateXml(byte[] bytes, Article expected)
        {
            if (bytes == null || bytes.Length > NcbiTransport.MaximumBytes) { throw new SourceException("failed", "XML exceeds the 32 MiB validation limit; nothing was truncated."); }
            var doc = Metadata.ParseXml(bytes);
            var error = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "error");
            if (error != null) { throw new SourceException("unavailable", "PMC does not provide reusable full text for this request (" + (string)error.Attribute("code") + ")."); }
            var article = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "article");
            var front = article?.Elements().FirstOrDefault(e => e.Name.LocalName == "front");
            var body = article?.Elements().FirstOrDefault(e => e.Name.LocalName == "body");
            if (front == null || body == null || string.IsNullOrWhiteSpace(body.Value))
            { throw new SourceException("unavailable", "Response does not contain a complete source article body; abstract-only content was not accepted."); }
            var ids = front.Descendants().Where(e => e.Name.LocalName == "article-id").ToList();
            var pmc = ids.FirstOrDefault(e => new[] { "pmc", "pmcid" }.Contains((string)e.Attribute("pub-id-type")))?.Value.Trim().ToUpperInvariant() ?? "";
            if (!pmc.StartsWith("PMC", StringComparison.Ordinal)) { pmc = "PMC" + pmc; }
            if (pmc != expected.Pmcid) { throw new SourceException("failed", "Full-text PMCID does not match the selected record."); }
            var doi = ids.FirstOrDefault(e => (string)e.Attribute("pub-id-type") == "doi")?.Value ?? "";
            var pmid = ids.FirstOrDefault(e => (string)e.Attribute("pub-id-type") == "pmid")?.Value ?? "";
            if ((doi.Length > 0 && expected.Doi.Length > 0 && Metadata.NormalizeDoi(doi) != expected.Doi) ||
                (pmid.Length > 0 && expected.Pmid.Length > 0 && pmid != expected.Pmid))
            { throw new SourceException("failed", "Full-text identifier conflict requires review."); }
            var license = front.Descendants().Where(e => e.Name.LocalName == "license").ToList();
            var notes = article.Descendants().Where(e => e.Name.LocalName == "fn" &&
                ((string)e.Attribute("fn-type") == "equal" || e.Value.IndexOf("contributed equally", StringComparison.OrdinalIgnoreCase) >= 0));
            var hash = Hash(bytes);
            return new ArtifactInfo
            {
                Hash = hash, RelativePath = Path.Combine("objects", hash + ".xml"), Bytes = bytes.Length,
                ArticleNumber = Metadata.Value(front, "elocation-id"),
                EqualContribution = string.Join("\n", notes.Select(e => e.Value.Trim())),
                MetadataXml = front.ToString(SaveOptions.DisableFormatting),
                License = license.Count == 0 ? "No article license statement supplied; OAI-PMH reusable full-text route." : string.Join("\n", license.Select(e => e.ToString(SaveOptions.DisableFormatting))),
                Validation = "XML parsed; PMCID matched; supplied DOI/PMID checked; body present. " +
                    "Sections=" + body.Descendants().Count(e => e.Name.LocalName == "sec") +
                    "; Tables=" + article.Descendants().Count(e => e.Name.LocalName == "table-wrap") +
                    "; Figures=" + article.Descendants().Count(e => e.Name.LocalName == "fig") +
                    "; References=" + article.Descendants().Count(e => e.Name.LocalName == "ref") +
                    ". Original response bytes preserved. External media and supplements are not acquired; visual/content fidelity is not verified."
            };
        }

        public static bool HasVerifiedArtifact(Library library, Article article)
        {
            foreach (var path in library.FilePaths(article.SearchId))
            {
                try
                {
                    if (!Path.GetFullPath(path).StartsWith(library.Root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) { continue; }
                    if (!File.Exists(path) || new FileInfo(path).Length > NcbiTransport.MaximumBytes) { continue; }
                    var bytes = ReadBoundedFile(path);
                    if (Hash(bytes) != Path.GetFileNameWithoutExtension(path)) { continue; }
                    ValidateXml(bytes, article);
                    return true;
                }
                catch (Exception error) when (error is IOException || error is System.Xml.XmlException || error is SourceException || error is UnauthorizedAccessException) { }
            }
            return false;
        }

        public static async Task<string> AcquireAsync(Library library, ILiteratureSource source, Article article, CancellationToken cancellation, string existingJob = null, Action<PublicationPoint> fault = null)
        {
            var job = existingJob ?? library.StartJob(article.SearchId);
            try
            {
                if (HasVerifiedArtifact(library, article))
                {
                    library.SetJob(job, "completed", "Skipped acquisition: existing source XML hash and identity verified.");
                    return job;
                }
                library.SetJob(job, "downloading", "Retrieving source XML from " + source.Name + ".");
                var progressive = source as IProgressSource;
                var response = progressive == null ? await source.FetchFullTextAsync(article, cancellation).ConfigureAwait(false)
                    : await progressive.FetchFullTextAsync(article, cancellation, (state, reason) => library.SetJob(job, state, reason)).ConfigureAwait(false);
                library.SetJob(job, "validating", "Validating source XML and article identity.");
                var info = ValidateXml(response.Bytes, article);
                var destination = Path.Combine(library.Root, info.RelativePath);
                var staging = Path.Combine(library.Root, "staging");
                Directory.CreateDirectory(staging);
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                var temporary = library.PreparePublication(job, article, info, response);
                fault?.Invoke(PublicationPoint.BeforeStageWrite);
                // 同一磁碟先完整寫入、flush，再原子搬移；失敗時原始內容不會被覆寫。
                using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { file.Write(response.Bytes, 0, response.Bytes.Length); file.Flush(true); }
                library.PublicationState(job, "staged");
                fault?.Invoke(PublicationPoint.AfterStageWrite);
                cancellation.ThrowIfCancellationRequested();
                library.SetJob(job, "publishing", "Publishing flushed original XML and committing its validated identity; not completed yet.");
                library.PublishStaged(temporary, destination, info.Hash);
                library.PublicationState(job, "published");
                fault?.Invoke(PublicationPoint.AfterPublish);
                library.Attach(article, info, response, () => fault?.Invoke(PublicationPoint.DuringAttach));
                library.PublicationState(job, "attached");
                fault?.Invoke(PublicationPoint.AfterAttach);
                if (!HasVerifiedArtifact(library, article)) { throw new IOException("Published file verification failed."); }
                library.SetJob(job, "completed", info.Validation);
                library.PublicationState(job, "completed");
                return job;
            }
            catch (InterruptedProcessException) { throw; }
            catch (OperationCanceledException)
            {
                library.SetJob(job, cancellation.IsCancellationRequested ? "cancelled" : "failed", cancellation.IsCancellationRequested ? "Acquisition cancelled; staged files retained." : "Source request timed out; retry explicitly.");
                throw;
            }
            catch (Exception error)
            {
                library.SetJob(job, (error as SourceException)?.State ?? "failed", SafeMessage(error));
                throw;
            }
        }

        public static string SafeMessage(Exception error)
        {
            if (error is SourceException || error is ArgumentException) { return error.Message; }
            if (error is System.Net.Http.HttpRequestException) { return "Network or TLS request failed; no certificate checks were bypassed."; }
            if (error is System.Xml.XmlException) { return "Source XML is malformed or exceeds parser limits."; }
            if (error is IOException || error is UnauthorizedAccessException) { return "File operation failed; check storage space, permissions and file integrity."; }
            return "Operation failed (" + error.GetType().Name + "); no completion was recorded.";
        }
    }

    public static class Workflow
    {
        public static async Task<SearchSnapshot> SearchAsync(Library library, ILiteratureSource source, string input, int limit, CancellationToken cancellation)
        {
            var run = new SearchSnapshot { Input = input, Limit = limit };
            library.StartRun(run);
            try
            {
                var checkpointSource = source as ICheckpointSource;
                var saved = 0;
                if (checkpointSource != null)
                { await checkpointSource.SearchAsync(run, cancellation, snapshot => { library.SaveRun(snapshot, saved); saved = snapshot.Articles.Count; }).ConfigureAwait(false); }
                else { await source.SearchAsync(run, cancellation).ConfigureAwait(false); }
                library.SaveRun(run, saved);
                return run;
            }
            catch (Exception error)
            {
                library.FailRun(run, error is OperationCanceledException ? "Search cancelled or timed out; repeat explicitly." : Artifacts.SafeMessage(error));
                throw;
            }
        }
    }
}
