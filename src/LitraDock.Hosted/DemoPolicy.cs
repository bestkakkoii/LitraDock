using LitraDock.Core;
using Microsoft.AspNetCore.Routing;
using Npgsql;

namespace Literature.Service;

public sealed record DemoPolicy(string Operator, string Contact, string Retention, string SourceRevision, DateTimeOffset ExpiresAt)
{
    public const string ReviewedPolicy = "reviewed-xml-v1";
    public string AcquisitionPolicy { get; init; } = ReviewedPolicy;
    public string AcquisitionDescription => AcquisitionPolicy == PmcOpenPolicy.Id ? PmcOpenPolicy.Description
        : "Only the reviewed PMC6836491 and PMC8005924 article XML. Other results retain source links and an unavailable reason.";
    public void RequireArticle(Article article)
    {
        RequireActive();
        if (AcquisitionPolicy == PmcOpenPolicy.Id) { PmcOpenPolicy.Location(article); return; }
        if (AcquisitionPolicy != ReviewedPolicy) throw new InvalidOperationException("Unknown acquisition policy.");
        if (!DemoSource.Reviewed(article))
            throw new SourceException("unavailable", "This demo acquires only reviewed PMC6836491 and PMC8005924 XML; open the record source links for other access options.");
    }
    public ArtifactInfo ValidateOriginal(byte[] bytes, Article article)
    {
        RequireArticle(article);
        if (AcquisitionPolicy == PmcOpenPolicy.Id) return PmcOpenPolicy.Validate(bytes, article);
        var info = OriginalValidation.Validate(bytes, article);
        if (OriginalValidation.Kind(bytes) != OriginalValidation.XmlKind || info.RightsStatus != "permitted"
            || info.RightsLicenseUri != "https://creativecommons.org/licenses/by/4.0/")
            throw new SourceException("unavailable", "The reviewed article license is missing or changed; demo acquisition requires operator review.");
        return info;
    }
    public const int SearchLimit = 100;
    public const int BatchLimit = 10;
    public const long StorageLimit = 512L * 1024 * 1024;
    public static DemoPolicy Read(IConfiguration config)
    {
        if (config["LITRADOCK_DEMO"] != "true") return null;
        string Required(string key)
        {
            var value = config[key];
            if (string.IsNullOrWhiteSpace(value) || value.Length > 500 || value.Contains("REQUIRED", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Configure the required demo operator, contact, retention, expiry and exact source revision.");
            return value;
        }
        var revision = Required("LITRADOCK_SOURCE_REVISION");
        if (!System.Text.RegularExpressions.Regex.IsMatch(revision, "^[0-9a-f]{40}$"))
            throw new InvalidOperationException("Demo requires an exact public source commit.");
        var expiryText = Required("LITRADOCK_DEMO_EXPIRES");
        if (!System.Text.RegularExpressions.Regex.IsMatch(expiryText, @"T.*(?:Z|[+-]\d{2}:\d{2})$")
            || !DateTimeOffset.TryParse(expiryText, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var expiry))
            throw new InvalidOperationException("Demo expiry must be an explicit timestamp.");
        var acquisition = config["LITRADOCK_ACQUISITION_POLICY"] ?? ReviewedPolicy;
        if (acquisition is not (ReviewedPolicy or PmcOpenPolicy.Id)) throw new InvalidOperationException("Unknown acquisition policy.");
        return new(Required("LITRADOCK_DEMO_OPERATOR"), Required("LITRADOCK_DEMO_CONTACT"), Required("LITRADOCK_DEMO_RETENTION"), revision, expiry) { AcquisitionPolicy = acquisition };
    }

    public void RequireActive()
    {
        if (DateTimeOffset.UtcNow >= ExpiresAt)
            throw new InvalidOperationException("This invited demo has ended; contact the operator for retained data and cleanup.");
    }

    public static bool Allows(string method, string route) => (method, route) switch
    {
        ("GET", "/api/session" or "/api/sources" or "/api/libraries" or "/api/libraries/{library:guid}"
            or "/api/libraries/{library:guid}/scopes/{scope}" or "/api/libraries/{library:guid}/batches/{batch}"
            or "/api/libraries/{library:guid}/records/{id}" or "/api/libraries/{library:guid}/records/{id}/files/{hash}"
            or "/api/libraries/{library:guid}/history" or "/api/libraries/{library:guid}/next-events") => true,
        ("POST", "/api/login" or "/api/logout" or "/api/libraries" or "/api/libraries/{library:guid}/search"
            or "/api/libraries/{library:guid}/scopes" or "/api/libraries/{library:guid}/scopes/{scope}/select"
            or "/api/libraries/{library:guid}/batches" or "/api/libraries/{library:guid}/batches/{batch}/control"
            or "/api/libraries/{library:guid}/scopes/{scope}/csv" or "/api/libraries/{library:guid}/records/{id}/name-preview") => true,
        _ => false,
    };
}

public sealed partial class PgStore
{
    internal async Task DemoAdmission(NpgsqlConnection db, Guid account, string kind, int added = 1)
    {
        if (Demo == null) return;
        Demo.RequireActive();
        // 所有配額檢查與相依寫入共用同一交易鎖，跨 HTTP 程序不能同時通過最後一個名額。
        await Exec(db, "SET LOCAL lock_timeout='3s'");
        await Exec(db, "SELECT pg_advisory_xact_lock(724913015)");
        var (table, perAccount, global) = kind switch
        {
            "library" => ("ld_libraries", 2, 20),
            "search" => ("ld_runs", 50, 200),
            "scope" => ("ld_scopes", 200, 1000),
            "jobs" => ("ld_jobs", 200, 1000),
            _ => throw new ArgumentException("Unknown demo admission kind."),
        };
        var join = table == "ld_libraries" ? "" : " JOIN ld_libraries l USING(library_id)";
        var owner = table == "ld_libraries" ? "t.owner_id" : "l.owner_id";
        var count = Convert.ToInt64(await Scalar(db, $"SELECT count(*) FROM {table} t{join} WHERE {owner}=@p0", account));
        var total = Convert.ToInt64(await Scalar(db, $"SELECT count(*) FROM {table}"));
        if (count + added > perAccount || total + added > global)
            throw new InvalidOperationException("Demo saved-work limit reached; existing data is retained. Contact the operator.");
        if (kind == "jobs")
        {
            var active = Convert.ToInt64(await Scalar(db, "SELECT count(*) FROM ld_jobs j JOIN ld_libraries l USING(library_id) WHERE l.owner_id=@p0 AND j.state IN ('queued','running','scheduled')", account));
            var all = Convert.ToInt64(await Scalar(db, "SELECT count(*) FROM ld_jobs WHERE state IN ('queued','running','scheduled')"));
            if (active + added > 20 || all + added > 40)
                throw new InvalidOperationException("Demo queue capacity is in use; wait for current work before submitting more.");
        }
    }

    internal async Task DemoLibraryAdmission(NpgsqlConnection db, Guid library, string kind, int added = 1)
    {
        if (Demo == null) return;
        var owner = await Scalar(db, "SELECT owner_id FROM ld_libraries WHERE library_id=@p0", library);
        if (owner is not Guid account) throw new KeyNotFoundException();
        await DemoAdmission(db, account, kind, added);
    }

    public async Task VerifyDemo()
    {
        if (Demo == null) return;
        Demo.RequireActive();
        await using var db = await Data.OpenConnectionAsync();
        if (Convert.ToInt64(await Scalar(db, "SELECT (SELECT count(*) FROM ld_manual_inputs)+(SELECT count(*) FROM ld_conversions)")) != 0)
            throw new InvalidOperationException("Use a dedicated demo database without manual uploads or conversion work; existing research data was not changed.");
    }
}

// Demo 先限經人工檢視的 known-record XML；廣泛 PubMed 搜尋照常，其他作品顯示可用的未解決原因與連結。
public sealed class DemoSource(ILiteratureSource source, DemoPolicy policy) : ICheckpointSource, IProgressSource
{
    public static bool Reviewed(Article article) =>
        article.Pmid == "31719837" && article.Pmcid == "PMC6836491" && article.Doi == "10.1186/s13020-019-0270-9"
        || article.Pmid == "33782057" && article.Pmcid == "PMC8005924" && article.Doi == "10.1136/bmj.n71";
    public string Name => source.Name;
    public Task SearchAsync(SearchSnapshot snapshot, CancellationToken token) => SearchAsync(snapshot, token, null);
    public Task SearchAsync(SearchSnapshot snapshot, CancellationToken token, Action<SearchSnapshot> checkpoint)
    {
        policy.RequireActive();
        if (snapshot.Limit > DemoPolicy.SearchLimit) throw new SourceException("failed", "Demo search limit exceeded.");
        return source is ICheckpointSource saved ? saved.SearchAsync(snapshot, token, checkpoint) : source.SearchAsync(snapshot, token);
    }
    public Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken token) => FetchFullTextAsync(article, token, null);
    public async Task<SourceResponse> FetchFullTextAsync(Article article, CancellationToken token, Action<string, string> progress)
    {
        policy.RequireArticle(article);
        var response = source is IProgressSource reported ? await reported.FetchFullTextAsync(article, token, progress) : await source.FetchFullTextAsync(article, token);
        policy.ValidateOriginal(response.Bytes, article);
        return response;
    }
}
