import { useId } from "react";
import { BasketMember } from "./basket";

type Props = { member: BasketMember; position: number; onRemove: (searchID: string) => void };
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : "";

/** Presentation only: immutable identity, article data and run order are untouched. */
export function BasketRow({ member, position, onRemove }: Props) {
  const titleID = useId();
  const title = text(member.article.Title) || "Title not supplied";
  const journal = text(member.article.Journal);
  const year = typeof member.article.Year === "number" && Number.isFinite(member.article.Year)
    ? String(member.article.Year) : text(member.article.Year);
  const authors = text(member.article.Authors);
  const bibliography = [journal, year, authors.length <= 80 ? authors : "Author list in details"].filter(Boolean).join(" · ");

  return <article className="basket-row" aria-labelledby={titleID}>
    <div className="basket-row-heading">
      <h4 id={titleID}>{title}</h4>
      <button className="secondary basket-remove" aria-label={`Remove record ${position}: ${title}`}
        onClick={() => onRemove(member.searchID)}>Remove</button>
    </div>
    <p className="basket-bibliography">{bibliography || "Bibliographic details not supplied."}</p>
    <details className="basket-provenance">
      <summary aria-label={`Record details for record ${position}: ${title}`}>Record details · {member.runIDs.length} saved {member.runIDs.length === 1 ? "search" : "searches"}</summary>
      {authors.length > 80 && <p>Authors: {authors}</p>}
      <dl><dt>Search ID</dt><dd>{member.searchID}</dd><dt>Saved search provenance</dt>
        <dd><ul>{member.runIDs.map(runID => <li key={runID}>{runID}</li>)}</ul></dd></dl>
    </details>
  </article>;
}
