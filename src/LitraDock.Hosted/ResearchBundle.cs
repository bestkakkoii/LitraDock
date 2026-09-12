using System.Text.Json.Nodes;
using LitraDock.Core;

namespace Literature.Service;

public sealed partial class PgStore
{
    internal static readonly string[] ResearchTables =
    [
        "ld_projects",
        "ld_reviews",
        "ld_review_events",
        "ld_conversions",
        "ld_derivations",
        "ld_conversion_events",
        "ld_citations",
    ];

    private static void ProjectBundle(JsonObject tables, HashSet<string> ids)
    {
        void Keep(string table, Func<JsonNode, bool> keep)
        {
            var a = tables[table].AsArray();
            for (var i = a.Count - 1; i >= 0; i--)
                if (!keep(a[i]))
                    a.RemoveAt(i);
        }
        HashSet<string> Keys(string table, string key) =>
            tables[table]
                .AsArray()
                .Where(x => x[key] != null)
                .Select(x => x[key].ToString())
                .ToHashSet();
        foreach (
            var table in new[]
            {
                "ld_records",
                "ld_identifiers",
                "ld_results",
                "ld_members",
                "ld_items",
                "ld_article_files",
                "ld_object_provenance",
                "ld_reviews",
                "ld_review_events",
                "ld_conversions",
                "ld_derivations",
                "ld_citations",
            }
        )
            Keep(table, x => ids.Contains(x["search_id"]?.ToString() ?? ""));
        var runs = Keys("ld_results", "run_id");
        Keep("ld_runs", x => runs.Contains(x["run_id"].ToString()));
        var scopes = Keys("ld_members", "scope_id");
        // 只保留選取關聯；被省略的父範圍不製造不存在的參照。
        Keep("ld_scopes", x => scopes.Contains(x["scope_id"].ToString()));
        foreach (var x in tables["ld_scopes"].AsArray())
        {
            if (x["parent_id"] != null && !scopes.Contains(x["parent_id"].ToString()))
                x["parent_id"] = null;
            if (x["run_id"] != null && !runs.Contains(x["run_id"].ToString()))
                x["run_id"] = null;
        }
        var batches = Keys("ld_items", "batch_id");
        Keep("ld_batches", x => batches.Contains(x["batch_id"].ToString()));
        Keep(
            "ld_jobs",
            x =>
                ids.Contains(x["search_id"]?.ToString() ?? "")
                || (
                    x["kind"].ToString() == "search" && runs.Contains(x["run_id"]?.ToString() ?? "")
                )
        );
        var jobs = Keys("ld_jobs", "job_id");
        foreach (
            var table in new[] { "ld_events", "ld_publications", "ld_manual_inputs", "ld_retry" }
        )
            Keep(table, x => jobs.Contains(x["job_id"]?.ToString() ?? ""));
        var conversions = Keys("ld_conversions", "conversion_id");
        Keep("ld_conversion_events", x => conversions.Contains(x["conversion_id"].ToString()));
        var projects = Keys("ld_reviews", "project_id");
        Keep("ld_projects", x => projects.Contains(x["project_id"].ToString()));
        var files = Keys("ld_article_files", "hash");
        files.UnionWith(Keys("ld_derivations", "hash"));
        files.UnionWith(Keys("ld_conversions", "input_hash"));
        Keep("ld_files", x => files.Contains(x["hash"].ToString()));
        Keep(
            "ld_legacy_rows",
            x =>
            {
                var data = JsonNode.Parse(x["data"].ToString());
                return ids.Contains(data?["search_id"]?.ToString() ?? "")
                    || (
                        (x["table_name"].ToString() == "jobs")
                        && jobs.Contains(data?["job_id"]?.ToString() ?? "")
                    );
            }
        );
    }

    private static void ValidateResearchBundle(JsonObject tables)
    {
        var records = tables["ld_records"].AsArray().ToDictionary(x => x["search_id"].ToString());
        var conversions = tables["ld_conversions"]
            .AsArray()
            .ToDictionary(x => x["conversion_id"].ToString());
        bool Original(string id, string hash) =>
            tables["ld_article_files"]
                .AsArray()
                .Any(x => x["search_id"].ToString() == id && x["hash"].ToString() == hash);
        foreach (var conversion in conversions.Values)
        {
            var article = System.Text.Json.JsonSerializer.Deserialize<Article>(
                conversion["input_metadata"].ToString()
            );
            if (
                article.SearchId != conversion["search_id"].ToString()
                || !records.ContainsKey(article.SearchId)
            )
                throw new IOException("Conversion input identity differs from canonical record.");
            var hash = conversion["input_hash"]?.ToString();
            if (
                conversion["mode"].ToString() == "original"
                    ? hash == null || !Original(article.SearchId, hash)
                    : hash != null
            )
                throw new IOException("Conversion input is not an associated original revision.");
            if (
                conversion["state"].ToString() == "completed"
                && !tables["ld_derivations"]
                    .AsArray()
                    .Any(x =>
                        x["conversion_id"].ToString() == conversion["conversion_id"].ToString()
                    )
            )
                throw new IOException("Completed conversion lacks a derived association.");
        }
        foreach (var derived in tables["ld_derivations"].AsArray())
        {
            if (
                !conversions.TryGetValue(derived["conversion_id"].ToString(), out var c)
                || c["search_id"].ToString() != derived["search_id"].ToString()
                || c["input_hash"]?.ToString() != derived["input_hash"]?.ToString()
                || c["output_hash"]?.ToString() != derived["hash"].ToString()
                || c["state"].ToString() != "completed"
            )
                throw new IOException(
                    "Derived provenance graph differs from its completed conversion."
                );
            var info = JsonNode.Parse(derived["provenance"].ToString());
            var inputHash =
                c["input_hash"]?.ToString()
                ?? Artifacts.Hash(
                    System.Text.Encoding.UTF8.GetBytes(c["input_metadata"].ToString())
                );
            if (
                info?["hash"]?.ToString() != derived["hash"].ToString()
                || info?["inputHash"]?.ToString() != inputHash
                || info?["kind"]?.ToString() != derived["kind"].ToString()
            )
                throw new IOException("Derived manifest hashes or kind disagree.");
        }
        foreach (var review in tables["ld_reviews"].AsArray())
        {
            if (
                !tables["ld_review_events"]
                    .AsArray()
                    .Any(x =>
                        x["search_id"].ToString() == review["search_id"].ToString()
                        && x["project_id"].ToString() == review["project_id"].ToString()
                        && x["revision"].ToString() == review["revision"].ToString()
                    )
            )
                throw new IOException("Review current revision has no retained event.");
            var evidence = JsonNode.Parse(review["evidence"].ToString());
            var hash = evidence?["hash"]?.ToString();
            if (
                !string.IsNullOrEmpty(hash)
                && (
                    evidence?["pageKind"]?.ToString() == "derived"
                        ? !tables["ld_derivations"]
                            .AsArray()
                            .Any(x =>
                                x["search_id"].ToString() == review["search_id"].ToString()
                                && x["hash"].ToString() == hash
                            )
                        : !Original(review["search_id"].ToString(), hash)
                )
            )
                throw new IOException("Review evidence refers to an unrelated version.");
        }
        foreach (var citation in tables["ld_citations"].AsArray())
            if (
                JsonNode.Parse(citation["data"].ToString())?["item"]?["id"]?.ToString()
                != citation["search_id"].ToString()
            )
                throw new IOException("Citation identity differs from record.");
    }
}
