using System.Text;
using System.Text.Json;
using Literature.Service;
using LitraDock.Core;

public static class ResearchMetadataChecks
{
    public static async Task Run(string output, Action<bool, string> check)
    {
        var xml = Encoding.UTF8.GetBytes(
            "<PubmedArticle><MedlineCitation><PMID>999</PMID><Article><ArticleTitle>Synthetic metadata</ArticleTitle><Journal><Title>Example Journal</Title><JournalIssue><Volume>14</Volume><Issue>2</Issue><PubDate><Year>2020</Year></PubDate></JournalIssue></Journal><AuthorList><Author><LastName>王</LastName><ForeName>小明</ForeName></Author><Author><CollectiveName>Research Council</CollectiveName></Author><Author><LastName>Smith</LastName><ForeName>Jane</ForeName><Suffix>Jr.</Suffix></Author></AuthorList></Article></MedlineCitation></PubmedArticle>"
        );
        var article = Metadata.ParsePubMed(xml).Single();
        article.SearchId = "LD-STRUCTURED";
        article.Title = "Unicode 中文 {brace} & 50% #tag _x $y \\ path";
        article.ArticleNumber = "e48";
        article.Doi = "10.1000/synthetic";
        article.Pmcid = "PMC999";
        article.PublicationTypes = "Randomized Controlled Trial";
        var csl = CitationMetadata.Map(article);
        check(
            csl["author"][0]["family"].ToString() == "王"
                && csl["author"][0]["given"].ToString() == "小明",
            "Structured multilingual name components retained without guessed splitting"
        );
        check(
            csl["author"][1]["literal"].ToString() == "Research Council"
                && csl["author"][2]["suffix"].ToString() == "Jr.",
            "Corporate and suffixed authors retain source order and structure"
        );
        check(
            csl["number"].ToString() == "e48"
                && csl["page"].ToString() == ""
                && csl["genre"].ToString() == article.PublicationTypes,
            "Article number, pagination and original publication type remain distinct"
        );
        check(
            csl["custom"]["sourceRawXml"].ToString() == article.RawXml
                && csl["PMID"].ToString() == "999"
                && csl["PMCID"].ToString() == "PMC999",
            "Full source XML and separate literature identifiers retained in CSL projection"
        );
        await File.WriteAllTextAsync(
            Path.Combine(output, "interchange.ris"),
            CitationMetadata.Ris([csl])
        );
        await File.WriteAllTextAsync(
            Path.Combine(output, "interchange.bib"),
            CitationMetadata.BibTex([csl])
        );
        await File.WriteAllTextAsync(
            Path.Combine(output, "interchange.csl.json"),
            csl.ToJsonString()
        );
        var absent = CitationMetadata.Map(
            new Article { SearchId = "LD-MISSING", Authors = "Unstructured author display" }
        );
        check(
            absent["author"][0]["literal"].ToString() == "Unstructured author display"
                && absent["custom"]["missingMetadata"].AsArray().Count >= 3,
            "Missing fields and unstructured authors are disclosed instead of invented"
        );
        foreach (
            var text in new[]
            {
                "<html><body><p>Saved scholarly 中文 content</p></body></html>",
                "Saved plain scholarly content 中文.",
            }
        )
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            bool needsReview = false;
            try
            {
                OriginalValidation.Validate(bytes, article);
            }
            catch (SourceException e)
            {
                needsReview = e.State == "needs_review";
            }
            var info = OriginalValidation.Validate(bytes, article, true);
            check(
                needsReview
                    && info.Hash == Artifacts.Hash(bytes)
                    && info.Validation.Contains("user-confirmed"),
                "Saved HTML/text requires honest explicit identity attestation and exact bytes"
            );
        }
        foreach (
            var text in new[]
            {
                "<html><form>Sign in</form></html>",
                "MZ executable pretending to be text",
                "Invalid binary \0 content",
            }
        )
        {
            bool rejected = false;
            try
            {
                OriginalValidation.Validate(Encoding.UTF8.GetBytes(text), article, true);
            }
            catch
            {
                rejected = true;
            }
            check(rejected, "Confirmed input still rejects challenge/executable/binary text");
        }
    }
}
