import { Run } from "../api";

type Props = {
  runs: Run[];
  total: number;
  offset: number;
  selectedID: string;
  busy: boolean;
  onOpen: (id: string) => void;
  onPage: (offset: number) => void;
};

export function SearchHistory({ runs, total, offset, selectedID, busy, onOpen, onPage }: Props) {
  return <section className="panel search-history" aria-labelledby="search-history-heading">
    <h2 id="search-history-heading">Saved searches</h2>
    <p className="muted small">{total} saved searches · {runs.length ? offset + 1 : 0}–{offset + runs.length}. Open a saved run without repeating the search.</p>
    <p className="muted small">The full submitted query includes any explicit date, field or MeSH restrictions. Search time and separate filter details are not supplied for these saved runs.</p>
    <ul className="history-list" aria-label="Saved searches">
      {runs.map(run => <li key={run.run_id}>
        <button className="history-entry" aria-pressed={selectedID === run.run_id}
          disabled={busy} onClick={() => onOpen(run.run_id)}>
          <span className="history-query">{run.input}</span>
          <span className="history-facts">
            <span>{run.state}</span>
            <span>{run.total} provider matches</span>
            <span>{run.fetched} retrieved records</span>
          </span>
          <span className="history-id">Search Run ID: {run.run_id}</span>
          {run.reason && <span className="history-reason">{run.reason}</span>}
          <span className="history-open">{selectedID === run.run_id ? "Current saved run" : "Open saved run"}</span>
        </button>
      </li>)}
    </ul>
    {!runs.length && <p>No saved searches on this page.</p>}
    <nav className="pager" aria-label="Search history pages">
      <button className="secondary" disabled={busy || offset === 0} onClick={() => onPage(Math.max(0, offset - 100))}>Previous searches</button>
      <button className="secondary" disabled={busy || !runs.length || offset + runs.length >= total} onClick={() => onPage(offset + 100)}>Next searches</button>
    </nav>
  </section>;
}
