import { useLayoutEffect, useRef, useState } from "react";
import { api, Article, Run, sessionGeneration } from "./api";
import { searchId, toggleArticle } from "./selection";

export async function enumerateSaved(library: string, run: Run, generation: number, signal: AbortSignal) {
  const records = new Map<string, Article>();
  const current = () => {
    if (signal.aborted || generation !== sessionGeneration()) throw new Error("Selection scope changed.");
  };
  let offset = 0;
  for (let reads = 0; reads < 100; reads++) {
    current();
    const page = await api.run(library, run.run_id, offset, generation, 100, signal);
    current();
    if (page.run.run_id !== run.run_id || page.offset !== offset ||
      !Number.isInteger(page.total) || page.total < 0 || page.total > 100 || page.total !== run.fetched ||
      !["complete", "partial", "error", "cancelled"].includes(page.run.state))
      throw new Error("Saved record set is not complete or exceeds the 100-record selection limit. Reopen the search to check its status.");
    for (const article of page.records) {
      const id = searchId(article);
      if (!id || records.has(id)) throw new Error("Saved record identifiers are missing or duplicated. No selection was applied.");
      records.set(id, article);
    }
    if (records.size > page.total) throw new Error("Saved record count changed. Reopen the search.");
    if (records.size === page.total) return records;
    if (!page.records.length) throw new Error("The saved record list is incomplete. Retry loading the selection.");
    offset += page.records.length;
  }
  throw new Error("Selection read limit reached. No incomplete selection was applied.");
}

export function useSavedSelection(library: string, run: Run | null, generation: number, scopeSignal: AbortSignal, visible: Article[] = []) {
  const [selected, setSelected] = useState(new Map<string, Article>());
  const [all, setAll] = useState(new Map<string, Article>());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const initialized = useRef(false);
  const pageOnly = (run?.fetched ?? 0) > 100;
  const terminal = !!run && ["complete", "partial", "error", "cancelled"].includes(run.state);
  useLayoutEffect(() => {
    initialized.current = false;
    setSelected(new Map()); setAll(new Map()); setError("");
  }, [library, run?.run_id, generation, scopeSignal]);
  useLayoutEffect(() => {
    const abort = new AbortController();
    const stop = () => { abort.abort(); setSelected(new Map()); setAll(new Map()); setLoading(false); setError(""); };
    scopeSignal.addEventListener("abort", stop);
    setError("");
    const current = () => !abort.signal.aborted && generation === sessionGeneration();
    setLoading(!!run);
    if (pageOnly) { setAll(new Map()); setLoading(false); initialized.current = true; }
    else if (!scopeSignal.aborted && library && run && terminal) {
      void enumerateSaved(library, run, generation, abort.signal).then(records => {
        if (current()) {
          setAll(records);
          if (!initialized.current) { setSelected(new Map(records)); initialized.current = true; }
        }
      }).catch(error => { if (current()) setError((error as Error).message); })
        .finally(() => { if (current()) setLoading(false); });
    }
    if (scopeSignal.aborted) stop();
    return () => { abort.abort(); scopeSignal.removeEventListener("abort", stop); };
    // Page offsets and polling object identity must never reapply default selection.
  }, [library, run?.run_id, run?.fetched, terminal, generation, scopeSignal, attempt, pageOnly]);
  const ready = !!run && terminal && !loading && !error && !scopeSignal.aborted;
  return { selected, loading, error, ready, total: all.size, pageOnly,
    retry: () => setAttempt(value => value + 1),
    selectAll: () => {
      if (!ready) return;
      initialized.current = true;
      setSelected(pageOnly ? new Map(visible.slice(0, 100).map(article => [searchId(article), article]).filter(([id]) => !!id) as [string, Article][]) : new Map(all));
    },
    deselectAll: () => { initialized.current = true; setSelected(new Map()); },
    toggle: (article: Article) => { if (ready && (all.has(searchId(article)) || visible.some(item => searchId(item) === searchId(article)))) {
      initialized.current = true; setSelected(value => toggleArticle(value, article, 100));
    } },
  };
}
