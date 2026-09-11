using LitraDock.Core;

namespace Literature.Service;

public sealed class HostedWorker(PgStore store, OriginalStore originals, ILiteratureSource source)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var admission = await ResourceAdmission.Enter(store, heavy: true);
                await store.RecoverScheduledWork();
                await store.AdvanceSchedule();
                var claim = await store.ClaimNext();
                if (claim != null)
                    await ExecuteClaim(claim, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (ResourceBusyException) { }
            catch (Exception)
            {
                Console.Error.WriteLine(
                    "Worker operation failed; durable lease recovery will retain unfinished work."
                );
            }
            await Task.Delay(500, stoppingToken);
        }
    }

    public async Task ExecuteClaim(Claim claim, CancellationToken stoppingToken)
    {
        using var attempt = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var renew = Task.Run(async () =>
        {
            try
            {
                while (!attempt.IsCancellationRequested)
                {
                    await Task.Delay(1000, attempt.Token);
                    if (!await store.Renew(claim))
                    {
                        attempt.Cancel();
                        break;
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch
            {
                attempt.Cancel();
            }
        });
        try
        {
            if (claim.Kind == "search")
            {
                var run = await store.SearchInput(claim);
                if (source is ICheckpointSource checkpoints)
                    await checkpoints.SearchAsync(
                        run,
                        attempt.Token,
                        snapshot => store.SaveSearch(claim, snapshot).GetAwaiter().GetResult()
                    );
                else
                    await source.SearchAsync(run, attempt.Token);
                await store.SaveSearch(claim, run);
                await store.Finish(
                    claim,
                    "completed",
                    "Search metadata saved; source totals/partial status retained."
                );
            }
            else
            {
                originals.Admit(claim.Library, NcbiTransport.MaximumBytes * 2L);
                var article = await store.Article(claim.Library, claim.SearchId);
                var manual = await store.ManualInput(claim);
                if (
                    await store.RecoverPublication(
                        claim,
                        article,
                        originals,
                        manual?["hash"] as string
                    )
                )
                {
                    await store.Finish(
                        claim,
                        "completed",
                        "Recovered validated durable original without refetch."
                    );
                    if (manual != null)
                        File.Delete(
                            originals.RetainedStage(claim.Library, (string)manual["stage_token"])
                        );
                    return;
                }
                foreach (
                    var file in manual == null
                        ? await store.Files(claim.Library, claim.SearchId)
                        : new List<Dictionary<string, object>>()
                )
                {
                    try
                    {
                        OriginalValidation.Validate(
                            originals.Read(claim.Library, (string)file["hash"]),
                            article,
                            await store.IsUserConfirmed(
                                claim.Library,
                                claim.SearchId,
                                (string)file["hash"]
                            )
                        );
                        await store.Finish(
                            claim,
                            "completed",
                            "Skipped: existing original hash and identity verified."
                        );
                        return;
                    }
                    catch (Exception error)
                        when (error is IOException or SourceException or System.Xml.XmlException)
                    { }
                }
                await store.Progress(
                    claim,
                    "resolving",
                    manual == null
                        ? "Resolving supported full-text routes."
                        : "Validating retained manual original."
                );
                var response =
                    manual != null
                        ? new SourceResponse
                        {
                            Bytes = Artifacts.ReadBoundedFile(
                                originals.RetainedStage(
                                    claim.Library,
                                    (string)manual["stage_token"]
                                )
                            ),
                            OriginalUri = "",
                            FinalUri = "",
                            ContentType = "application/octet-stream",
                        }
                    : source is IProgressSource progress
                        ? await progress.FetchFullTextAsync(
                            article,
                            attempt.Token,
                            (state, reason) =>
                                store.Progress(claim, state, reason).GetAwaiter().GetResult()
                        )
                    : await source.FetchFullTextAsync(article, attempt.Token);
                var info = OriginalValidation.Validate(
                    response.Bytes,
                    article,
                    PgStore.IdentityConfirmed(manual)
                );
                if (manual != null && info.Hash != (string)manual["hash"])
                    throw new IOException("Manual input hash changed; retained for review.");
                await store.PreparePublication(claim, info, response);
                var stage = originals.Stage(claim, response.Bytes);
                await store.Progress(
                    claim,
                    "publishing",
                    "Original validated; committing immutable object association."
                );
                await store.Publish(claim, article, info, response, originals, stage);
                await store.Finish(claim, "completed", info.Validation);
                if (manual != null)
                    File.Delete(
                        originals.RetainedStage(claim.Library, (string)manual["stage_token"])
                    );
            }
        }
        catch (OperationCanceledException)
        {
            try
            {
                await store.Schedule(
                    claim,
                    "interrupted",
                    "Worker stopped; durable automatic continuation retained."
                );
            }
            catch (OperationCanceledException) { }
        }
        catch (Exception error)
        {
            try
            {
                var state = (error as SourceException)?.State ?? "failed";
                if (state is "rate_wait" or "transient" || error is HttpRequestException)
                    await store.Schedule(
                        claim,
                        state == "rate_wait" ? state : "transient",
                        Artifacts.SafeMessage(error)
                    );
                else
                    await store.Finish(claim, state, Artifacts.SafeMessage(error));
            }
            catch (OperationCanceledException) { }
        }
        finally
        {
            attempt.Cancel();
            await renew;
        }
    }
}
