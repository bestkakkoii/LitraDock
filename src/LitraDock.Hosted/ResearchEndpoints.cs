using System.Text;
using System.Text.Json;
using LitraDock.Core;

namespace Literature.Service;

public static class ResearchEndpoints
{
    public static void MapResearch(this WebApplication app, PgStore store, OriginalStore files)
    {
        app.MapGet(
            "/api/libraries/{library:guid}/projects",
            (Guid library) => store.Projects(library)
        );
        app.MapPost(
            "/api/libraries/{library:guid}/projects",
            async (Guid library, ProjectName input) =>
                new { id = await store.CreateProject(library, input.Name) }
        );
        app.MapGet(
            "/api/libraries/{library:guid}/projects/{project}",
            (Guid library, string project, int? offset) =>
                store.Reviews(library, project, offset ?? 0)
        );
        app.MapPost(
            "/api/libraries/{library:guid}/projects/{project}/records/{search}",
            async (
                Guid library,
                string project,
                string search,
                ReviewInput input,
                HttpContext context
            ) =>
                new
                {
                    revision = await store.SaveReview(
                        library,
                        project,
                        search,
                        ((Session)context.Items["session"]).Account,
                        input
                    ),
                }
        );
        app.MapGet(
            "/api/libraries/{library:guid}/records/{search}/research",
            (Guid library, string search, int? offset) =>
                store.ResearchRecord(library, search, offset ?? 0)
        );
        app.MapPost(
            "/api/libraries/{library:guid}/records/{search}/conversions",
            async (Guid library, string search, ConversionInput input, HttpContext context) =>
                new
                {
                    id = await store.QueueConversion(
                        library,
                        search,
                        input.Hash,
                        input.Mode,
                        ((Session)context.Items["session"]).Account,
                        files
                    ),
                }
        );
        app.MapPost(
            "/api/libraries/{library:guid}/conversions/{id}/control",
            async (Guid library, string id, ConversionControl input, HttpContext context) =>
            {
                await store.ControlConversion(
                    library,
                    id,
                    input.Action,
                    ((Session)context.Items["session"]).Account
                );
                return Results.Ok();
            }
        );
        app.MapGet(
            "/api/libraries/{library:guid}/records/{search}/derived/{id}/files",
            async (Guid library, string search, string id) =>
            {
                await using var db = await store.Data.OpenConnectionAsync();
                var row = (
                    await PgStore.Rows(
                        db,
                        "SELECT hash,kind FROM ld_derivations WHERE library_id=@p0 AND search_id=@p1 AND derivation_id=@p2",
                        library,
                        search,
                        id
                    )
                ).SingleOrDefault();
                if (row == null)
                    return Results.NotFound();
                var bytes = files.Read(library, (string)row["hash"]);
                return Results.File(
                    bytes,
                    "application/pdf",
                    search
                        + "_"
                        + ((string)row["kind"]).Replace(' ', '_')
                        + "_"
                        + ((string)row["hash"])[..12]
                        + ".pdf"
                );
            }
        );
        app.MapPost(
            "/api/libraries/{library:guid}/scopes/{scope}/bundle",
            async (Guid library, string scope, ScopeBundle input) =>
            {
                var path = await store.ExportBundle(library, files, scope, input.SelectedOnly);
                return Results.File(
                    new FileStream(
                        path,
                        FileMode.Open,
                        FileAccess.Read,
                        FileShare.None,
                        65536,
                        FileOptions.DeleteOnClose
                    ),
                    "application/zip",
                    "selected-library.zip"
                );
            }
        );
        app.MapPost(
            "/api/libraries/{library:guid}/scopes/{scope}/citations",
            async (Guid library, string scope, CitationOptions input, HttpContext context) =>
            {
                var output = await store.CitationExport(
                    library,
                    scope,
                    input.SelectedOnly,
                    input.Style,
                    context.RequestAborted
                );
                return input.Format switch
                {
                    "ris" => Results.File(
                        Encoding.UTF8.GetBytes(output["ris"].ToString()),
                        "application/x-research-info-systems",
                        "references.ris"
                    ),
                    "bibtex" => Results.File(
                        Encoding.UTF8.GetBytes(output["bibtex"].ToString()),
                        "application/x-bibtex",
                        "references.bib"
                    ),
                    "csl-json" => Results.File(
                        Encoding.UTF8.GetBytes(output["items"].ToJsonString()),
                        "application/json",
                        "references.csl.json"
                    ),
                    "text" => Results.File(
                        Encoding.UTF8.GetBytes(
                            output["citation"]
                                + "\n\n"
                                + string.Join(
                                    "\n\n",
                                    output["bibliography"].AsArray().Select(x => x.ToString())
                                )
                        ),
                        "text/plain; charset=utf-8",
                        "bibliography.txt"
                    ),
                    "preview" => Results.Json(output),
                    _ => throw new ArgumentException("Unsupported citation format."),
                };
            }
        );
    }
}

public sealed record ProjectName(string Name);

public sealed record ConversionInput(string Hash, string Mode);

public sealed record ConversionControl(string Action);

public sealed record CitationOptions(string Style, string Format, bool SelectedOnly);

public sealed record ScopeBundle(bool SelectedOnly);
