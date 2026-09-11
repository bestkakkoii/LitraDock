using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace LitraDock.Core
{
    public sealed class BatchEngine
    {
        private readonly Library library;
        private readonly ILiteratureSource source;
        public BatchEngine(Library library, ILiteratureSource source) { this.library = library; this.source = source; }

        public async Task RunAsync(string batch, CancellationToken cancellation, Action<PublicationPoint> fault = null)
        {
            // 核心也持有作業系統檔案鎖；程序中止會釋放鎖，第二個處理器不能重複領取佇列。
            using (var lease = new FileStream(Path.Combine(library.Root, "batch.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            {
                library.ControlBatch(batch, "running");
                library.RecoverPublications(true, batch);
                while (!cancellation.IsCancellationRequested && library.BatchState(batch) == "running")
                {
                    var attempt = library.NextAttempt(batch);
                    if (attempt == null) { break; }
                    try
                    { await Artifacts.AcquireAsync(library, source, library.GetArticle(attempt.Item2), cancellation, attempt.Item3, fault).ConfigureAwait(false); }
                    catch (InterruptedProcessException) { throw; }
                    catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
                    {
                        var paused = library.BatchState(batch) == "paused";
                        library.SetJob(attempt.Item3, paused ? "paused" : "cancelled", paused ? "Batch paused; resume keeps the saved scope and prior attempt history." : "Batch cancelled; explicit retry remains available.");
                        if (library.BatchState(batch) == "running") { library.ControlBatch(batch, "cancelled"); }
                        break;
                    }
                    catch (Exception error)
                    { library.SetJob(attempt.Item3, (error as SourceException)?.State ?? "failed", Artifacts.SafeMessage(error)); }
                }
                if (cancellation.IsCancellationRequested && library.BatchState(batch) == "running") { library.ControlBatch(batch, "cancelled"); }
                library.FinishBatch(batch);
            }
        }
    }
}
