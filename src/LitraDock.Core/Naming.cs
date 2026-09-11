using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace LitraDock.Core
{
    public static class Naming
    {
        public const string DefaultTemplate = "{SearchId}_{Journal}_{FirstAuthor}_{Year}";

        public static void ValidateTemplate(string template)
        {
            if (string.IsNullOrWhiteSpace(template) || template.Length > 200) { throw new ArgumentException("Enter a naming template up to 200 characters."); }
            var remaining = template;
            foreach (var name in new[] { "SearchId", "Journal", "FirstAuthor", "Year" }) { remaining = remaining.Replace("{" + name + "}", ""); }
            if (remaining.Contains("{") || remaining.Contains("}")) { throw new ArgumentException("Supported fields: {SearchId}, {Journal}, {FirstAuthor}, {Year}."); }
        }

        private static string Component(string value, int maximum)
        {
            value = Regex.Replace(value ?? "", "[\\x00-\\x1f<>:\"/\\\\|?*]", "_").Trim().TrimEnd('.');
            if (value.Length == 0) { value = "Unknown"; }
            if (Regex.IsMatch(value, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", RegexOptions.IgnoreCase)) { value = "_" + value; }
            if (value.Length > maximum)
            { var count = char.IsHighSurrogate(value[maximum - 1]) ? maximum - 1 : maximum; value = value.Substring(0, count).TrimEnd('.'); }
            return value;
        }

        public static string Preview(Article article, string template = DefaultTemplate)
        {
            ValidateTemplate(template);
            var name = template.Replace("{SearchId}", Component(article.SearchId, 35)).Replace("{Journal}", Component(article.Journal, 24))
                .Replace("{FirstAuthor}", Component(article.Authors.Split(';').FirstOrDefault(), 24)).Replace("{Year}", Component(article.Year, 10));
            return Component(name, 110) + ".xml";
        }

        public static int SaveOriginals(Library library, Article article, string folder, string template = DefaultTemplate)
        {
            folder = Path.GetFullPath(folder);
            if (folder.StartsWith(library.Root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || folder == library.Root)
            { throw new ArgumentException("Choose an export folder outside the managed library."); }
            Directory.CreateDirectory(folder);
            var count = 0;
            foreach (var source in library.FilePaths(article.SearchId))
            {
                var bytes = Artifacts.ReadBoundedFile(source);
                var info = Artifacts.ValidateXml(bytes, article);
                if (!library.IsKnownHash(article.SearchId, info.Hash)) { throw new IOException("Original file hash differs from the stored version."); }
                var name = Path.GetFileNameWithoutExtension(Preview(article, template)) + "_" + info.Hash.Substring(0, 16) + ".xml";
                var target = Path.Combine(folder, name);
                if (target.Length >= 240) { throw new IOException("Choose a shorter export folder to keep the Windows path below 240 characters."); }
                if (File.Exists(target))
                {
                    if (Artifacts.Hash(Artifacts.ReadBoundedFile(target)) != info.Hash) { throw new IOException("Export name collision; existing file was preserved."); }
                    count++;
                    continue;
                }
                var staged = Path.Combine(folder, ".litradock-" + Guid.NewGuid().ToString("N") + ".tmp");
                using (var file = new FileStream(staged, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { file.Write(bytes, 0, bytes.Length); file.Flush(true); }
                File.Move(staged, target);
                library.RecordNamedExport(article.SearchId, info.Hash, name);
                count++;
            }
            return count;
        }
    }
}
