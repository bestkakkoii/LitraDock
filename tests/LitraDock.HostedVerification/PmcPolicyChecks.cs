using System.Net;
using System.Text;
using System.Xml.Linq;
using Literature.Service;
using LitraDock.Core;
using Microsoft.Extensions.Configuration;

// All inputs are synthetic adversarial responses, not article results or provider evidence.
public static class PmcPolicyChecks
{
    public static Article Record() => new() { Pmcid = "PMC999999001", Pmid = "999999001", Doi = "10.5555/synthetic-policy", Title = "Synthetic policy test only", SearchId = "synthetic-policy" };
    public static byte[] Envelope(Article a) => Encoding.UTF8.GetBytes(
        "<OAI-PMH xmlns='http://www.openarchives.org/OAI/2.0/'><responseDate>2026-09-12T00:00:00Z</responseDate>"
        + "<request verb='GetRecord' metadataPrefix='pmc' identifier='oai:pubmedcentral.nih.gov:" + a.Pmcid[3..] + "'>" + PmcOpenPolicy.Endpoint + "</request>"
        + "<GetRecord><record><header><identifier>oai:pubmedcentral.nih.gov:" + a.Pmcid[3..] + "</identifier><datestamp>2026-09-11</datestamp></header><metadata>"
        + Encoding.UTF8.GetString(SourceChecks.Xml(a)).Replace("<article>", "<article xmlns=''>") + "</metadata></record></GetRecord></OAI-PMH>");
    public static async Task Run(Action<bool, string> check)
    {
        var a = Record();
        var xml = Envelope(a);
        var original = xml.ToArray();
        var info = PmcOpenPolicy.Validate(xml, a);
        check(info.Hash == Artifacts.Hash(xml) && xml.SequenceEqual(original)
            && info.RightsLicenseUri == "https://creativecommons.org/licenses/by/4.0/"
            && info.Validation.Contains("publication version unspecified") && info.Validation.Contains("2026-09-11"),
            "SOP01 exact repository bytes/hash, structured rights and honest version evidence");
        var cc0 = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(xml).Replace("licenses/by/4.0", "publicdomain/zero/1.0"));
        check(PmcOpenPolicy.Validate(cc0, a).RightsLicenseUri == "https://creativecommons.org/publicdomain/zero/1.0/", "SOP02 CC0 explicit article grant");
        void Denied(byte[] bytes, string state, string label, string snapshot = null)
        {
            try { PmcOpenPolicy.Validate(bytes, a, snapshot); throw new Exception("Accepted " + label); }
            catch (SourceException e) { check(e.State == state, label); }
        }
        var text = Encoding.UTF8.GetString(xml);
        foreach (var (from, to, state, label) in new[]
        {
            ("href='https://creativecommons.org/licenses/by/4.0/'", "", "unavailable", "unknown grant"),
            ("/by/4.0/", "/by-nc/4.0/", "unavailable", "restricted grant"),
            ("CC BY 4.0 synthetic fixture only", "All rights reserved", "unavailable", "contradictory grant"),
            ("creativecommons.org", "creativecommons.org.evil.invalid", "unavailable", "spoofed rights host"),
            ("pub-id-type='pmid'", "pub-id-type='unknown'", "failed", "missing expected PMID"),
            (">10.5555/synthetic-policy<", ">10.5555/conflict<", "failed", "DOI mismatch"),
            ("<header>", "<header status='deleted'>", "unavailable", "deleted record"),
            ("2026-09-11", "2026-02-30", "failed", "invalid datestamp"),
            ("metadataPrefix='pmc'", "metadataPrefix='pmc_fm'", "failed", "metadata versus full text"),
            ("<body>", "<abstract>" , "failed", "malformed XML"),
            ("oai:pubmedcentral.nih.gov:999999001", "oai:pubmedcentral.nih.gov:999999002", "failed", "envelope identity mismatch"),
            ("<metadata>", "<metadata/><metadata>", "failed", "ambiguous metadata container"),
            ("<front>", "<front/><front>", "failed", "ambiguous front matter"),
        }) Denied(Encoding.UTF8.GetBytes(text.Replace(from, to)), state, "SOP03 " + label);
        var duplicate = text.Replace("</article-meta>", "<article-id pub-id-type='pmid'>999999001</article-id></article-meta>");
        Denied(Encoding.UTF8.GetBytes(duplicate), "failed", "SOP04 duplicate article identifier");
        Denied(SourceChecks.Xml(a), "failed", "SOP05 bare XML is not route evidence");
        Denied(xml, "failed", "SOP06 requested snapshot mismatch", new string('0',64));
        check(PmcOpenPolicy.Validate(xml, a, info.Hash).Hash == info.Hash, "SOP06 pinned snapshot accepted");
        var later = Encoding.UTF8.GetBytes(text.Replace("Synthetic β 測試", "Synthetic later bytes"));
        check(PmcOpenPolicy.Validate(later, a).Hash != info.Hash, "SOP06 changed bytes at same repository datestamp remain distinct");
        foreach (var pmc in new[] { "", "PMC999999001.2", "PMC0", "PMC999999001?x=1", "PMC-1" })
        {
            var bad = Record(); bad.Pmcid = pmc;
            try { PmcOpenPolicy.Location(bad); throw new Exception("Malformed PMCID admitted"); }
            catch (SourceException e) { check(e.State == "unsupported", "SOP07 malformed or requested numbered PMCID rejected"); }
        }
        foreach (var code in new[] { "cannotDisseminateFormat", "idDoesNotExist", "badArgument" })
            Denied(Encoding.UTF8.GetBytes("<OAI-PMH xmlns='http://www.openarchives.org/OAI/2.0/'><error code='" + code + "'>Synthetic</error></OAI-PMH>"),
                code == "badArgument" ? "failed" : "unavailable", "SOP08 OAI error " + code);
        var policy = new DemoPolicy("Synthetic operator", "test.invalid", "Synthetic only", new string('a',40), DateTimeOffset.UtcNow.AddHours(1));
        check(policy.AcquisitionPolicy == DemoPolicy.ReviewedPolicy, "SOP09 existing default remains frozen two-identity policy");
        try { policy.RequireArticle(a); throw new Exception("Legacy policy broadened"); }
        catch(SourceException e) { check(e.State == "unavailable", "SOP09 broader PMCID denied by legacy policy"); }
        var candidate = policy with { AcquisitionPolicy = PmcOpenPolicy.Id };
        check(candidate.ValidateOriginal(xml, a).Hash == info.Hash, "SOP09 configured policy validates download/publication bytes");
        var settings = new Dictionary<string,string> { ["LITRADOCK_DEMO"]="true", ["LITRADOCK_SOURCE_REVISION"]=new string('a',40), ["LITRADOCK_DEMO_EXPIRES"]="2027-01-01T00:00:00Z", ["LITRADOCK_DEMO_OPERATOR"]="Synthetic", ["LITRADOCK_DEMO_CONTACT"]="test.invalid", ["LITRADOCK_DEMO_RETENTION"]="Synthetic", ["LITRADOCK_ACQUISITION_POLICY"]="unknown" };
        try { DemoPolicy.Read(new ConfigurationBuilder().AddInMemoryCollection(settings).Build()); throw new Exception("Unknown policy admitted"); }
        catch(InvalidOperationException) { check(true,"SOP09 unknown configured policy fails closed"); }
        using var unused = new NcbiTransport(new Handler((_,_) => throw new Exception("Metadata network unexpectedly invoked")));
        foreach (var scenario in new[] { "success", "safe-redirect", "unsafe-redirect", "cross-source", "retry", "rate", "budget", "large", "html", "partial", "cancel", "timeout" })
        {
            var calls = 0;
            using var cancellation = new CancellationTokenSource();
            using var client = new HttpClient(new Handler((request, token) =>
            {
                calls++;
                check(request.RequestUri.AbsoluteUri == PmcOpenPolicy.Location(a), "SOP10 exact supported route: " + scenario);
                if (scenario == "cancel") { cancellation.Cancel(); token.ThrowIfCancellationRequested(); }
                if (scenario == "timeout") throw new OperationCanceledException(token);
                if (scenario.Contains("redirect") || scenario == "cross-source")
                {
                    var r = new HttpResponseMessage(HttpStatusCode.Found);
                    r.Headers.Location = new Uri(scenario == "safe-redirect" ? PmcOpenPolicy.Location(a) : scenario == "cross-source" ? "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC999999001/fullTextXML" : "http://127.0.0.1/private");
                    return r;
                }
                if (scenario is "rate" or "budget" || scenario == "retry" && calls == 1)
                {
                    var r = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
                    r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(scenario == "rate" ? 60 : 0));
                    return r;
                }
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(scenario == "partial" && calls == 2 ? Encoding.UTF8.GetBytes(text.Replace("/by/4.0/", "/by-nc/4.0/")) : xml) };
                response.Content.Headers.ContentType = new(scenario == "html" ? "text/html" : "application/xml");
                if (scenario == "large") response.Content.Headers.ContentLength = NcbiTransport.MaximumBytes + 1;
                return response;
            }));
            var source = new DemoSource(new PmcOpenSource(new PubMedSource(unused), new SourceAcquisition(new PubMedSource(unused), client, client)), candidate);
            var outcomes = new List<string>();
            for (var n=0; n<(scenario == "partial" ? 3 : 1); n++)
            {
                try { var response = await source.FetchFullTextAsync(a, cancellation.Token); outcomes.Add("completed"); check(response.Bytes.SequenceEqual(xml), "SOP11 accepted response bytes unchanged"); }
                catch(SourceException e) { outcomes.Add(e.State); }
                catch(OperationCanceledException) { outcomes.Add("interrupted"); }
            }
            var expected = scenario switch { "safe-redirect" or "unsafe-redirect" or "cross-source" => "unsupported", "rate" or "budget" => "rate_wait", "large" => "failed", "html" => "challenge", "partial" => "completed,unavailable,completed", "cancel" => "interrupted", "timeout" => "transient", _ => "completed" };
            check(string.Join(',',outcomes) == expected && calls <= 3, "SOP12 truthful independent outcomes and bounded requests: " + scenario);
            if (scenario.Contains("redirect") || scenario == "cross-source") check(calls == 1,"SOP12 redirect target never contacted");
        }
        check(SourceAcquisition.Locations(a).Pmc == a.PmcUri && a.PmcUri.Contains(a.Pmcid),"SOP13 stable unresolved source links preserved");
    }
    private sealed class Handler(Func<HttpRequestMessage,CancellationToken,HttpResponseMessage> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token) => Task.FromResult(send(request,token));
    }

    public static async Task RunPostgres(string connection, string output, Action<bool,string> check)
    {
        var config = new Npgsql.NpgsqlConnectionStringBuilder(connection);
        if (!config.Database.StartsWith("litradock_ci_") || Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes")
            throw new InvalidOperationException("Explicit disposable PostgreSQL required.");
        await using (var admin = new Npgsql.NpgsqlConnection(connection))
        {
            await admin.OpenAsync();
            config.Database = "litradock_ci_policy_" + Guid.NewGuid().ToString("N")[..12];
            await using var create = new Npgsql.NpgsqlCommand("CREATE DATABASE " + config.Database,admin);
            await create.ExecuteNonQueryAsync();
        }
        var policy = new DemoPolicy("Synthetic", "test.invalid", "Disposable CI", new string('a',40),DateTimeOffset.UtcNow.AddHours(1)) { AcquisitionPolicy = PmcOpenPolicy.Id };
        await using var store = new PgStore(config.ConnectionString,policy);
        await store.Migrate(); await store.VerifyDemo();
        var account = await store.CreateAccount("synthetic-policy", "Synthetic-policy-password-2026");
        var library = await store.CreateLibrary(account,"Synthetic policy batch");
        var originals = new OriginalStore(Path.Combine(output,"synthetic-originals"));
        using var transport = new NcbiTransport(new Handler((_,_) => throw new Exception("Unexpected metadata call")));
        var calls = 0;
        using var client = new HttpClient(new Handler((request,_) =>
        {
            calls++;
            var id = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(request.RequestUri.Query)["identifier"].ToString().Split(':').Last();
            var article = Record(); article.Pmcid = "PMC" + id; article.Pmid = id; article.Doi = "10.5555/synthetic-policy-" + id;
            var bytes = Envelope(article);
            if (id == "999999002") bytes = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes).Replace("/by/4.0/","/by-nc/4.0/"));
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) { Headers = { ContentType = new("application/xml") } } };
        }));
        var source = new DemoSource(new SearchFixture(new PmcOpenSource(new PubMedSource(transport),new SourceAcquisition(new PubMedSource(transport),client,client))),policy);
        var worker = new HostedWorker(store,originals,source);
        var run = await store.Search(library,"Synthetic policy batch",3);
        await worker.ExecuteClaim(await store.ClaimNext(),CancellationToken.None);
        var scope = await store.Scope(library,run,null,"");
        var batch = await store.Batch(library,scope,false,Naming.DefaultTemplate);
        for(var n=0;n<3;n++) await worker.ExecuteClaim(await store.ClaimNext(),CancellationToken.None);
        var status = System.Text.Json.JsonSerializer.SerializeToElement(await store.BatchStatus(library,batch,0));
        var items = status.GetProperty("items").EnumerateArray().ToArray();
        check(items.Count(i=>i.GetProperty("state").GetString()=="completed")==2 && items.Count(i=>i.GetProperty("state").GetString()=="unavailable")==1 && calls==3,
            "SOP-PG01 actual worker preserves two permitted originals and one denied item without fallback");
        foreach(var item in items)
        {
            var id=item.GetProperty("search_id").GetString(); var article=await store.Article(library,id);
            var files=await store.Files(library,id);
            if(article.Pmid=="999999002") { check(files.Count==0,"SOP-PG02 denied rights publish no object association"); continue; }
            var bytes=originals.Read(library,(string)files.Single()["hash"]);
            check(bytes.SequenceEqual(Envelope(article)) && policy.ValidateOriginal(bytes,article).RightsStatus=="permitted","SOP-PG03 persisted immutable bytes and rights revalidate");
        }
        await using var db = new Npgsql.NpgsqlConnection(config.ConnectionString); await db.OpenAsync();
        await using var query = new Npgsql.NpgsqlCommand("SELECT count(*) FROM ld_files WHERE validation LIKE '%Policy pmc-oai-cc-v1%publication version unspecified%'",db);
        check(Convert.ToInt32(await query.ExecuteScalarAsync())==2,"SOP-PG04 snapshot policy/datestamp/version evidence persisted in file validation");
        var repeated=await store.Batch(library,scope,false,Naming.DefaultTemplate);
        for(var n=0;n<3;n++) await worker.ExecuteClaim(await store.ClaimNext(),CancellationToken.None);
        check(calls==4,"SOP-PG05 repeated batch revalidates preserved permitted objects without refetch; denied item remains independent");
    }
    private sealed class SearchFixture(ILiteratureSource source) : ILiteratureSource
    {
        public string Name => "Explicit synthetic policy metadata";
        public Task SearchAsync(SearchSnapshot run,CancellationToken token)
        {
            for(var n=1;n<=3;n++) { var a=Record(); a.Pmid="99999900"+n; a.Pmcid="PMC"+a.Pmid; a.Doi="10.5555/synthetic-policy-"+a.Pmid; a.SearchId=""; run.Articles.Add(a); run.SourceIds.Add(a.Pmid); }
            run.Total=3; run.State="complete"; return Task.CompletedTask;
        }
        public Task<SourceResponse> FetchFullTextAsync(Article article,CancellationToken token)=>source.FetchFullTextAsync(article,token);
    }
}
