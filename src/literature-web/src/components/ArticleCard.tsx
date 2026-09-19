import { Article } from "../api";
import { SourceOutcomeView } from "./SourceOutcome";

const LINK_HOSTS = new Set(["pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov", "doi.org"]);
function safeLink(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && LINK_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port && !url.search && !url.hash ? url.href : null;
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
export function ArticleCard({ article, selected, onSelect, disabled = false, onOpenBatch }: { article: Article; selected: boolean; onSelect: () => void; disabled?: boolean; onOpenBatch?: (id: string) => void }) {
  return <article className="result-card">
    <div className="article-heading"><input type="checkbox" checked={selected} disabled={disabled} onChange={onSelect} aria-label={`Select ${String(article.Title ?? "result")}`} /><h3>{String(article.Title ?? "Untitled record")}</h3></div>
    <p className="muted">{String(article.Authors ?? "Author metadata unavailable")} · {String(article.Year ?? "Year unavailable")} · {String(article.Journal ?? "Journal unavailable")}</p>
    <dl className="identifiers"><div><dt>DOI</dt><dd>{String(article.Doi ?? "—")}</dd></div><div><dt>PMID</dt><dd>{String(article.Pmid ?? "—")}</dd></div><div><dt>PMCID</dt><dd>{String(article.Pmcid ?? "—")}</dd></div></dl>
    <SourceLinks article={article} />
    <details className="record-identity"><summary>Record details</summary><p>Search ID: {String(article.SearchId ?? "Unavailable")}</p></details>
    {typeof article.Abstract === "string" && article.Abstract && <details className="article-abstract"><summary>Abstract</summary><p>{article.Abstract}</p></details>}
    <SourceOutcomeView outcome={article.SourceOutcome} onOpenBatch={onOpenBatch} />
  </article>;
}
