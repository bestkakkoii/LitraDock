using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using LitraDock.Core;
using Npgsql;

namespace Literature.Service;

public sealed record ConversionClaim(
    Guid Library,
    string Id,
    string SearchId,
    string InputHash,
    string Metadata,
    string Mode,
    Guid Lease,
    string Details
);

public sealed partial class PgStore
{
    public async Task<string> QueueConversion(
        Guid library,
        string search,
        string hash,
        string mode,
        Guid actor,
        OriginalStore files
    )
    {
        var article = await Article(library, search);
        if (mode is not ("original" or "abstract"))
            throw new ArgumentException("Choose original or abstract conversion.");
        if (mode == "abstract" && article.Abstract.Length == 0)
            throw new ArgumentException("No saved abstract available.");
        if (mode == "original" && (hash == null || !await Associated(library, search, hash)))
            throw new KeyNotFoundException();
        if (mode == "abstract")
            hash = null;
        var id = "CONVERT-" + Guid.NewGuid().ToString("N");
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await Exec(db, "SELECT pg_advisory_xact_lock(hashtextextended(@p0,0))", library.ToString());
        if (
            Convert.ToInt64(
                await Scalar(
                    db,
                    "SELECT count(*) FROM ld_conversions WHERE library_id=@p0",
                    library
                )
            ) >= 10000
        )
            throw new ArgumentException("Conversion history limit reached.");
        var old = await Scalar(
            db,
            "SELECT conversion_id FROM ld_conversions WHERE library_id=@p0 AND search_id=@p1 AND input_hash IS NOT DISTINCT FROM @p2::text AND mode=@p3 AND input_metadata=@p4 AND state IN ('queued','running','completed') LIMIT 1",
            library,
            search,
            hash,
            mode,
            JsonSerializer.Serialize(article)
        );
        if (old is string existing)
        {
            var output = await Scalar(
                db,
                "SELECT output_hash FROM ld_conversions WHERE library_id=@p0 AND conversion_id=@p1",
                library,
                existing
            );
            if (output is string outputHash)
                files.Read(library, outputHash); // 已完成只在精確輸出仍通過雜湊驗證時重用；損壞證據不得被新輸出覆寫。
            return existing;
        }
        await Exec(
            db,
            "INSERT INTO ld_conversions(library_id,conversion_id,search_id,input_hash,input_metadata,mode,state,reason,actor) VALUES(@p0,@p1,@p2,@p3,@p4,@p5,'queued','Queued for a labelled reading copy.',@p6)",
            library,
            id,
            search,
            hash,
            JsonSerializer.Serialize(article),
            mode,
            actor.ToString()
        );
        await ConversionEvent(
            db,
            library,
            id,
            "queued",
            "Requested conversion; originals retained.",
            actor.ToString()
        );
        await tx.CommitAsync();
        return id;
    }

    private static Task<int> ConversionEvent(
        NpgsqlConnection db,
        Guid library,
        string id,
        string state,
        string reason,
        string actor
    ) =>
        Exec(
            db,
            "INSERT INTO ld_conversion_events VALUES(@p0,@p1,@p2,@p3,@p4,@p5,now())",
            library,
            "CE-" + Guid.NewGuid().ToString("N"),
            id,
            state,
            reason,
            actor
        );

    public async Task ControlConversion(Guid library, string id, string action, Guid actor)
    {
        var state = action switch
        {
            "pause" => "paused",
            "cancel" => "cancelled",
            "resume" => "queued",
            "retry" => "queued",
            _ => throw new ArgumentException("Unknown conversion control."),
        };
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        var old =
            (
                await Rows(
                    db,
                    "SELECT state,attempts FROM ld_conversions WHERE library_id=@p0 AND conversion_id=@p1 FOR UPDATE",
                    library,
                    id
                )
            ).SingleOrDefault() ?? throw new KeyNotFoundException();
        if ((string)old["state"] == "completed" || (state == "queued" && (int)old["attempts"] >= 3))
            throw new ArgumentException(
                "Completed conversions cannot restart; attempt limit is three."
            );
        await Exec(
            db,
            "UPDATE ld_conversions SET state=@p2,lease_token=NULL,lease_until=NULL,reason=@p3,updated_at=now() WHERE library_id=@p0 AND conversion_id=@p1",
            library,
            id,
            state,
            "User requested " + action + "."
        );
        await ConversionEvent(
            db,
            library,
            id,
            state,
            "User requested " + action + ".",
            actor.ToString()
        );
        await tx.CommitAsync();
    }

    public async Task<ConversionClaim> ClaimConversion()
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        var expired = await Rows(
            db,
            "UPDATE ld_conversions SET state='paused',reason='Processor interrupted; retained evidence requires explicit resume.',lease_token=NULL,lease_until=NULL WHERE state='running' AND lease_until<now() RETURNING library_id,conversion_id"
        );
        foreach (var r in expired)
            await ConversionEvent(
                db,
                (Guid)r["library_id"],
                (string)r["conversion_id"],
                "paused",
                "Expired process lease; deliberate continuation required.",
                "worker"
            );
        var lease = Guid.NewGuid();
        var rows = await Rows(
            db,
            "UPDATE ld_conversions SET state='running',attempts=attempts+1,lease_token=@p0,lease_until=now()+interval '120 seconds',updated_at=now() WHERE (library_id,conversion_id) IN (SELECT c.library_id,c.conversion_id FROM ld_conversions c JOIN ld_libraries l USING(library_id) WHERE c.state='queued' AND c.attempts<3 AND l.ready ORDER BY c.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 1) RETURNING *",
            lease
        );
        if (rows.Count == 0)
        {
            await tx.CommitAsync();
            return null;
        }
        var r0 = rows[0];
        var result = new ConversionClaim(
            (Guid)r0["library_id"],
            (string)r0["conversion_id"],
            (string)r0["search_id"],
            r0["input_hash"] as string,
            (string)r0["input_metadata"],
            (string)r0["mode"],
            lease,
            (string)r0["details"]
        );
        await ConversionEvent(
            db,
            result.Library,
            result.Id,
            "running",
            "Bounded document process started.",
            "worker"
        );
        await tx.CommitAsync();
        return result;
    }

    public async Task<bool> RenewConversion(ConversionClaim c)
    {
        await using var db = await Data.OpenConnectionAsync();
        return await Exec(
                db,
                "UPDATE ld_conversions SET lease_until=now()+interval '120 seconds' WHERE library_id=@p0 AND conversion_id=@p1 AND lease_token=@p2 AND state='running' AND lease_until>now()",
                c.Library,
                c.Id,
                c.Lease
            ) == 1;
    }

    internal static async Task FenceConversion(NpgsqlConnection db, ConversionClaim c)
    {
        if (
            await Scalar(
                db,
                "SELECT conversion_id FROM ld_conversions WHERE library_id=@p0 AND conversion_id=@p1 AND lease_token=@p2 AND state='running' AND lease_until>now() FOR UPDATE",
                c.Library,
                c.Id,
                c.Lease
            ) == null
        )
            throw new OperationCanceledException("Conversion lease revoked.");
    }

    public async Task PrepareConversion(ConversionClaim c, JsonObject details)
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await FenceConversion(db, c);
        await Exec(
            db,
            "UPDATE ld_conversions SET details=@p2,reason='Validated output staged; publication pending.' WHERE library_id=@p0 AND conversion_id=@p1",
            c.Library,
            c.Id,
            details.ToJsonString()
        );
        await tx.CommitAsync();
    }

    public async Task FinishConversion(
        ConversionClaim c,
        OriginalStore files,
        byte[] bytes,
        JsonObject details,
        Action<string> checkpoint = null
    )
    {
        var hash = Artifacts.Hash(bytes);
        if (details["hash"]?.GetValue<string>() != hash)
            throw new IOException("Derived hash disagrees.");
        var inputHash = c.InputHash ?? Artifacts.Hash(Encoding.UTF8.GetBytes(c.Metadata));
        if (
            details["inputHash"]?.ToString() != inputHash
            || (c.Mode == "abstract" && details["kind"]?.ToString() != "Abstract Only")
        )
            throw new IOException("Prepared conversion input provenance disagrees.");
        await PdfInspection.Inspect(
            bytes,
            new Article { SearchId = c.SearchId },
            false,
            details["kind"].GetValue<string>()
        );
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        await FenceConversion(db, c);
        var stage = files.RetainedStage(c.Library, details["stage"]!.GetValue<string>());
        if (File.Exists(stage))
            files.Publish(c.Library, hash, stage);
        else
            files.Read(c.Library, hash);
        checkpoint?.Invoke("published");
        await Exec(
            db,
            "INSERT INTO ld_files VALUES(@p0,@p1,@p2,@p3,@p4) ON CONFLICT DO NOTHING",
            c.Library,
            hash,
            bytes.LongLength,
            OriginalValidation.PdfKind,
            "Generated labelled reading PDF; not an original acquisition."
        );
        await Exec(
            db,
            "INSERT INTO ld_derivations VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,now())",
            c.Library,
            "DERIVED-" + Guid.NewGuid().ToString("N"),
            c.SearchId,
            c.Id,
            c.InputHash,
            hash,
            details["kind"]!.GetValue<string>(),
            details.ToJsonString()
        );
        await Exec(
            db,
            "UPDATE ld_conversions SET state='completed',output_hash=@p2,reason='Labelled reading copy published; inspect coverage limitations.',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE library_id=@p0 AND conversion_id=@p1",
            c.Library,
            c.Id,
            hash
        );
        await ConversionEvent(
            db,
            c.Library,
            c.Id,
            "completed",
            "Validated derived bytes and exact input provenance committed.",
            "worker"
        );
        await tx.CommitAsync();
    }

    public async Task FailConversion(ConversionClaim c, string state, string reason)
    {
        await using var db = await Data.OpenConnectionAsync();
        await using var tx = await db.BeginTransactionAsync();
        if (
            await Exec(
                db,
                "UPDATE ld_conversions SET state=@p3,reason=@p4,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE library_id=@p0 AND conversion_id=@p1 AND lease_token=@p2 AND state='running'",
                c.Library,
                c.Id,
                c.Lease,
                state,
                reason
            ) == 1
        )
            await ConversionEvent(db, c.Library, c.Id, state, reason, "worker");
        await tx.CommitAsync();
    }
}

public sealed class ReadingWorker(PgStore store, OriginalStore files) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var gate = await ResourceAdmission.Enter(store, heavy: true);
                var c = await store.ClaimConversion();
                if (c != null)
                    await Execute(c, stoppingToken);
            }
            catch (ResourceBusyException) { }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch
            {
                Console.Error.WriteLine("Reading worker interrupted; durable state retained.");
            }
            await Task.Delay(750, stoppingToken);
        }
    }

    public async Task Execute(
        ConversionClaim c,
        CancellationToken token,
        Action<string> checkpoint = null
    )
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        var renew = Task.Run(async () =>
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    await Task.Delay(1000, stop.Token);
                    if (!await store.RenewConversion(c))
                    {
                        stop.Cancel();
                        break;
                    }
                }
            }
            catch
            {
                stop.Cancel();
            }
        });
        try
        {
            files.Admit(c.Library, 64L * 1024 * 1024);
            var prepared = JsonNode.Parse(c.Details)?.AsObject();
            if (prepared?["hash"] != null)
            {
                byte[] prior;
                try
                {
                    prior = files.Read(c.Library, prepared["hash"]!.GetValue<string>());
                }
                catch (IOException)
                {
                    prior = Artifacts.ReadBoundedFile(
                        files.RetainedStage(c.Library, prepared["stage"]!.GetValue<string>())
                    );
                }
                await store.FinishConversion(c, files, prior, prepared, checkpoint);
                return;
            }
            var article = JsonSerializer.Deserialize<Article>(c.Metadata);
            var source = article.Abstract;
            var format = "text";
            if (c.Mode == "original")
            {
                var original = files.Read(c.Library, c.InputHash);
                if (OriginalValidation.Kind(original) == OriginalValidation.PdfKind)
                    throw new IOException(
                        "Original PDF is preserved; PDF reflow and scanned OCR are not supported. Use the original or an explicitly labelled Abstract Only copy."
                    );
                var kind = OriginalValidation.Kind(original);
                source =
                    kind == OriginalValidation.XmlKind
                        ? Metadata.ParseXml(original).Root.ToString()
                        : new UTF8Encoding(false, true).GetString(original);
                format =
                    kind == OriginalValidation.HtmlKind ? "html"
                    : kind == OriginalValidation.TextKind ? "text"
                    : "xml";
            }
            var inputHash = c.InputHash ?? Artifacts.Hash(Encoding.UTF8.GetBytes(c.Metadata));
            var result = await DocumentProcess.Run(
                new
                {
                    operation = "reading",
                    id = c.SearchId,
                    title = article.Title,
                    source,
                    format,
                    mode = c.Mode,
                    inputHash,
                },
                stop.Token
            );
            var bytes = Convert.FromBase64String(result["pdf"]!.GetValue<string>());
            result.Remove("pdf");
            if (
                OriginalValidation.Kind(bytes) != OriginalValidation.PdfKind
                || bytes.Length > 32 * 1024 * 1024
            )
                throw new IOException("Renderer returned invalid PDF.");
            var lease = Guid.NewGuid();
            var stage = files.Stage(
                new Claim(c.Library, c.Id, "conversion", null, null, c.SearchId, lease),
                bytes
            );
            result["hash"] = Artifacts.Hash(bytes);
            result["stage"] = lease.ToString("N");
            result["inputHash"] = inputHash;
            result["converter"] = "semantic-reading/1";
            await store.PrepareConversion(c, result);
            checkpoint?.Invoke("prepared");
            await store.FinishConversion(c, files, bytes, result, checkpoint);
        }
        catch (OperationCanceledException)
        {
            await store.FailConversion(
                c,
                "paused",
                "Conversion stopped; explicit resume required and original preserved."
            );
        }
        catch (Exception error)
        {
            await store.FailConversion(c, "failed", Artifacts.SafeMessage(error));
        }
        finally
        {
            stop.Cancel();
            await renew;
        }
    }
}
