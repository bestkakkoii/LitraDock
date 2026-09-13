import React, { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  Article,
  Library,
  Run,
  RunPage,
  BatchDetail,
  SavedBatch,
  ServiceInfo,
  clearSession,
  onSessionInvalidated,
  sessionGeneration,
} from "./api";
import { ArticleCard, SourceLinks } from "./components/ArticleCard";
import { canAdvanceRecords } from "./pagination";
import { searchId, selectedSearchIds } from "./selection";
import { useSavedSelection } from "./savedSelection";
import { originalKind } from "./originalKind";
import { structuredExport, type ExportScope, type StructuredFormat } from "./structuredExport";
import { PlanWorkspace } from "./plans/PlanWorkspace";
import { TransferOptions, transferLabel } from "./transfer";
import { SearchHistory } from "./components/SearchHistory";
import { PdfAvailability } from "./components/PdfAvailability";
import { Continuation } from "./continuation/api";
import { SearchController, emptySearchState } from "./continuation/controller";
import { ContinuationPanel } from "./continuation/ContinuationPanel";
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
    [pageSize, setPageSize] = useState(25),
    [run, setRun] = useState<Run | null>(null),
    [pageTotal, setPageTotal] = useState(0),
    [records, setRecords] = useState<Article[]>([]),
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
  const recordPageScope = useRef(new AbortController());
  const retireRecordPage = () => {
    recordPageScope.current.abort();
    recordPageScope.current = new AbortController();
  };
  const historyRequest = useRef(0);
  const batchHistoryRequest = useRef(0);
  const batchOperation = useRef(0);
  const [exportProgress, setExportProgress] = useState<{ operation: number; label: string } | null>(null);
  const batchScope = useRef(new AbortController());
  const beginBatchRequest = () => {
    batchScope.current.abort();
    batchScope.current = new AbortController();
    return batchScope.current.signal;
  };
  const planScope = useRef(new AbortController());
  const libraryPlanScope = useRef(new AbortController());
  const retireLibraryPlans = () => {
    libraryPlanScope.current.abort();
    libraryPlanScope.current = new AbortController();
  };
  const [confirmedPdfPlan, setConfirmedPdfPlan] = useState<string>();
  const [pdfPlan, setPdfPlan] = useState<{ id: string; sequence: number }>();
  const retirePlanScope = () => {
    retireRecordPage();
    beginBatchRequest();
    planScope.current.abort();
    planScope.current = new AbortController();
    setPdfPlan(undefined);
  };
  const retireChildView = () => {
    beginBatchRequest();
    batchOperation.current += 1;
    setBatchBusy(false);
    setBatch(null);
  };
  const [continuation, setContinuation] = useState<Continuation | null>(null);
  const [searchState, setSearchState] = useState(emptySearchState);
  const applySearchPage = useRef<(page: RunPage) => void>(() => {});
  const searchController = useMemo(() => new SearchController(library, sessionGeneration(), setSearchState,
    page => applySearchPage.current(page), libraryPlanScope.current.signal,
    () => { runGeneration.current++; retireRecordPage(); setBusy(false); }), [library, sessionGeneration(), libraryPlanScope.current.signal]);
  useLayoutEffect(() => {
    setSearchState(emptySearchState()); setContinuation(null);
    return () => searchController.dispose();
  }, [searchController]);
  applySearchPage.current = page => {
    retireRecordPage();
    runGeneration.current++;
    if (page.run.run_id !== run?.run_id) { retirePlanScope(); retireChildView(); }
    setRun(page.run); setContinuation(page.continuation ?? null); setRecords(page.records);
    setSnapshot(page.run.input); setPageTotal(page.total); setRecordOffset(page.offset); setPageSize(page.limit);
    setMessage(stateLabel(page.run)); setBusy(false);
    void refreshHistory();
  };
  const selection = useSavedSelection(library, run, sessionGeneration(), planScope.current.signal, records);
  const selected = selection.selected;
  const selectionMaximum = 100;
  const isCurrentBatchOperation = (
    operation: number,
    expectedLibrary: string,
    expectedSession: number,
  ) =>
    operation === batchOperation.current &&
    expectedLibrary === library &&
    expectedSession === sessionGeneration();
  const transferFor = (operation: number, expectedLibrary: string, expectedSession: number, signal: AbortSignal): TransferOptions => ({
    onProgress: value => {
      if (!signal.aborted && isCurrentBatchOperation(operation, expectedLibrary, expectedSession))
        setExportProgress({ operation, label: `${transferLabel(value)} · Not yet saved` });
    },
  });
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
    const current = () => expected === sessionGeneration() &&
      requestId === historyRequest.current && id === library;
    try {
      const data = await api.catalog(id, offset);
      if (!current()) return;
      setHistory(data.runs);
      setHistoryTotal(data.totals.runs);
      setHistoryOffset(offset);
    } catch (error) {
      if (current()) setError(`Saved searches unavailable. ${(error as Error).message}`);
    }
  };
  useEffect(() => {
    return onSessionInvalidated(() => {
      retireLibraryPlans();
      retirePlanScope();
      runGeneration.current += 1;
      batchOperation.current += 1;
      setSignedIn(false);
      setLibraries([]);
      setLibrary("");
      setQuery("");
      setSnapshot("");
      setRecords([]);
      selection.deselectAll();
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
    const pollAbort = new AbortController();
    const parentSignal = batchScope.current.signal;
    const abortPoll = () => pollAbort.abort();
    parentSignal.addEventListener("abort", abortPoll);
    let disposed = false, reads = 0;
    let timer: ReturnType<typeof setTimeout>;
    const current = () => !disposed && expected === sessionGeneration() && operation === batchOperation.current;
    const poll = async () => {
      try {
        const detail = await api.batch(library, id, expected, pollAbort.signal);
        if (!current()) return;
        setBatch(detail);
        if (['active', 'queued', 'running'].includes(detail.batch.state)) {
          if (++reads < 120) timer = setTimeout(poll, 2000);
          else setMessage('Automatic batch refresh paused after four minutes. Reopen the saved batch to check progress.');
        }
      } catch (e) { if (current()) setError((e as Error).message); }
    };
    timer = setTimeout(poll, 1000);
    return () => { disposed = true; clearTimeout(timer); pollAbort.abort(); parentSignal.removeEventListener("abort", abortPoll); };
  }, [signedIn, library, batch?.batch.batch_id, batchBusy]);
  const openBatch = async (id: string, propagate = false) => {
    if (!id || !library) return;
    const expected = sessionGeneration(), expectedLibrary = library;
    const operation = ++batchOperation.current;
    const signal = beginBatchRequest();
    setBatchBusy(true); setError('');
    try {
      const detail = await api.batch(expectedLibrary, id, expected, signal);
      if (isCurrentBatchOperation(operation, expectedLibrary, expected)) setBatch(detail);
    } catch (e) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected)) {
        setError((e as Error).message);
        if (propagate) throw e;
      }
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
    libraryPlanScope.current.abort();
    planScope.current.abort();
    retireChildView();
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
      selection.deselectAll();
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
    if (searchState.pending || searchState.confirmed || searchState.busy) return;
    if (serviceInfo?.searchContinuationEnabled === true) {
      retireRecordPage();
      runGeneration.current++;
      await searchController.search(query, limit);
      return;
    }
    searchController.navigate(); setContinuation(null);
    const g = ++runGeneration.current;
    retirePlanScope();
    batchOperation.current += 1;
    setBatchBusy(false); setBatch(null); setRun(null);
    const expectedSession = sessionGeneration();
    const searchLibrary = library;
    const searchSignal = planScope.current.signal;
    setBusy(true);
    setError("");
    setRecords([]);
    setPageTotal(0);
    selection.deselectAll();
    setRecordOffset(0);
    setSnapshot(query);
    try {
      const queued = await api.search(searchLibrary, query, limit, expectedSession, searchSignal);
      if (
        g !== runGeneration.current ||
        expectedSession !== sessionGeneration()
      )
        return;
      setMessage("Search queued; waiting for source metadata.");
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (g !== runGeneration.current || searchSignal.aborted || expectedSession !== sessionGeneration()) return;
        const page = await api.run(searchLibrary, queued.id, 0, expectedSession, pageSize, searchSignal);
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
  const openSaved = async (id: string, offset = 0, size = pageSize) => {
    if (!id || !library) return;
    retireRecordPage();
    searchController.navigate();
    const g = ++runGeneration.current;
    if (id !== run?.run_id) {
      retirePlanScope();
      selection.deselectAll(); setRecords([]); setRun(null); setBatch(null);
      setContinuation(null);
      batchOperation.current += 1; setBatchBusy(false);
    }
    const expectedSession = sessionGeneration();
    const savedLibrary = library;
    const savedSignal = AbortSignal.any([planScope.current.signal, recordPageScope.current.signal]);
    setBusy(true);
    setError("");
    try {
      const page = await api.run(savedLibrary, id, offset, expectedSession, size, savedSignal);
      if (
        g !== runGeneration.current ||
        expectedSession !== sessionGeneration() ||
        savedLibrary !== library
      )
        return;
      setRun(page.run);
      setContinuation(page.continuation ?? null);
      setSnapshot(page.run.input);
      setRecords(page.records);
      setPageTotal(page.total);
      setRecordOffset(offset);
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
    if (!library || !selection.ready || selected.size < 1 || selected.size > 10) return;
    const ids = selectedSearchIds(selected);
    if (ids.length !== selected.size) {
      setError("Selected records do not contain stable search IDs.");
      return;
    }
    const expected = sessionGeneration();
    const expectedLibrary = library;
    const operation = ++batchOperation.current;
    const signal = beginBatchRequest();
    setBatchBusy(true);
    setError("");
    try {
      const created = await api.createBatch(
        expectedLibrary,
        crypto.randomUUID(),
        ids,
        expected,
        signal,
      );
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected))
        return;
      const detail = await api.batch(expectedLibrary, created.id, expected, signal);
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
    const signal = beginBatchRequest();
    const batchId = batch.batch.batch_id;
    setBatchBusy(true);
    try {
      await api.controlBatch(expectedLibrary, batchId, value, expected, signal);
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected))
        return;
      const detail = await api.batch(expectedLibrary, batchId, expected, signal);
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
    const kind = originalKind(item);
    if (!library || !kind || !item.original_hash) return;
    const expected = sessionGeneration();
    const expectedLibrary = library;
    const operation = ++batchOperation.current;
    const signal = beginBatchRequest();
    setBatchBusy(true);
    try {
      const blob = await api.original(
        expectedLibrary,
        item.search_id,
        item.original_hash,
        expected,
        signal,
        transferFor(operation, expectedLibrary, expected, signal),
      );
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected))
        return;
      if (kind === "pdf" && blob.type !== "application/pdf") throw new Error("The server did not return a PDF. No file was saved.");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${item.search_id}.${kind}`;
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
    const signal = beginBatchRequest();
    setBatchBusy(true);
    try {
      const blob = await api.exportCsv(expectedLibrary, selection, expected, signal, transferFor(operation, expectedLibrary, expected, signal));
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
    const signal = beginBatchRequest();
    const batchId = batch.batch.batch_id;
    setBatchBusy(true);
    try {
      const blob = await api.exportBundle(expectedLibrary, batchId, expected, signal, transferFor(operation, expectedLibrary, expected, signal));
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected))
        return;
      if (blob.type !== "application/zip") throw new Error("The server did not return a ZIP bundle. No file was saved; try individual Save actions.");
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
  const exportXlsx = async (selection: { runID?: string; batchID?: string }) => {
    if (!library) return;
    const expected = sessionGeneration(), expectedLibrary = library;
    const operation = ++batchOperation.current;
    const signal = beginBatchRequest();
    setBatchBusy(true);
    try {
      const blob = await api.exportXlsx(expectedLibrary, selection, expected, signal, transferFor(operation, expectedLibrary, expected, signal));
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected)) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = selection.batchID ? `batch-${selection.batchID}.xlsx` : "literature-export.xlsx";
      anchor.click(); URL.revokeObjectURL(url);
    } catch (x) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected)) setError((x as Error).message);
    } finally {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected)) setBatchBusy(false);
    }
  };
  const exportStructured = async (scope: ExportScope, format: StructuredFormat) => {
    if (!library || batchBusy) return;
    const expected = sessionGeneration(), expectedLibrary = library;
    const operation = ++batchOperation.current;
    const signal = beginBatchRequest();
    const current = () => !signal.aborted && isCurrentBatchOperation(operation, expectedLibrary, expected);
    setBatchBusy(true);
    setExportProgress({ operation, label: `Preparing ${scope.runID ? "saved run" : "batch"} ${format.toUpperCase()} export…` });
    setError("");
    try {
      const { blob, filename } = await structuredExport(expectedLibrary, scope, format, expected, signal, transferFor(operation, expectedLibrary, expected, signal));
      if (!current()) return;
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
      } finally { URL.revokeObjectURL(url); }
    } catch (failure) {
      if (current()) setError((failure as Error).message);
    } finally {
      if (current()) { setBatchBusy(false); setExportProgress(null); }
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
                retireLibraryPlans();
                retirePlanScope();
                runGeneration.current += 1;
                historyRequest.current += 1;
                setHistory([]); setHistoryTotal(0); setHistoryOffset(0);
                batchOperation.current += 1;
                setLibrary(e.target.value);
                setRecords([]);
                setRun(null);
                setPageTotal(0);
                selection.deselectAll();
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
              <label className="query" htmlFor="pubmed-query">Query</label>
                <textarea
                  id="pubmed-query"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  maxLength={2000}
                  rows={3}
                  required
                  placeholder="Enter a PubMed query"
                />
              <label>
                Page size
                <select
                  value={pageSize}
                  onChange={(e) => {
                    const size = Number(e.target.value);
                    setPageSize(size);
                    if (run) void openSaved(run.run_id, 0, size);
                  }}
                  disabled={busy}
                  aria-label="Page size"
                >
                  {[5, 25, 50, 100].map((n) => <option key={n}>{n}</option>)}
                </select>
              </label>
              <label>
                Metadata page limit
                <select
                  aria-label="Retrieved limit"
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                >
                  {[5, 10, 25, 50, 100].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <button disabled={busy || searchState.busy || !!searchState.pending || !!searchState.confirmed || !library || serviceInfo?.searchEnabled !== true}>
                {busy ? "Working…" : "Search PubMed"}
              </button>
            </form>
          </section>
          {(run || searchState.pending || searchState.confirmed || searchState.busy || searchState.error) && <ContinuationPanel
            key={`${library}:${sessionGeneration()}:${run?.run_id ?? ""}`} status={continuation} state={searchState} controller={searchController}
            runID={run?.run_id} visible={records.length} checked={selected.size} />}
          <SearchHistory runs={history} total={historyTotal} offset={historyOffset}
            selectedID={run?.run_id ?? ""} busy={busy} onOpen={id => void openSaved(id)}
            onPage={offset => void refreshHistory(library, offset)} />
          {(message || error) && (
            <p className={error ? "error status" : "status"} role="status">
              {error || message}
            </p>
          )}
          {run && (
            <section className="summary">
              <div className="query-snapshot">
                <span className="muted">Query snapshot</span>
                <strong>{snapshot}</strong>
                <span className="small">Search Run ID: {run.run_id}</span>
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
          <section className="selection-toolbar" aria-label="Saved record selection">
            <p aria-live="polite"><strong>{selected.size} selected of {run?.fetched ?? 0} retrieved records</strong> · Provider total: {run?.total ?? 0} matches</p>
            <p className="muted small">{selection.pageOnly
              ? "This run has more than 100 saved records. Select all on this page replaces the checked subset with this visible page only; individual checks may span pages, up to 100 records."
              : "Select all covers the saved search across pages, up to 100 records. Initial saved records are selected once; continuation never automatically checks new rows."} Your changes remain until you choose another run. Nothing is acquired until you click a download or batch action.</p>
            <div className="result-actions">
              <button className="secondary" disabled={!selection.ready} onClick={selection.selectAll}>{selection.pageOnly ? `Select all on this page (${records.length})` : "Select all"}</button>
              <button className="secondary" disabled={!selection.ready || !selected.size} onClick={selection.deselectAll}>Deselect all</button>
            </div>
            {selection.loading && <p role="status">Loading the complete saved record selection… Admission is disabled until this finishes.</p>}
            {selection.error && <div role="alert"><p>{selection.error}</p><button onClick={selection.retry}>Retry loading selection</button></div>}
          </section>
          <PdfAvailability selectedCount={selected.size} ids={selectedSearchIds(selected)} ready={selection.ready && !busy}
            enabled={serviceInfo?.pdfEnabled === true} plansEnabled={serviceInfo?.planEnabled === true}
            library={library} runID={run?.run_id} generation={sessionGeneration()} scopeSignal={planScope.current.signal}
            confirmedPlanID={confirmedPdfPlan} policy={serviceInfo?.pdfPolicySummary} onStart={retireChildView}
            onBatch={id => openBatch(id, true)} onPlan={id => setPdfPlan(value => ({ id, sequence: (value?.sequence ?? 0) + 1 }))} />
          <div className="result-head">
            <h2>
              Results <span className="count">{records.length}</span>
            </h2>
            <div className="result-actions">
              <span aria-live="polite">{selected.size} selected across saved record pages (maximum {selectionMaximum})</span>
              <button
                className="secondary"
                disabled={!run || batchBusy}
                onClick={() => run && exportCsv({ runID: run.run_id })}
              >
                Export CSV
              </button>
              <button
                className="secondary"
                disabled={!run || batchBusy}
                onClick={() => run && exportXlsx({ runID: run.run_id })}
              >
                Export XLSX
              </button>
              {(["json", "jsonl"] as const).map(format => (
                <button className="secondary" key={format} disabled={!run || busy || batchBusy}
                  aria-describedby="run-structured-scope"
                  onClick={() => run && void exportStructured({ runID: run.run_id }, format)}>
                  Export saved run {format.toUpperCase()}
                </button>
              ))}
              <button
                className="secondary"
                disabled={
                  selected.size < 1 ||
                  !selection.ready ||
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
          {batchBusy && exportProgress?.operation === batchOperation.current && <div>
            <p role="status">{exportProgress.label}</p>
            <button className="secondary" onClick={() => { beginBatchRequest(); batchOperation.current++; setBatchBusy(false); setExportProgress(null); setMessage("Transfer cancelled. No file was saved."); }}>Cancel download</button>
          </div>}
          <p id="run-structured-scope" className="muted small">CSV, XLSX, JSON / JSONL exports include all saved records in the run, not just selected checkboxes or the current page, up to the existing 1,000-record export limit. Provider matches that were not retrieved are not included. These are metadata files, not full-text downloads.</p>
          {records.length ? (
            records.map((a, i) => (
              <ArticleCard
                key={searchId(a) || `${String(a.Pmid)}-${i}`}
                article={a}
                selected={selected.has(searchId(a))}
                disabled={!selection.ready}
                onSelect={() => {
                  if (!selected.has(searchId(a)) && selected.size >= selectionMaximum) setError(`Selection limit reached. Clear or deselect a record before choosing another; maximum ${selectionMaximum}.`);
                  selection.toggle(a);
                }}
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
                    openSaved(run.run_id, Math.max(0, recordOffset - pageSize))
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
          {library && <PlanWorkspace
            key={`${sessionGeneration()}:${library}`}
            library={library} runID={run?.run_id ?? ""} generation={sessionGeneration()}
            selectedIDs={selectedSearchIds(selected)} enabled={serviceInfo?.planEnabled === true}
            selectedArticles={[...selected.values()]} savedSetEnabled={serviceInfo?.savedSetEnabled === true}
            pdfEnabled={serviceInfo?.pdfEnabled === true}
            scopeSignal={libraryPlanScope.current.signal} onPlanChange={retireChildView}
            admissionReady={selection.ready} openRequest={pdfPlan} onOpened={setConfirmedPdfPlan}
            onChild={id => { retireChildView(); void openBatch(id); }}
          />}
          {batch && (
            <section className="panel batch-panel">
              <div className="result-head">
                <div>
                  <h2>Batch {batch.batch.batch_id}</h2>
                  <p className="muted small">
                    {batch.batch.state} · {batch.total} selected records
                    {` · Requested ${(batch.requestedFormat ?? "xml").toUpperCase()}`}
                    {batch.batch.plan_id && <> · Controlled by plan {batch.batch.plan_id}. Open it in Saved plans to pause, resume, retry or cancel.</>}
                  </p>
                </div>
                <div className="result-actions">
                  <button
                    className="secondary"
                    disabled={batchBusy || !!batch.batch.plan_id}
                    onClick={() => controlBatch("pause")}
                  >
                    Pause
                  </button>
                  <button
                    className="secondary"
                    disabled={batchBusy || !!batch.batch.plan_id}
                    onClick={() => controlBatch("resume")}
                  >
                    Resume
                  </button>
                  <button
                    className="secondary"
                    disabled={batchBusy || !!batch.batch.plan_id}
                    onClick={() => controlBatch("retry")}
                  >
                    Retry eligible
                  </button>
                  <button
                    className="secondary"
                    disabled={batchBusy || !!batch.batch.plan_id}
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
                    onClick={() => exportXlsx({ batchID: batch.batch.batch_id })}
                  >
                    Export batch XLSX
                  </button>
                  {(["json", "jsonl"] as const).map(format => (
                    <button className="secondary" key={format} disabled={batchBusy}
                      aria-describedby="batch-structured-scope"
                      onClick={() => void exportStructured({ batchID: batch.batch.batch_id }, format)}>
                      Export batch {format.toUpperCase()}
                    </button>
                  ))}
                  <button
                    className="secondary"
                    disabled={batchBusy}
                    onClick={exportBundle}
                  >
                    {batch.requestedFormat === "pdf" ? "Save PDF ZIP" : "Download original bundle"}
                  </button>
                </div>
              </div>
              <p className="muted" aria-label="Batch progress">{Object.entries(batch.counts).map(([state, count]) => `${count} ${state}`).join(" · ")}. Acquired files are on the server; use Save to download to this device.</p>
              <p id="batch-structured-scope" className="muted small">JSON / JSONL exports include all saved records in this batch, including held outcomes, independent of checkboxes and page. Original-file metadata does not confirm current download availability; use the current Save actions for available originals.</p>
              {batch.items.map((item) => (
                <div className="batch-item" key={item.search_id}>
                  <strong className="batch-title">
                    {String(item.article.Title ?? item.search_id)}
                  </strong>
                  <p className="batch-state">
                    {item.state}
                    {item.reason ? ` · ${item.reason}` : ""}
                  </p>
                  <SourceLinks article={item.article} />
                  {originalKind(item) && item.original_hash ? (
                    <>
                      <button
                        className="secondary small-button"
                        disabled={batchBusy}
                        onClick={() => saveOriginal(item)}
                      >
                        {originalKind(item) === "pdf" ? "Save PDF" : "Save XML"}
                      </button>
                      <small className="muted">
                        {item.format ?? "XML"} ·{" "}
                        {item.version ?? "repository snapshot"} ·{" "}
                        {item.mediaType ? `${item.mediaType} · ` : ""}
                        {item.depositVersion ? `Deposit ${item.depositVersion} (${item.depositType ?? "type not supplied"}) · ` : ""}
                        {typeof item.bytes === "number" ? `${item.bytes} bytes · ` : ""}SHA-256{" "}
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
              Search retrieves at most 100 identities per metadata page. New continuation-enabled runs capture an operational window of up to 1,000 identities; each next page requires an explicit request. Legacy runs keep their original saved scope. Each batch processes up to 10 checked saved records. PDF acquisition requires the current server policy and a permitted repository original; unavailable records retain reasons and source links. Create batch acquires XML, while Download PDFs explicitly requests PDF. Server acquisition is separate from downloads to this device. No publisher account login is provided.
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
