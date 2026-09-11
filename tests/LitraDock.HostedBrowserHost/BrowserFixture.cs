using System.Text;
using LitraDock.Core;

namespace Literature.Verification;

// 僅測試專案以編譯常數掛入；正式 Hosted 專案無執行時 fixture 開關。
public sealed class BrowserFixture : ICheckpointSource, IProgressSource
{
    private int rateAttempts;
    public string Name => "Synthetic browser fixture; no live source traffic";

    public Task SearchAsync(SearchSnapshot snapshot, CancellationToken token) =>
        SearchAsync(snapshot, token, null);

    public async Task SearchAsync(
        SearchSnapshot snapshot,
        CancellationToken token,
        Action<SearchSnapshot> checkpoint
    )
    {
        await Task.Delay(300, token);
        snapshot.Total = 125;
        snapshot.State = "partial";
        for (var n = 0; n < 120; n++)
        {
            var pmid = (77000000 + n).ToString();
            snapshot.SourceIds.Add(pmid);
            snapshot.Articles.Add(
                new Article
                {
                    Pmid = pmid,
                    Pmcid = "PMC" + pmid,
                    Doi = "10.5555/browser-" + n,
                    Title = "Synthetic browser article " + n,
                    Authors = "Example 群組",
                    Year = "2026",
                    RawXml = "<source><language>繁體中文</language></source>",
                }
            );
        }
        checkpoint?.Invoke(snapshot);
    }

    public Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken token) =>
        FetchFullTextAsync(article, token, null);

    public async Task<SourceResponse> FetchFullTextAsync(
        Article article,
        CancellationToken token,
        Action<string, string> progress
    )
    {
        progress?.Invoke("waiting", "Synthetic wait; no external request.");
        await Task.Delay(150, token);
        var n = int.Parse(article.Pmid) - 77000000;
        if (n is >= 1 and <= 5 && (n != 3 || Interlocked.Increment(ref rateAttempts) == 1))
            throw new SourceException(
                new[]
                {
                    "completed",
                    "unavailable",
                    "needs_login",
                    "rate_wait",
                    "failed",
                    "challenge",
                }[n],
                "Synthetic browser source outcome."
            );
        return new SourceResponse
        {
            Bytes = Encoding.UTF8.GetBytes(
                "<article><front><article-meta><article-id pub-id-type='pmid'>"
                    + article.Pmid
                    + "</article-id><article-id pub-id-type='pmc'>"
                    + article.Pmcid
                    + "</article-id><article-id pub-id-type='doi'>"
                    + article.Doi
                    + "</article-id><license>CC BY synthetic fixture only</license></article-meta></front><body><p>Synthetic β 測試 original</p></body></article>"
            ),
            OriginalUri = "https://example.invalid/synthetic-browser",
            FinalUri = "https://example.invalid/synthetic-browser",
        };
    }
}
