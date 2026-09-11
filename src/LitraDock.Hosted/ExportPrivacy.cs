using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Literature.Service;

// 分享用 metadata 投影移除暫時網址；私有資料庫及原始檔案不會被此函式更改。
public static class ExportPrivacy
{
    private static readonly Regex Url = new("https?://[^\\s<>\"'\\\\]+", RegexOptions.IgnoreCase);

    public static string Text(string value, int depth = 0)
    {
        if (string.IsNullOrEmpty(value))
            return value ?? "";
        if (depth < 8 && value.TrimStart().StartsWithAnyJsonContainer())
        {
            try
            {
                var node = JsonNode.Parse(value);
                var changed = false;
                void Visit(JsonNode current)
                {
                    if (current is JsonObject obj)
                        foreach (var key in obj.Select(p => p.Key).ToArray())
                            Replace(obj[key], v => obj[key] = v);
                    else if (current is JsonArray array)
                        for (var i = 0; i < array.Count; i++)
                        {
                            var index = i;
                            Replace(array[i], v => array[index] = v);
                        }
                }
                void Replace(JsonNode current, Action<JsonNode> set)
                {
                    if (current is JsonValue scalar && scalar.TryGetValue<string>(out var text))
                    {
                        var safe = Text(text, depth + 1);
                        if (safe != text)
                        {
                            set(JsonValue.Create(safe));
                            changed = true;
                        }
                    }
                    else if (current != null)
                        Visit(current);
                }
                Visit(node);
                return changed ? node.ToJsonString() : value;
            }
            catch (JsonException) { }
        }
        return Url.Replace(
            value,
            match =>
            {
                if (!Uri.TryCreate(match.Value, UriKind.Absolute, out var uri))
                    return match.Value;
                if (uri.Query == "" && uri.Fragment == "" && uri.UserInfo == "")
                    return match.Value;
                var known = SourceAcquisition.PublicLocation(match.Value);
                if (known != "" && known.Contains("?verb=GetRecord", StringComparison.Ordinal))
                    return known;
                return new UriBuilder(uri)
                {
                    UserName = "",
                    Password = "",
                    Query = "",
                    Fragment = "",
                }
                    .Uri
                    .AbsoluteUri;
            }
        );
    }

    private static bool StartsWithAnyJsonContainer(this string value) =>
        value.StartsWith('{') || value.StartsWith('[');
}
