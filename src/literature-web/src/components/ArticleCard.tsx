import { Article } from "../api";

const LINK_HOSTS = new Set(["pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov", "doi.org"]);
function safeLink(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && LINK_HOSTS.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

export function SourceLinks({ article }: { article: Article }) {
  const links = [["PubMed", article.OriginalUri], ["PMC", article.PmcUri], ["DOI", article.DoiUri]] as const;
  const doiBlocked = article.DoiLinkState === "unsupported_path_segments";
  return <><nav className="links" aria-label="Source links">{links.map(([name, value]) => { const href = name === "DOI" && doiBlocked ? null : safeLink(value); return href ? <a key={name} href={href} target="_blank" rel="noopener noreferrer">Open {name}</a> : null; })}</nav>
    {doiBlocked && <p className="muted small">DOI link unavailable for this identifier; the original DOI is preserved unchanged.</p>}</>;
}
export function ArticleCard({ article, selected, onSelect }: { article: Article; selected: boolean; onSelect: () => void }) {
  return <article className="result-card">
    <label className="select"><input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Select ${String(article.Title ?? "result")}`} /><span>Select result</span></label>
    <h3>{String(article.Title ?? "Untitled record")}</h3>
    <p className="muted">{String(article.Authors ?? "Author metadata unavailable")} · {String(article.Year ?? "Year unavailable")} · {String(article.Journal ?? "Journal unavailable")}</p>
    <dl className="identifiers"><div><dt>PMID</dt><dd>{String(article.Pmid ?? "—")}</dd></div><div><dt>PMCID</dt><dd>{String(article.Pmcid ?? "—")}</dd></div><div><dt>DOI</dt><dd>{String(article.Doi ?? "—")}</dd></div></dl>
    <SourceLinks article={article} />
  </article>;
}
