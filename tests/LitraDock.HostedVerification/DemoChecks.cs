using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Literature.Service;
using LitraDock.Core;
using Npgsql;

public static class DemoChecks
{
    public static async Task Run(string connection, string output, Action<bool, string> check)
    {
        var config = new NpgsqlConnectionStringBuilder(connection);
        if (!config.Database.StartsWith("litradock_ci_") || Environment.GetEnvironmentVariable("LITRADOCK_ALLOW_EPHEMERAL_TEST") != "yes")
            throw new InvalidOperationException("Explicit disposable PostgreSQL required.");
        await using (var admin = new NpgsqlConnection(connection))
        {
            await admin.OpenAsync();
            config.Database = "litradock_ci_demo_" + Guid.NewGuid().ToString("N")[..12];
            await using var create = new NpgsqlCommand("CREATE DATABASE " + config.Database, admin);
            await create.ExecuteNonQueryAsync();
        }
        var policy = new DemoPolicy("Synthetic verification", "test.invalid", "Disposable CI database only", new string('a',40), DateTimeOffset.UtcNow.AddHours(1));
        await using var store = new PgStore(config.ConnectionString, policy);
        await store.Migrate(); await store.VerifyDemo();
        await using var db = new NpgsqlConnection(config.ConnectionString); await db.OpenAsync();
        async Task<long> Sql(string sql)
        {
            await using var cmd = new NpgsqlCommand(sql, db);
            return Convert.ToInt64(await cmd.ExecuteScalarAsync());
        }
        async Task Reject(Func<Task> action, string name)
        {
            var rejected = false;
            try { await action(); } catch (Exception e) when(e is ArgumentException or InvalidOperationException or SourceException) { rejected = true; }
            check(rejected, name);
        }
        var settings = new Dictionary<string,string> {
            ["LITRADOCK_DEMO"]="true",["LITRADOCK_DEMO_OPERATOR"]="Synthetic CI operator",
            ["LITRADOCK_DEMO_CONTACT"]="Disposable CI; no public contact",["LITRADOCK_DEMO_RETENTION"]="Disposable CI teardown",
            ["LITRADOCK_SOURCE_REVISION"]=new string('a',40),["LITRADOCK_DEMO_EXPIRES"]="2099-01-01T00:00:00+08:00"};
        DemoPolicy Config() => DemoPolicy.Read(new ConfigurationBuilder().AddInMemoryCollection(settings).Build());
        check(Config().ExpiresAt.Offset==TimeSpan.FromHours(8),"DEMO27 explicit-offset configuration preserves its instant");
        settings["LITRADOCK_DEMO_EXPIRES"]="2099-01-01";
        await Reject(()=>Task.FromResult(Config()),"DEMO27 timezone-free expiry rejected");
        settings["LITRADOCK_DEMO_EXPIRES"]="2099-01-01T00:00:00Z";
        foreach(var key in new[]{"LITRADOCK_DEMO_OPERATOR","LITRADOCK_DEMO_CONTACT","LITRADOCK_DEMO_RETENTION"}) {
            var value=settings[key];settings[key]="REQUIRED_ACTUAL_VALUE";
            await Reject(()=>Task.FromResult(Config()),"DEMO27 deployment placeholder rejected: "+key);settings[key]=value;
        }
        const string password = "Synthetic-demo-password-2026";
        var owner = await store.CreateAccount("demo-owner", password);
        var library = await store.CreateLibrary(owner, "Demo quota 中文");
        var attempts = await Task.WhenAll(Enumerable.Range(0,8).Select(async n => {
            try { await store.CreateLibrary(owner,"Contender " + n); return true; }
            catch(InvalidOperationException) { return false; }
        }));
        check(attempts.Count(x=>x)==1 && await Sql("SELECT count(*) FROM ld_libraries")==2, "DEMO01 eight concurrent library creators admit exactly one remaining account slot");
        await Reject(()=>store.Search(library,"too broad",101), "DEMO02 search size is rejected before durable insertion");
        check(await Sql("SELECT count(*) FROM ld_runs")==0, "DEMO02 rejected search leaves no run or job");
        var run = await store.Search(library,"Synthetic quota records",100);
        var claim = await store.ClaimNext();
        var snapshot = new SearchSnapshot { RunId=run, Input="Synthetic quota records", Limit=100 };
        await new FixtureSource().SearchAsync(snapshot,CancellationToken.None);
        snapshot.Articles.RemoveRange(20,100); snapshot.SourceIds.RemoveRange(20,100);
        await store.SaveSearch(claim,snapshot); await store.Finish(claim,"completed","Synthetic demo quota setup");
        var scope = await store.Scope(library,run,null,"");
        await Reject(()=>store.Batch(library,scope,false,Naming.DefaultTemplate),"DEMO03 oversized batch is rejected atomically");
        check(await Sql("SELECT count(*) FROM ld_batches")==0 && await Sql("SELECT count(*) FROM ld_items")==0, "DEMO03 no orphan batch or item after size denial");
        var rows = JsonSerializer.SerializeToElement(await store.Page(library,scope,0)).GetProperty("records");
        foreach(var row in rows.EnumerateArray().Take(10))
            await store.Select(library,scope,row.GetProperty("article").GetProperty("SearchId").GetString(),true);
        var first = await store.Batch(library,scope,true,Naming.DefaultTemplate);
        var second = await store.Batch(library,scope,true,Naming.DefaultTemplate);
        await Reject(()=>store.Batch(library,scope,true,Naming.DefaultTemplate),"DEMO04 account queue capacity rejects excess batch");
        await store.Control(library,first,"paused");
        await store.Batch(library,scope,true,Naming.DefaultTemplate);
        await Reject(()=>store.Control(library,first,"resume"),"DEMO04 resume cannot bypass full queue capacity");
        check(JsonSerializer.SerializeToElement(await store.BatchStatus(library,first,0)).GetProperty("state").GetString()=="paused", "DEMO04 denied resume preserves paused state and jobs");
        var claimed = await store.ClaimNext();
        await store.Schedule(claimed,"transient","Synthetic source interruption"); await store.AdvanceSchedule();
        check(await Sql("SELECT count(*) FROM ld_retry WHERE status='pending'")==0,"DEMO05 automatic retry cannot bypass lifetime job admission");
        using var ncbi = new HttpMessageInvoker(new SourceRequestHandler(store,new NoNetwork()));
        using var europe = new HttpMessageInvoker(new SourceRequestHandler(store,new NoNetwork(),"europepmc"));
        await Sql("INSERT INTO ld_source_usage VALUES('ncbi','2000-01-01',250),('europepmc','2000-01-01',250) RETURNING requests");
        foreach(var entry in new[]{(ncbi,"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"),(europe,"https://www.ebi.ac.uk/europepmc/webservices/rest/PMC6836491/fullTextXML")})
            await Reject(()=>entry.Item1.SendAsync(new(HttpMethod.Get,entry.Item2),CancellationToken.None),"DEMO06 provider lifetime budget denies before network; past date does not reset it");
        var source = new DemoSource(new FixtureSource(),policy);
        await Reject(()=>source.FetchFullTextAsync(new Article{Pmid="123"},CancellationToken.None),"DEMO07 unreviewed acquisition denied before provider call");
        await using var expired = new PgStore(config.ConnectionString,policy with{ExpiresAt=DateTimeOffset.UtcNow.AddSeconds(-1)});
        await Reject(()=>expired.Search(library,"Expired demo",1),"DEMO08 expired service denies new durable work");
        check(!typeof(PgStore).Assembly.GetTypes().Any(t=>t.Name.Contains("Fixture")||t.Name=="IdentityBarrier"),"DEMO09 production assembly excludes fixture and identity barrier types");
        await using var normal = new PgStore(config.ConnectionString);
        check((await normal.Article(library,rows[0].GetProperty("article").GetProperty("SearchId").GetString())).Title.Contains("測試"),"DEMO10 original multilingual research records remain readable outside demo policy");
        await Sql("UPDATE ld_jobs SET state='paused' WHERE state IN ('queued','running','scheduled') RETURNING 1");
        await store.Select(library,scope,null,false);
        await store.Select(library,scope,rows[0].GetProperty("article").GetProperty("SearchId").GetString(),true);
        var stable = await store.Batch(library,scope,true,Naming.DefaultTemplate);
        check(await Sql($"SELECT count(*) FROM ld_items WHERE batch_id='{stable}'")==1,"DEMO25 stable one-record batch positive control");
        await using(var gate = new NpgsqlConnection(config.ConnectionString))
        {
            await gate.OpenAsync();
            await using(var hold = new NpgsqlCommand("SELECT pg_advisory_lock(724913015)",gate)) await hold.ExecuteNonQueryAsync();
            var pending = store.Batch(library,scope,true,Naming.DefaultTemplate);
            try
            {
                var waiting = false;
                for(var n=0;n<100;n++)
                {
                    if(await Sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock(724913015)%'")>0) {waiting=true;break;}
                    await Task.Delay(10);
                }
                check(waiting,"DEMO25 actual batch reaches PostgreSQL quota lock before selection mutation");
                await store.Select(library,scope,null,true);
                check(await Sql($"SELECT count(*) FROM ld_members WHERE scope_id='{scope}' AND selected")==20,"DEMO25 concurrent selection expands to twenty committed rows");
            }
            finally {await using var release = new NpgsqlCommand("SELECT pg_advisory_unlock(724913015)",gate);await release.ExecuteNonQueryAsync();}
            var raced = await pending;
            check(await Sql($"SELECT count(*) FROM ld_items WHERE batch_id='{raced}'")==1,"DEMO25 quota admission and insertion use the same original one-record snapshot");
            await Reject(()=>store.Batch(library,scope,true,Naming.DefaultTemplate),"DEMO25 next batch sees twenty selected rows and rejects oversized admission");
        }
        await File.WriteAllTextAsync(Path.Combine(output,"demo-environment.json"),JsonSerializer.Serialize(new {postgres=await db.PostgresVersionAsync(), sourceRequests=0, concurrency=8, scope="Actual disposable PostgreSQL with production admission methods; synthetic metadata, no external requests"}));
    }
    private sealed class NoNetwork : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token) => throw new Exception("Unexpected external request escaped demo budget.");
    }
    private static Task<string> PostgresVersionAsync(this NpgsqlConnection db) => Task.FromResult(db.PostgreSqlVersion.ToString());
}
