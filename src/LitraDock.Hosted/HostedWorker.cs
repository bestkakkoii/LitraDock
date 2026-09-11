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
                await store.RecoverExpired();
                var claim = await store.ClaimNext();
                if (claim == null)
                {
                    await Task.Delay(500, stoppingToken);
                    continue;
                }
                await ExecuteClaim(claim, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception)
            {
                Console.Error.WriteLine(
                    "Worker operation failed; durable lease recovery will retain unfinished work."
                );
                await Task.Delay(1000, stoppingToken);
            }
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
                var article = await store.Article(claim.Library, claim.SearchId);
                foreach (var file in await store.Files(claim.Library, claim.SearchId))
                {
                    try
                    {
                        Artifacts.ValidateXml(
                            originals.Read(claim.Library, (string)file["hash"]),
                            article
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
                await store.Progress(claim, "downloading", "Retrieving supported source XML.");
                var response = source is IProgressSource progress
                    ? await progress.FetchFullTextAsync(
                        article,
                        attempt.Token,
                        (state, reason) =>
                            store.Progress(claim, state, reason).GetAwaiter().GetResult()
                    )
                    : await source.FetchFullTextAsync(article, attempt.Token);
                var info = Artifacts.ValidateXml(response.Bytes, article);
                await store.PreparePublication(claim, info, response);
                var stage = originals.Stage(claim, response.Bytes);
                await store.Progress(
                    claim,
                    "publishing",
                    "Original validated; committing immutable object association."
                );
                await store.Publish(claim, article, info, response, originals, stage);
                await store.Finish(claim, "completed", info.Validation);
            }
        }
        catch (OperationCanceledException)
        {
            try
            {
                await store.PauseClaim(claim);
            }
            catch (OperationCanceledException) { }
        }
        catch (Exception error)
        {
            try
            {
                await store.Finish(
                    claim,
                    (error as SourceException)?.State ?? "failed",
                    Artifacts.SafeMessage(error)
                );
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
