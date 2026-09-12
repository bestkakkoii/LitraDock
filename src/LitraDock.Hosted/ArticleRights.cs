using LitraDock.Core;
using System.Xml.Linq;

namespace Literature.Service;

public sealed record RightsDecision(string Status, string LicenseUri, string Reason)
{
    public bool Permitted => Status == "permitted";
}

public static class ArticleRights
{
    public static RightsDecision Assess(byte[] bytes)
    {
        var doc = Metadata.ParseXml(bytes);
        var article = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "article");
        var front = article?.Elements().FirstOrDefault(e => e.Name.LocalName == "front");
        var licenses = front?.Descendants().Where(e => e.Name.LocalName == "license").ToArray() ?? [];
        if (licenses.Length == 0)
            return new("unknown", "", "No article license element; access is not reuse permission.");
        var accepted = new List<string>();
        foreach (var license in licenses)
        {
            var links = license.DescendantsAndSelf().Attributes().Where(a => a.Name.LocalName == "href").Select(a => a.Value).Distinct().ToArray();
            if (license.Value.Contains("all rights reserved", StringComparison.OrdinalIgnoreCase))
                return new("restricted", "", "Conflicting restrictive article license requires review.");
            var recognised = links.Where(x => Uri.TryCreate(x, UriKind.Absolute, out var uri)
                && uri.Scheme is "http" or "https" && uri.Host == "creativecommons.org"
                && uri.UserInfo == "" && uri.Query == "" && uri.Fragment == "" && uri.IsDefaultPort
                && uri.AbsolutePath is "/licenses/by/4.0/" or "/publicdomain/zero/1.0/").ToArray();
            if (recognised.Length != 1 || links.Length != 1)
                return new(links.Any(x => x.Contains("/by-nc") || x.Contains("/by-nd")) ? "restricted" : "unknown", "", "License is not a single reviewed CC BY 4.0 or CC0 URI; manual rights review required.");
            accepted.Add(new UriBuilder(recognised[0]) { Scheme = "https", Port = -1 }.Uri.AbsoluteUri);
        }
        if (accepted.Distinct().Count() != 1)
            return new("unknown", "", "Multiple article license grants require review.");
        return new("permitted", accepted[0], "Article-level XML license recognised; preserve attribution and terms. Separately licensed media are excluded from acquisition.");
    }
}
