using System.Text;
using System.Text.Json;
using Literature.Service;
using LitraDock.Core;

public static class ResearchManualChecks
{
    public static async Task Run(
        PgStore store,
        Guid library,
        Guid owner,
        string id,
        string scope,
        OriginalStore files,
        string output,
        Action<bool, string> check
    )
    {
        var worker = new HostedWorker(store, files, new ResearchFixture());
        var expected = new List<(string Hash, byte[] Bytes)>();
        foreach (
            var source in new[]
            {
                "<html><body><h2>Saved source section</h2><p>User supplied 中文 scholarly content.</p></body></html>",
                "Saved plain-text scholarly content 中文 with no invented publisher layout.",
            }
        )
        {
            var bytes = Encoding.UTF8.GetBytes(source);
            var hash = Artifacts.Hash(bytes);
            expected.Add((hash, bytes));
            var item = JsonSerializer.SerializeToElement(await store.ManualItem(library, id));
            await store.QueueManual(
                library,
                id,
                item.GetProperty("item").GetString(),
                bytes,
                "",
                "accepted-manuscript",
                files
            );
            var state = JsonSerializer.SerializeToElement(
                await store.BatchStatus(library, item.GetProperty("batch").GetString(), 0)
            );
            check(
                state.GetProperty("items")[0].GetProperty("state").GetString() == "needs_review",
                "Actual saved HTML/text acquisition waits for user identity confirmation"
            );
            await store.ConfirmManual(library, id, item.GetProperty("item").GetString());
            await worker.ExecuteClaim(await store.ClaimNext(), CancellationToken.None);
            check(
                files.Read(library, hash).SequenceEqual(bytes)
                    && (await store.Files(library, id)).Any(x =>
                        (string)x["hash"] == hash
                        && (string)x["kind"] == OriginalValidation.Kind(bytes)
                    ),
                "Confirmed original publication preserves exact actual HTML/text artifact kind"
            );
            await store.QueueConversion(library, id, hash, "original", owner, files);
            await new ReadingWorker(store, files).Execute(
                await store.ClaimConversion(),
                CancellationToken.None
            );
            var research = JsonSerializer.SerializeToElement(
                await store.ResearchRecord(library, id)
            );
            check(
                research
                    .GetProperty("derivations")
                    .EnumerateArray()
                    .Any(x =>
                        x.GetProperty("input_hash").GetString() == hash
                        && x.GetProperty("kind").GetString() == "Formatted Reading Copy"
                    ),
                "Actual HTML/text saved original produces separate labelled reading PDF with exact input version"
            );
        }
        var bundle = await store.ExportBundle(library, files, scope, true);
        var restored = await store.ImportBundle(owner, bundle, files);
        foreach (var original in expected)
            check(
                files.Read(restored, original.Hash).SequenceEqual(original.Bytes),
                "Selected relocation preserves validated HTML/text version bytes"
            );
    }
}
