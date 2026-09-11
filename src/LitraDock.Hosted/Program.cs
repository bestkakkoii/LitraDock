using System.Net;
using System.Threading.RateLimiting;
using Literature.Service;
using LitraDock.Core;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.HttpOverrides;

if (args.FirstOrDefault() == "--inspect-pdf")
{
    try
    {
        var input = System.Text.Json.JsonSerializer.Deserialize<PdfInspection.Input>(
            Console.In.ReadToEnd()
        );
        if (input.Bytes.Length > NcbiTransport.MaximumBytes)
            throw new SourceException("failed", "PDF exceeds size limit.");
        Console.Write(
            System.Text.Json.JsonSerializer.Serialize(
                new PdfInspection.Output(
                    OriginalValidation.ValidatePdf(input.Bytes, input.Article, input.Confirmed),
                    null,
                    null
                )
            )
        );
    }
    catch (Exception error)
    {
        Console.Write(
            System.Text.Json.JsonSerializer.Serialize(
                new PdfInspection.Output(
                    null,
                    (error as SourceException)?.State ?? "failed",
                    Artifacts.SafeMessage(error)
                )
            )
        );
    }
    return;
}
var builder = WebApplication.CreateBuilder(args);
var connection = builder.Configuration["LITRADOCK_POSTGRES"];
var storage = builder.Configuration["LITRADOCK_OBJECTS"];
if (string.IsNullOrWhiteSpace(connection) || string.IsNullOrWhiteSpace(storage))
    throw new InvalidOperationException(
        "LITRADOCK_POSTGRES and LITRADOCK_OBJECTS must be configured; no fallback backend."
    );
await using var store = new PgStore(connection);
var originals = new OriginalStore(storage);
originals.VerifyPrivateRoot(builder.Environment.ContentRootPath);
originals.VerifyWebRoot(
    builder.Environment.WebRootPath ?? Path.Combine(builder.Environment.ContentRootPath, "wwwroot")
);
if (args.Contains("--migrate"))
{
    await store.Migrate();
    Console.WriteLine("Hosted schema verified.");
    return;
}
if (args.Contains("--create-account"))
{
    var login = builder.Configuration["LITRADOCK_INITIAL_LOGIN"];
    var password = builder.Configuration["LITRADOCK_INITIAL_PASSWORD"];
    if (login == null || password == null)
        throw new InvalidOperationException(
            "Provide initial account values through protected process configuration."
        );
    Console.WriteLine("Account created: " + await store.CreateAccount(login, password));
    return;
}
await store.VerifySchema();
if (args.Contains("--import"))
{
    var copy = builder.Configuration["LITRADOCK_IMPORT_COPY"];
    if (
        copy == null
        || !Guid.TryParse(builder.Configuration["LITRADOCK_IMPORT_OWNER"], out var owner)
    )
        throw new InvalidOperationException(
            "Configure a stopped SQLite copy and destination owner UUID."
        );
    Console.WriteLine(
        "Imported library: "
            + await store.ImportStoppedCopy(
                owner,
                builder.Configuration["LITRADOCK_IMPORT_NAME"] ?? "Imported library",
                copy,
                originals
            )
    );
    return;
}
var local = builder.Configuration["LITRADOCK_LOCAL_TEST"] == "true";
if (
    !Uri.TryCreate(builder.Configuration["LITRADOCK_ORIGIN"], UriKind.Absolute, out var origin)
    || origin.AbsolutePath != "/"
    || origin.Query != ""
    || origin.Fragment != ""
    || origin.UserInfo != ""
    || (!local && origin.Scheme != "https")
    || (local && (origin.Scheme != "http" || origin.Host != "127.0.0.1"))
)
    throw new InvalidOperationException(
        "Configure an exact HTTPS public origin, or explicit loopback-only local test origin."
    );
if (builder.Configuration.GetSection("Kestrel:Endpoints").Exists())
    throw new InvalidOperationException("Use the reviewed loopback ingress configuration.");
var port = int.Parse(builder.Configuration["LITRADOCK_PORT"] ?? "5275");
builder.WebHost.ConfigureKestrel(options =>
{
    options.Listen(IPAddress.Loopback, port);
    options.Limits.MaxRequestBodySize = 16384;
});
builder.Logging.ClearProviders();
builder.Services.AddSingleton(store);
builder.Services.AddSingleton(originals);
using var transport = new NcbiTransport(
    new SourceRequestHandler(store, SourceEndpoints.CreateHandler())
);
using var ncbi = new HttpClient(new SourceRequestHandler(store, SourceEndpoints.CreateHandler()))
{
    Timeout = TimeSpan.FromSeconds(90),
};
using var europe = new HttpClient(
    new SourceRequestHandler(store, SourceEndpoints.CreateHandler(), "europepmc")
)
{
    Timeout = TimeSpan.FromSeconds(90),
};
#if HOSTED_BROWSER_FIXTURE
builder.Services.AddSingleton<ILiteratureSource>(new Literature.Verification.BrowserFixture());
#else
builder.Services.AddSingleton<ILiteratureSource>(
    new SourceAcquisition(new PubMedSource(transport), ncbi, europe)
);
#endif
builder.Services.AddHostedService<HostedWorker>();
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = 429;
    options.AddPolicy(
        "login",
        context =>
            RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 10,
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0,
                }
            )
    );
});
var proxy = builder.Configuration["LITRADOCK_PROXY_IP"];
if (proxy != null)
    builder.Services.Configure<ForwardedHeadersOptions>(options =>
    {
        options.ForwardedHeaders = ForwardedHeaders.XForwardedProto;
        options.KnownProxies.Clear();
        options.KnownIPNetworks.Clear();
        options.KnownProxies.Add(IPAddress.Parse(proxy));
        options.ForwardLimit = 1;
    });
var app = builder.Build();
if (proxy != null)
    app.UseForwardedHeaders();
app.UseRouting();
app.UseRateLimiter();
app.Use(
    async (context, next) =>
    {
        if (context.Request.Host.Value != origin.Authority || (!local && !context.Request.IsHttps))
        {
            context.Response.StatusCode = 403;
            return;
        }
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        context.Response.Headers["Referrer-Policy"] = "no-referrer";
        context.Response.Headers.ContentSecurityPolicy =
            "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
        if (!local)
            context.Response.Headers.StrictTransportSecurity = "max-age=31536000";
        if (context.Request.Path.StartsWithSegments("/api"))
        {
            var write = context.Request.Method != "GET";
            if (
                write
                && (
                    context.Request.Headers.Origin != origin.GetLeftPart(UriPartial.Authority)
                    || (
                        !context.Request.HasJsonContentType()
                        && !(
                            context.GetEndpoint()?.Metadata.GetMetadata<ManualUpload>() != null
                            && context.Request.ContentType == "application/octet-stream"
                        )
                    )
                )
            )
            {
                context.Response.StatusCode = 403;
                return;
            }
            if (context.Request.Path != "/api/login")
            {
                var session = await store.Authenticate(
                    context.Request.Cookies["__Host-LitraDock"]
                        ?? (local ? context.Request.Cookies["LitraDockTest"] : null)
                );
                if (session == null)
                {
                    context.Response.StatusCode = 401;
                    return;
                }
                if (write && !PgStore.Equal(context.Request.Headers["X-CSRF"], session.Csrf))
                {
                    context.Response.StatusCode = 403;
                    return;
                }
                context.Items["session"] = session;
                if (
                    context.Request.RouteValues.TryGetValue("library", out var value)
                    && (
                        !Guid.TryParse(value?.ToString(), out var library)
                        || !await store.Owns(session.Account, library)
                    )
                )
                {
                    context.Response.StatusCode = 404;
                    return;
                }
            }
        }
        try
        {
            await next();
        }
        catch (KeyNotFoundException)
        {
            context.Response.StatusCode = 404;
        }
        catch (Exception error)
            when (error
                    is ArgumentException
                        or InvalidOperationException
                        or IOException
                        or SourceException
            )
        {
            context.Response.StatusCode = 409;
            await context.Response.WriteAsJsonAsync(new { error = Artifacts.SafeMessage(error) });
        }
        catch (Exception)
        {
            context.Response.StatusCode = 503;
            await context.Response.WriteAsJsonAsync(
                new { error = "Operation unavailable; no completion assumed." }
            );
        }
    }
);
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapPost(
        "/api/login",
        async (LoginRequest input, HttpContext context) =>
        {
            var result = await store.Login(input.Login ?? "", input.Password ?? "");
            if (result == null)
                return Results.Unauthorized();
            context.Response.Cookies.Append(
                local ? "LitraDockTest" : "__Host-LitraDock",
                result.Value.Token,
                new CookieOptions
                {
                    HttpOnly = true,
                    Secure = !local,
                    SameSite = SameSiteMode.Strict,
                    Path = "/",
                    MaxAge = TimeSpan.FromHours(8),
                }
            );
            return Results.Ok(new { csrf = result.Value.Session.Csrf });
        }
    )
    .RequireRateLimiting("login");
app.MapGet(
    "/api/session",
    (HttpContext context) => new { csrf = ((Session)context.Items["session"]).Csrf }
);
app.MapPost(
    "/api/logout",
    async (HttpContext context) =>
    {
        await store.Revoke((Session)context.Items["session"]);
        context.Response.Cookies.Delete(
            local ? "LitraDockTest" : "__Host-LitraDock",
            new CookieOptions
            {
                Secure = !local,
                HttpOnly = true,
                SameSite = SameSiteMode.Strict,
                Path = "/",
            }
        );
        return Results.Ok();
    }
);
app.MapGet(
    "/api/libraries",
    async (HttpContext context, int? offset) =>
        Results.Ok(await store.Libraries(((Session)context.Items["session"]).Account, offset ?? 0))
);
app.MapPost(
    "/api/libraries",
    async (Name input, HttpContext context) =>
        new
        {
            id = await store.CreateLibrary(
                ((Session)context.Items["session"]).Account,
                input.Value
            ),
        }
);
app.MapGet(
    "/api/libraries/{library:guid}",
    (Guid library, int? offset) => store.Catalog(library, offset ?? 0)
);
app.MapPost(
    "/api/libraries/{library:guid}/search",
    async (Guid library, Search input) =>
        new { id = await store.Search(library, input.Query, input.Limit) }
);
app.MapPost(
    "/api/libraries/{library:guid}/scopes",
    async (Guid library, Scope input) =>
        new { id = await store.Scope(library, input.Run, input.Parent, input.Text) }
);
app.MapGet(
    "/api/libraries/{library:guid}/scopes/{scope}",
    (Guid library, string scope, int? offset) => store.Page(library, scope, offset ?? 0)
);
app.MapPost(
    "/api/libraries/{library:guid}/scopes/{scope}/select",
    async (Guid library, string scope, Selection input) =>
    {
        await store.Select(library, scope, input.Id, input.Selected);
        return Results.Ok();
    }
);
app.MapPost(
    "/api/libraries/{library:guid}/batches",
    async (Guid library, Batch input) =>
        new
        {
            id = await store.Batch(
                library,
                input.Scope,
                input.SelectedOnly,
                input.Template ?? Naming.DefaultTemplate
            ),
        }
);
app.MapGet(
    "/api/libraries/{library:guid}/batches/{batch}",
    (Guid library, string batch, int? offset) => store.BatchStatus(library, batch, offset ?? 0)
);
app.MapPost(
    "/api/libraries/{library:guid}/batches/{batch}/control",
    async (Guid library, string batch, Control input) =>
    {
        await store.Control(library, batch, input.Action);
        return Results.Ok();
    }
);
app.MapGet(
    "/api/libraries/{library:guid}/records/{id}",
    async (Guid library, string id) =>
        new
        {
            article = await store.Article(library, id),
            files = await store.Files(library, id),
            provenance = await store.Provenance(library, id),
            locations = SourceAcquisition.Locations(await store.Article(library, id)),
        }
);
app.MapGet(
    "/api/libraries/{library:guid}/records/{id}/files/{hash}",
    async (Guid library, string id, string hash) =>
    {
        if (!await store.Associated(library, id, hash))
            return Results.NotFound();
        var bytes = originals.Read(library, hash);
        var kind = OriginalValidation.Kind(bytes);
        return Results.File(
            bytes,
            kind == OriginalValidation.PdfKind ? "application/pdf" : "application/xml",
            await store.OriginalName(library, id, hash, kind)
        );
    }
);
app.MapPost(
    "/api/libraries/{library:guid}/records/{id}/name-preview",
    async (Guid library, string id, Name input) =>
        new
        {
            name = Naming.Preview(await store.Article(library, id), input.Value),
            note = "XML example; the downloaded original uses its validated XML/PDF extension and an eight-character hash suffix.",
        }
);
app.MapPost(
    "/api/libraries/{library:guid}/scopes/{scope}/export",
    async (Guid library, string scope, ExportOptions input) =>
        Results.File(
            await store.ExportComplete(library, scope, input.SelectedOnly),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "LitraDock.xlsx"
        )
);
app.MapGet(
    "/api/libraries/{library:guid}/history",
    (Guid library, int? offset) => store.History(library, offset ?? 0)
);
app.MapPost(
    "/api/libraries/{library:guid}/scopes/{scope}/csv",
    async (Guid library, string scope, ExportOptions input) =>
        Results.File(
            await store.ExportComplete(library, scope, input.SelectedOnly, true),
            "application/zip",
            "literature-csv.zip"
        )
);
app.MapPost(
    "/api/libraries/{library:guid}/records/{id}/manual-item",
    (Guid library, string id) => store.ManualItem(library, id)
);
app.MapGet("/api/sources", () => SourceAcquisition.Capabilities);
app.MapPost(
    "/api/libraries/{library:guid}/records/{id}/manual/{item}/confirm",
    async (Guid library, string id, string item) =>
        Results.Ok(new { job = await store.ConfirmManual(library, id, item), state = "queued" })
);
var uploadGate = new SemaphoreSlim(2, 2);
app.MapPost(
        "/api/libraries/{library:guid}/records/{id}/manual/{item}",
        async (Guid library, string id, string item, HttpContext context) =>
        {
            if (!await uploadGate.WaitAsync(0, context.RequestAborted))
                return Results.StatusCode(429);
            try
            {
                context.Features.Get<IHttpMaxRequestBodySizeFeature>().MaxRequestBodySize =
                    NcbiTransport.MaximumBytes;
                if (context.Request.ContentLength > NcbiTransport.MaximumBytes)
                    return Results.StatusCode(413);
                using var bytes = new MemoryStream();
                var chunk = new byte[65536];
                int count;
                while (
                    (count = await context.Request.Body.ReadAsync(chunk, context.RequestAborted))
                    != 0
                )
                {
                    if (bytes.Length + count > NcbiTransport.MaximumBytes)
                        return Results.StatusCode(413);
                    bytes.Write(chunk, 0, count);
                }
                var job = await store.QueueManual(
                    library,
                    id,
                    item,
                    bytes.ToArray(),
                    context.Request.Headers["X-Original-Source"].ToString(),
                    context.Request.Headers["X-Original-Version"].ToString(),
                    originals
                );
                return Results.Ok(
                    new
                    {
                        job,
                        message = "Manual input retained; inspect batch status for identity review or durable publication.",
                    }
                );
            }
            finally
            {
                uploadGate.Release();
            }
        }
    )
    .WithMetadata(new ManualUpload());
Console.WriteLine(
    "Hosted service configured; database verified; private storage remains outside the web root."
);
await app.RunAsync();

record LoginRequest(string Login, string Password);

record Name(string Value);

record Search(string Query, int Limit);

record Scope(string Run, string Parent, string Text);

record Selection(string Id, bool Selected);

record Batch(string Scope, bool SelectedOnly, string Template);

record Control(string Action);

record ManualUpload;

record ExportOptions(bool SelectedOnly);
