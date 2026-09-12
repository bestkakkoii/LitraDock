import React, { FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  Article,
  Library,
  Run,
  BatchDetail,
  SavedBatch,
  ServiceInfo,
  clearSession,
  onSessionInvalidated,
  sessionGeneration,
} from "./api";
import { ArticleCard } from "./components/ArticleCard";
import { canAdvanceRecords } from "./pagination";
import "./styles.css";

function safeRightsLink(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
function stateLabel(run: Run | null) {
  if (!run) return "No search selected";
  if (run.state === "partial")
    return `Partial results · retrieved ${run.fetched} of ${run.total}`;
  if (run.state === "complete")
    return `Complete · retrieved ${run.fetched} of ${run.total}`;
  if (run.state === "error")
    return `Search error${run.reason ? ` · ${run.reason}` : ""}`;
  return `${run.state} · retrieved ${run.fetched} of ${run.total}${run.reason ? ` · ${run.reason}` : ""}`;
}
function App() {
  const [signedIn, setSignedIn] = useState(false),
    [login, setLogin] = useState(""),
    [password, setPassword] = useState(""),
    [libraries, setLibraries] = useState<Library[]>([]),
    [library, setLibrary] = useState(""),
    [newLibrary, setNewLibrary] = useState(""),
    [query, setQuery] = useState(""),
    [snapshot, setSnapshot] = useState(""),
    [limit, setLimit] = useState(10),
    [run, setRun] = useState<Run | null>(null),
    [pageTotal, setPageTotal] = useState(0),
    [records, setRecords] = useState<Article[]>([]),
    [selected, setSelected] = useState<Set<number>>(new Set()),
    [history, setHistory] = useState<Run[]>([]),
    [historyTotal, setHistoryTotal] = useState(0),
    [historyOffset, setHistoryOffset] = useState(0),
    [recordOffset, setRecordOffset] = useState(0),
    [batch, setBatch] = useState<BatchDetail | null>(null),
    [savedBatches, setSavedBatches] = useState<SavedBatch[]>([]),
    [batchOffset, setBatchOffset] = useState(0),
    [batchTotal, setBatchTotal] = useState(0),
    [batchBusy, setBatchBusy] = useState(false),
    [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null),
    [acquisitionEnabled, setAcquisitionEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const runGeneration = useRef(0);
  const historyRequest = useRef(0);
  const batchHistoryRequest = useRef(0);
  const batchOperation = useRef(0);
  const isCurrentBatchOperation = (
    operation: number,
    expectedLibrary: string,
    expectedSession: number,
  ) =>
    operation === batchOperation.current &&
    expectedLibrary === library &&
    expectedSession === sessionGeneration();
  const refresh = async () => {
    const expected = sessionGeneration();
    const data = await api.libraries();
    if (expected !== sessionGeneration()) return;
    setLibraries(data.items);
    if (!library && data.items[0]) setLibrary(data.items[0].library_id);
  };
  const refreshHistory = async (id = library, offset = historyOffset) => {
    if (!id) return;
    const requestId = ++historyRequest.current;
    const expected = sessionGeneration();
    const data = await api.catalog(id, offset);
    if (
      expected !== sessionGeneration() ||
      requestId !== historyRequest.current ||
      id !== library
    )
      return;
    setHistory(data.runs);
    setHistoryTotal(data.totals.runs);
    setHistoryOffset(offset);
  };
  useEffect(() => {
    return onSessionInvalidated(() => {
      runGeneration.current += 1;
      batchOperation.current += 1;
      setSignedIn(false);
      setLibraries([]);
      setLibrary("");
      setQuery("");
      setSnapshot("");
      setRecords([]);
      setSelected(new Set());
      setHistory([]);
      setRun(null);
      setBatch(null);
      setSavedBatches([]); setBatchOffset(0); setBatchTotal(0);
      setPageTotal(0);
      setBatchBusy(false);
      setServiceInfo(null);
      setAcquisitionEnabled(false);
      setBusy(false);
    });
  }, []);
  useEffect(() => {
    api
      .session()
      .then(() => setSignedIn(true))
      .catch(() => {
        /* Anonymous sessions are expected on first load. */
      });
  }, []);
  useEffect(() => {
    if (signedIn) refresh().catch((e) => setError(e.message));
  }, [signedIn]);
  useEffect(() => {
    if (!signedIn) return;
    const expected = sessionGeneration();
    api.serviceInfo().then((info) => {
      if (expected !== sessionGeneration()) return;
      setServiceInfo(info); setAcquisitionEnabled(info.acquisitionEnabled === true);
    }).catch(() => { if (expected === sessionGeneration()) { setServiceInfo(null); setAcquisitionEnabled(false); } });
  }, [signedIn]);
  useEffect(() => {
    if (signedIn && library)
      refreshHistory(library).catch((e) => setError(e.message));
  }, [library, signedIn]);
  const refreshBatches = async (offset = 0) => {
    const expected = sessionGeneration(), id = library;
    const request = ++batchHistoryRequest.current;
    const current = () => expected === sessionGeneration() && request === batchHistoryRequest.current;
    try {
      const data = await api.catalog(id, offset);
      if (!current()) return;
      setSavedBatches(data.batches ?? []);
      setBatchOffset(offset); setBatchTotal(data.totals.batches ?? 0);
    } catch (e) { if (current()) setError((e as Error).message); }
  };
  useEffect(() => {
    if (!signedIn || !library) return;
    void refreshBatches();
    return () => { batchHistoryRequest.current += 1; };
  }, [library, signedIn]);
  // One read at a time; never publish a response after a control, library or session change.
  useEffect(() => {
    if (!signedIn || !library || !batch || batchBusy) return;
    const id = batch.batch.batch_id, expected = sessionGeneration();
    const operation = batchOperation.current;
    let disposed = false, reads = 0;
    let timer: ReturnType<typeof setTimeout>;
    const current = () => !disposed && expected === sessionGeneration() && operation === batchOperation.current;
    const poll = async () => {
      try {
        const detail = await api.batch(library, id, expected);
        if (!current()) return;
        setBatch(detail);
        if (['active', 'queued', 'running'].includes(detail.batch.state)) {
          if (++reads < 120) timer = setTimeout(poll, 2000);
          else setMessage('Automatic batch refresh paused after four minutes. Reopen the saved batch to check progress.');
        }
      } catch (e) { if (current()) setError((e as Error).message); }
    };
    timer = setTimeout(poll, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [signedIn, library, batch?.batch.batch_id, batchBusy]);
  const openBatch = async (id: string) => {
    if (!id || !library) return;
    const expected = sessionGeneration(), expectedLibrary = library;
    const operation = ++batchOperation.current;
    setBatchBusy(true); setError('');
    try {
      const detail = await api.batch(expectedLibrary, id, expected);
      if (isCurrentBatchOperation(operation, expectedLibrary, expected)) setBatch(detail);
    } catch (e) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected)) setError((e as Error).message);
    } finally {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected)) setBatchBusy(false);
    }
  };
  const submitLogin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    clearSession();
    try {
      await api.login(login, password);
      setSignedIn(true);
      setPassword("");
      setMessage("Signed in.");
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    const operation = ++runGeneration.current;
    setBusy(true);
    try {
      await api.logout();
    } catch (x) {
      setError((x as Error).message);
    } finally {
      if (operation !== runGeneration.current) return;
      setSignedIn(false);
      setLibraries([]);
      setLibrary("");
      setQuery("");
      setSnapshot("");
      setRecords([]);
      setHistory([]);
      setSelected(new Set());
      setRun(null);
      setBatch(null);
      setSavedBatches([]); setBatchOffset(0); setBatchTotal(0);
      setPageTotal(0);
      setMessage("");
      setError("");
      setBusy(false);
    }
  };
  const submitLibrary = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createLibrary(newLibrary);
      setNewLibrary("");
      await refresh();
      setMessage("Library created.");
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submitSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!library) {
      setError("Choose or create a library first.");
      return;
    }
    const g = ++runGeneration.current;
    const expectedSession = sessionGeneration();
    const searchLibrary = library;
    setBusy(true);
    setError("");
    setRecords([]);
    setPageTotal(0);
    setSelected(new Set());
    setRecordOffset(0);
    setSnapshot(query);
    try {
      const queued = await api.search(searchLibrary, query, limit);
      if (
        g !== runGeneration.current ||
        expectedSession !== sessionGeneration()
      )
        return;
      setMessage("Search queued; waiting for source metadata.");
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (g !== runGeneration.current) return;
        const page = await api.run(
          searchLibrary,
          queued.id,
          0,
          expectedSession,
        );
        if (
          g !== runGeneration.current ||
          expectedSession !== sessionGeneration()
        )
          return;
        setRun(page.run);
        if (page.run.state === "queued" || page.run.state === "running")
          continue;
        if (page.run.state !== "complete" && page.run.state !== "partial") {
          setError(page.run.reason || "Search unavailable; no completion assumed.");
          setMessage(stateLabel(page.run));
          setPageTotal(0);
          await refreshHistory();
          return;
        }
        setRecords(page.records);
        setPageTotal(page.total);
        setMessage(stateLabel(page.run));
        await refreshHistory();
        return;
      }
      setMessage("Search remains in progress; open it from saved history.");
    } catch (x) {
      if (g === runGeneration.current) setError((x as Error).message);
    } finally {
      if (
        g === runGeneration.current &&
        expectedSession === sessionGeneration()
      )
        setBusy(false);
    }
  };
  const openSaved = async (id: string, offset = 0) => {
    if (!id || !library) return;
    const g = ++runGeneration.current;
    const expectedSession = sessionGeneration();
    const savedLibrary = library;
    setBusy(true);
    setError("");
    try {
      const page = await api.run(savedLibrary, id, offset, expectedSession);
      if (
        g !== runGeneration.current ||
        expectedSession !== sessionGeneration() ||
        savedLibrary !== library
      )
        return;
      setRun(page.run);
      setSnapshot(page.run.input);
      setRecords(page.records);
      setPageTotal(page.total);
      setRecordOffset(offset);
      setSelected(new Set());
      setMessage(
        `${stateLabel(page.run)} · showing ${page.total ? offset + 1 : 0}–${offset + page.records.length} of ${page.total}`,
      );
    } catch (x) {
      if (g === runGeneration.current) setError((x as Error).message);
    } finally {
      if (
        g === runGeneration.current &&
        expectedSession === sessionGeneration()
      )
        setBusy(false);
    }
  };
  const createBatch = async () => {
    if (!library || selected.size < 1 || selected.size > 10) return;
    const ids = records
      .filter((_, index) => selected.has(index))
      .map((record) => String(record.SearchId ?? ""))
      .filter(Boolean);
    if (ids.length !== selected.size) {
      setError("Selected records do not contain stable search IDs.");
      return;
    }
    const expected = sessionGeneration();
    const expectedLibrary = library;
    const operation = ++batchOperation.current;
    setBatchBusy(true);
    setError("");
    try {
      const created = await api.createBatch(
        expectedLibrary,
        crypto.randomUUID(),
        ids,
      );
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected))
        return;
      const detail = await api.batch(expectedLibrary, created.id, expected);
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected))
        return;
      setBatch(detail);
      setBatchTotal(total => total + 1);
      setSavedBatches(items => [{ batch_id: detail.batch.batch_id, state: detail.batch.state }, ...items.filter(x => x.batch_id !== detail.batch.batch_id)]);
      setMessage(`Batch created with ${detail.total} selected records.`);
    } catch (x) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setError((x as Error).message);
    } finally {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setBatchBusy(false);
    }
  };
  const controlBatch = async (
    value: "pause" | "resume" | "cancel" | "retry",
  ) => {
    if (!library || !batch) return;
    const expected = sessionGeneration();
    const expectedLibrary = library;
    const operation = ++batchOperation.current;
    const batchId = batch.batch.batch_id;
    setBatchBusy(true);
    try {
      await api.controlBatch(expectedLibrary, batchId, value);
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected))
        return;
      const detail = await api.batch(expectedLibrary, batchId, expected);
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setBatch(detail);
    } catch (x) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setError((x as Error).message);
    } finally {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setBatchBusy(false);
    }
  };
  const saveOriginal = async (item: BatchDetail["items"][number]) => {
    if (!library || !item.downloadAvailable || !item.original_hash) return;
    const expected = sessionGeneration();
    const expectedLibrary = library;
    const operation = ++batchOperation.current;
    setBatchBusy(true);
    try {
      const blob = await api.original(
        expectedLibrary,
        item.search_id,
        item.original_hash,
        expected,
      );
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected))
        return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${item.search_id}.xml`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (x) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setError((x as Error).message);
    } finally {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setBatchBusy(false);
    }
  };
  const exportCsv = async (selection: { runID?: string; batchID?: string }) => {
    if (!library) return;
    const expected = sessionGeneration();
    const expectedLibrary = library;
    const operation = ++batchOperation.current;
    setBatchBusy(true);
    try {
      const blob = await api.exportCsv(expectedLibrary, selection, expected);
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected))
        return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "literature-export.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (x) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setError((x as Error).message);
    } finally {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setBatchBusy(false);
    }
  };
  const exportBundle = async () => {
    if (!library || !batch) return;
    const expected = sessionGeneration();
    const expectedLibrary = library;
    const operation = ++batchOperation.current;
    const batchId = batch.batch.batch_id;
    setBatchBusy(true);
    try {
      const blob = await api.exportBundle(expectedLibrary, batchId, expected);
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected))
        return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `batch-${batchId}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (x) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setError((x as Error).message);
    } finally {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setBatchBusy(false);
    }
  };
  if (!signedIn)
    return (
      <main className="shell">
        <header>
          <p className="eyebrow">PRIVATE RESEARCH WORKSPACE</p>
          <h1>Search literature with confidence.</h1>
          <p className="lede">
            Keep query history and bibliographic metadata together while
            preserving the source identifiers that make records traceable.
          </p>
        </header>
        <section className="panel narrow">
          <h2>Sign in</h2>
          <form onSubmit={submitLogin}>
            <label>
              Login
              <input
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <p className="muted small">
            Your account session uses an HttpOnly cookie. Sign out when leaving
            a shared device.
          </p>
        </section>
      </main>
    );
  const pageCount = Math.ceil(historyTotal / 100);
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">LITRADock · LITERATURE WORKSPACE</p>
          <h1>Research library</h1>
        </div>
        <button className="secondary" onClick={signOut} disabled={busy}>
          Sign out
        </button>
      </header>
      <section className="grid">
        <aside>
          <section className="panel">
            <h2>Library</h2>
            <select
              value={library}
              onChange={(e) => {
                if (e.target.value === library) return;
                runGeneration.current += 1;
                historyRequest.current += 1;
                batchOperation.current += 1;
                setLibrary(e.target.value);
                setRecords([]);
                setRun(null);
                setPageTotal(0);
                setSelected(new Set());
                setSnapshot("");
                setBatch(null);
                setSavedBatches([]); setBatchOffset(0); setBatchTotal(0);
                batchHistoryRequest.current += 1;
                setBusy(false);
                setBatchBusy(false);
              }}
              aria-label="Choose library"
            >
              <option value="">Choose a library</option>
              {libraries.map((x) => (
                <option key={x.library_id} value={x.library_id}>
                  {x.name}
                </option>
              ))}
            </select>
            <form onSubmit={submitLibrary} className="inline">
              <label>
                New library name
                <input
                  value={newLibrary}
                  onChange={(e) => setNewLibrary(e.target.value)}
                  placeholder="New library name"
                  maxLength={120}
                  required
                />
              </label>
              <button disabled={busy}>Create</button>
            </form>
          </section>
          <section className="panel">
            <h2>Saved searches</h2>
            <p className="muted small">
              {historyTotal} saved {historyTotal === 1 ? "search" : "searches"}{" "}
              · page {pageCount ? historyOffset / 100 + 1 : 0} of {pageCount}
            </p>
            <select
              size={Math.min(7, Math.max(3, history.length))}
              value={run?.run_id ?? ""}
              onChange={(e) => openSaved(e.target.value)}
              aria-label="Saved searches"
            >
              {history.map((x) => (
                <option key={x.run_id} value={x.run_id}>
                  {x.input} · {x.state}
                </option>
              ))}
            </select>
            <div className="pager">
              <button
                className="secondary"
                disabled={historyOffset === 0 || busy}
                onClick={() =>
                  refreshHistory(library, Math.max(0, historyOffset - 100))
                }
              >
                Previous
              </button>
              <button
                className="secondary"
                disabled={historyOffset + 100 >= historyTotal || busy}
                onClick={() => refreshHistory(library, historyOffset + 100)}
              >
                Next
              </button>
            </div>
          </section>
          <section className="panel">
            <h2>Saved batches</h2>
            <p className="muted small">{batchTotal} saved batches · {savedBatches.length ? batchOffset + 1 : 0}–{batchOffset + savedBatches.length}</p>
            <select aria-label="Saved batches" value={batch?.batch.batch_id ?? ''}
              onChange={e => openBatch(e.target.value)}>
              <option value="">Choose a saved batch</option>
              {savedBatches.map(x => <option key={x.batch_id} value={x.batch_id}>{x.batch_id} · {x.state}</option>)}
            </select>
            <div className="pager">
              <button className="secondary" disabled={!library || batchOffset === 0} onClick={() => refreshBatches(Math.max(0, batchOffset - 100))}>Previous batches</button>
              <button className="secondary" disabled={!library || batchOffset + 100 >= batchTotal} onClick={() => refreshBatches(batchOffset + 100)}>Next batches</button>
            </div>
            <button className="secondary" disabled={!library} onClick={() => refreshBatches(batchOffset)}>Refresh saved batches</button>
          </section>
        </aside>
        <section>
          <section className="panel search-panel">
            <div>
              <h2>PubMed search</h2>
              <p className="muted">
                Use explicit PubMed syntax, for example{" "}
                <code>"heart failure"[Title] AND 2020:2024[dp]</code>.
              </p>
            </div>
            <form onSubmit={submitSearch}>
              <label className="query">
                Query
                <textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  maxLength={2000}
                  rows={3}
                  required
                  placeholder="Enter a PubMed query"
                />
              </label>
              <label>
                Retrieved limit
                <select
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                >
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <button disabled={busy || !library || serviceInfo?.searchEnabled !== true}>
                {busy ? "Working…" : "Search PubMed"}
              </button>
            </form>
          </section>
          {(message || error) && (
            <p className={error ? "error status" : "status"} role="status">
              {error || message}
            </p>
          )}
          {run && (
            <section className="summary">
              <div>
                <span className="muted">Query snapshot</span>
                <strong>{snapshot}</strong>
              </div>
              <div>
                <span className="muted">Provider total</span>
                <strong>{run.total}</strong>
              </div>
              <div>
                <span className="muted">Retrieved</span>
                <strong>{run.fetched}</strong>
              </div>
              <div>
                <span className="muted">State</span>
                <strong>{run.state}</strong>
              </div>
            </section>
          )}
          {serviceInfo?.searchEnabled === false && <p className="muted">New searches are temporarily disabled by the operator. Saved results remain available.</p>}
          <div className="result-head">
            <h2>
              Results <span className="count">{records.length}</span>
            </h2>
            <div className="result-actions">
              <button
                className="secondary"
                disabled={!run || batchBusy}
                onClick={() => run && exportCsv({ runID: run.run_id })}
              >
                Export CSV
              </button>
              <button
                className="secondary"
                disabled={
                  selected.size < 1 ||
                  selected.size > 10 ||
                  batchBusy ||
                  !acquisitionEnabled
                }
                onClick={createBatch}
                title={
                  !acquisitionEnabled
                    ? "Batch acquisition is disabled by the current server policy."
                    : "Create a batch for 1 to 10 selected records."
                }
              >
                Create batch ({selected.size}/10)
              </button>
            </div>
          </div>
          {records.length ? (
            records.map((a, i) => (
              <ArticleCard
                key={`${String(a.Pmid)}-${i}`}
                article={a}
                selected={selected.has(i)}
                onSelect={() =>
                  setSelected((s) => {
                    const n = new Set(s);
                    n.has(i) ? n.delete(i) : n.add(i);
                    return n;
                  })
                }
              />
            ))
          ) : (
            <div className="empty">
              <h3>{run ? "No records on this page" : "Start with a search"}</h3>
              <p className="muted">
                Search results will appear here with separate PMID, PMCID and
                DOI fields.
              </p>
            </div>
          )}
          {run &&
            (recordOffset > 0 ||
              canAdvanceRecords(pageTotal, recordOffset, records.length)) && (
              <div className="pager">
                <button
                  className="secondary"
                  disabled={recordOffset === 0 || busy}
                  onClick={() =>
                    openSaved(run.run_id, Math.max(0, recordOffset - 100))
                  }
                >
                  Previous records
                </button>
                <button
                  className="secondary"
                  disabled={recordOffset + records.length >= pageTotal || busy}
                  onClick={() =>
                    openSaved(run.run_id, recordOffset + records.length)
                  }
                >
                  Next records
                </button>
              </div>
            )}
          {batch && (
            <section className="panel batch-panel">
              <div className="result-head">
                <div>
                  <h2>Batch {batch.batch.batch_id}</h2>
                  <p className="muted small">
                    {batch.batch.state} · {batch.total} selected records
                  </p>
                </div>
                <div className="result-actions">
                  <button
                    className="secondary"
                    disabled={batchBusy}
                    onClick={() => controlBatch("pause")}
                  >
                    Pause
                  </button>
                  <button
                    className="secondary"
                    disabled={batchBusy}
                    onClick={() => controlBatch("resume")}
                  >
                    Resume
                  </button>
                  <button
                    className="secondary"
                    disabled={batchBusy}
                    onClick={() => controlBatch("retry")}
                  >
                    Retry eligible
                  </button>
                  <button
                    className="secondary"
                    disabled={batchBusy}
                    onClick={() => controlBatch("cancel")}
                  >
                    Cancel
                  </button>
                  <button
                    className="secondary"
                    disabled={batchBusy}
                    onClick={() => exportCsv({ batchID: batch.batch.batch_id })}
                  >
                    Export batch CSV
                  </button>
                  <button
                    className="secondary"
                    disabled={batchBusy}
                    onClick={exportBundle}
                  >
                    Download original bundle
                  </button>
                </div>
              </div>
              {batch.items.map((item) => (
                <div className="batch-item" key={item.search_id}>
                  <strong>
                    {String(item.article.Title ?? item.search_id)}
                  </strong>
                  <span>
                    {item.state}
                    {item.reason ? ` · ${item.reason}` : ""}
                  </span>
                  {item.downloadAvailable && item.original_hash ? (
                    <>
                      <button
                        className="secondary small-button"
                        disabled={batchBusy}
                        onClick={() => saveOriginal(item)}
                      >
                        Save XML
                      </button>
                      <small className="muted">
                        {item.format ?? "XML"} ·{" "}
                        {item.version ?? "repository snapshot"} · hash{" "}
                        {item.original_hash} ·{" "}
                        {safeRightsLink(item.rights_uri) ? (
                          <a
                            href={safeRightsLink(item.rights_uri)!}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            rights
                          </a>
                        ) : (
                          "rights link unavailable"
                        )}
                      </small>
                    </>
                  ) : (
                    <small className="muted">
                      Server original unavailable; source link remains in the
                      record. No publisher PDF or login is implied.
                    </small>
                  )}
                </div>
              ))}
            </section>
          )}
          <section className="capability">
            <strong>Batch, download and export</strong>
            <span>
              Search retrieves up to100 results per run; batches select up to10 records. Only repository XML with a reviewed, consistent article grant is acquired; many full-text sources remain unavailable. Selected batches acquire permitted repository XML into your server library. Save XML downloads a file to this device; CSV and ZIP preserve metadata and unresolved source links. Publisher PDF access and account-based publisher login are not provided.
            </span>
          </section>
        </section>
      </section>
      <footer>
        <p>PubMed queries and article identifiers are sent to NCBI. Public metadata does not establish full-text reuse permission. NCBI does not endorse this service; source records can contain errors and should be checked against the original publication.</p>
        {serviceInfo && <><p>Operator: {serviceInfo.operatorName}. Support: {serviceInfo.contact}.</p><p>Retention: {serviceInfo.retention}</p><p>Invited candidate access ends: {serviceInfo.expiresAt}.</p></>}
        {serviceInfo?.source && /^https:\/\/github\.com\/bestkakkoii\/LitraDock\/tree\/[0-9a-f]{40}$/.test(serviceInfo.source) && <p><a href={serviceInfo.source} target="_blank" rel="noopener noreferrer">Source code for this deployment</a></p>}
        <p>Use public research queries only; do not enter patient information. Account sessions, saved metadata and acquired originals remain in the server library until operator cleanup. Sign out on shared devices.</p>
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
