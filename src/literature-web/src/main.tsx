import React, { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  ApiError,
  Article,
  Library,
  Run,
  RunPage,
  BatchDetail,
  SavedBatch,
  ServiceInfo,
  type MetadataExportScope,
  metadataFilename,
  clearSession,
  onSessionInvalidated,
  sessionGeneration,
} from "./api";
import { ArticleCard, SourceLinks } from "./components/ArticleCard";
import { SourceOutcomeView } from "./components/SourceOutcome";
import { canAdvanceRecords } from "./pagination";
import { searchId } from "./selection";
import { useSavedSelection } from "./savedSelection";
import { selectionIntentLabel } from "./runSelection";
import { originalKind } from "./originalKind";
import { structuredExport, type ExportScope, type StructuredFormat } from "./structuredExport";
import { PlanWorkspace } from "./plans/PlanWorkspace";
import { TransferOptions, transferLabel } from "./transfer";
import { SearchHistory } from "./components/SearchHistory";
import { PdfAvailability } from "./components/PdfAvailability";
import { Continuation } from "./continuation/api";
import { SearchController, emptySearchState } from "./continuation/controller";
import { UserRouteControls } from "./userRoute/Controls";
import { ContinuationPanel } from "./continuation/ContinuationPanel";
import { CaptureControls } from "./stagedQuery/CaptureControls";
import { ExportPanel } from "./stagedQuery/ExportPanel";
import { exportContext } from "./stagedQuery/api";
import { countLabel } from "./stagedQuery/capture";
import { FilterChips, SearchFilters } from "./components/SearchFilters";
import { composeSearch, emptyFilters, filterCount, restoreSearch } from "./searchFilters";
import { readWorkspaceRoute, writeWorkspaceRoute, WorkspaceView } from "./workspaceNavigation";
import "./styles.css";
import "./workspace.css";

function safeRightsLink(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
function metadataExportError(failure: unknown, scope: MetadataExportScope) {
  return scope.selection === "selected" && failure instanceof ApiError && failure.status === 409
    ? "The saved selection changed. Reload saved selection, then export the current choices. No file was saved."
    : (failure as Error).message;
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
export function App() {
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
  const [sessionCheckError, setSessionCheckError] = useState("");
  const [sessionChecking, setSessionChecking] = useState(false);
  const [view, setView] = useState<WorkspaceView>("search");
  const [selectionReadVersion, setSelectionReadVersion] = useState(0);
  const [filters, setFilters] = useState(emptyFilters);
  const [pdfNotice, setPdfNotice] = useState({ library: "", runID: "", message: "" });
  const navigationTarget = useRef(readWorkspaceRoute());
  const workspaceNavigation = useRef(0);
  const showView = (next: WorkspaceView) => {
    workspaceNavigation.current++;
    if (next === "search" && view !== next) setSelectionReadVersion(value => value + 1);
    setView(next);
    writeWorkspaceRoute({ library, run: run?.run_id ?? "", view: next });
  };
  const restoreQuery = (input: string) => {
    const restored = restoreSearch(input);
    setQuery(restored.query); setFilters(restored.filters);
  };
  let effectiveQuery = query, filterError = "";
  try { effectiveQuery = composeSearch(query, filters); }
  catch (failure) { filterError = (failure as Error).message; }
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
  const searchBlocked = busy || searchState.busy || !!searchState.pending || !!searchState.confirmed || !!searchState.browserPending;
  const draftChanged = !!run && (!!filterError || effectiveQuery.trim() !== snapshot);
  const activeSearchError = searchState.error || (run?.state === "error" ? stateLabel(run) : "");
  const activeSearchMessage = activeSearchError || searchState.notice || (searchState.pending
    ? "Search confirmation is pending. Return to search progress before retrying."
    : searchState.busy || searchState.confirmed || (run && ["queued", "running"].includes(run.state))
      ? "Search in progress. Results are not ready yet." : "");
  const applySearchPage = useRef<(page: RunPage) => void>(() => {});
  const browserSourceEnabled = useRef(false);
  browserSourceEnabled.current = serviceInfo?.userRouteEnabled === true;
  const stagedQueryEnabled = useRef(false);
  stagedQueryEnabled.current = serviceInfo?.stagedQueryEnabled === true;
  const searchController = useMemo(() => new SearchController(library, sessionGeneration(), setSearchState,
    page => applySearchPage.current(page), libraryPlanScope.current.signal,
    () => { runGeneration.current++; retireRecordPage(); setBusy(false); }, () => browserSourceEnabled.current,
    () => stagedQueryEnabled.current), [library, sessionGeneration(), libraryPlanScope.current.signal]);
  useLayoutEffect(() => {
    setSearchState(emptySearchState()); setContinuation(null);
    return () => searchController.dispose();
  }, [searchController]);
  applySearchPage.current = page => {
    retireRecordPage();
    runGeneration.current++;
    if (page.run.run_id !== run?.run_id) { retirePlanScope(); retireChildView(); }
    if (page.run.run_id !== run?.run_id) {
      // A response belongs to the submitted snapshot; a later draft remains
      // editable and visibly unapplied until the researcher submits it.
      if (!filterError && effectiveQuery === snapshot) restoreQuery(page.run.input);
      writeWorkspaceRoute({ library, run: page.run.run_id, view });
    }
    setRun(page.run); setContinuation(page.continuation ?? null); setRecords(page.records);
    setSelectionReadVersion(value => value + 1);
    setSnapshot(page.run.input); setPageTotal(page.total); setRecordOffset(page.offset); setPageSize(page.limit);
    setMessage(stateLabel(page.run)); setBusy(false);
    void refreshHistory();
  };
  const selection = useSavedSelection(library, run, sessionGeneration(), planScope.current.signal, records, serviceInfo, selectionReadVersion);
  const selected = selection.selected;
  const selectionMaximum = selection.snapshot?.selectionLimit ?? (serviceInfo?.selectionRecordLimit === 20000 ? 20000 : 1000);
  const stagedExportContext = useMemo(() => continuation && selection.snapshot
    ? exportContext(continuation, selection.snapshot, snapshot) : null, [continuation, selection.snapshot, snapshot]);
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
    if (!library && data.items[0]) {
      const preferred = navigationTarget.current?.library;
      setLibrary(data.items.find(item => item.library_id === preferred)?.library_id ?? data.items[0].library_id);
    }
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
      setFilters(emptyFilters()); setView("search");
      navigationTarget.current = null; writeWorkspaceRoute(null, true);
      setSnapshot("");
      setRecords([]);
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
  const checkSavedSession = async () => {
    const expected = sessionGeneration();
    setSessionChecking(true); setSessionCheckError("");
    try { await api.session(); setSignedIn(true); }
    catch (failure) {
      // 401 is expected for an anonymous visitor. Busy/offline reads do not
      // establish logout and must leave an explicit, read-only recovery action.
      if (expected === sessionGeneration() && !(failure instanceof ApiError && failure.status === 401))
        setSessionCheckError("Your sign-in status could not be checked. Wait briefly, then check again. Saved research remains on the server.");
    } finally { setSessionChecking(false); }
  };
  useEffect(() => { void checkSavedSession(); }, []);
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
      if (isCurrentBatchOperation(operation, expectedLibrary, expected)) { setBatch(detail); setView("downloads"); }
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
      setFilters(emptyFilters()); setView("search");
      navigationTarget.current = null; writeWorkspaceRoute(null, true);
      setSnapshot("");
      setRecords([]);
      setHistory([]);
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
    if (busy || serviceInfo?.searchEnabled !== true || searchState.pending || searchState.confirmed || searchState.busy || searchState.browserPending) return;
    if (filterError) { setError(filterError); return; }
    const submitted = effectiveQuery;
    setView("search"); setError(""); setMessage("");
    writeWorkspaceRoute({ library, run: "", view: "search" });
    if (serviceInfo?.searchContinuationEnabled === true) {
      retirePlanScope(); retireChildView();
      runGeneration.current++;
      setRun(null); setRecords([]); setPageTotal(0); setContinuation(null);
      setSnapshot(submitted); setRecordOffset(0);
      await searchController.search(submitted, limit);
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
    setRecordOffset(0);
    setSnapshot(submitted);
    try {
      const queued = await api.search(searchLibrary, submitted, limit, expectedSession, searchSignal);
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
        writeWorkspaceRoute({ library: searchLibrary, run: page.run.run_id, view: "search" }, true);
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
  const openSaved = async (id: string, offset = 0, size = pageSize, remember = true, nextView: WorkspaceView = "search") => {
    if (!id || !library) return;
    const navigation = workspaceNavigation.current;
    retireRecordPage();
    searchController.navigate();
    const g = ++runGeneration.current;
    if (id !== run?.run_id) {
      retirePlanScope();
      setRecords([]); setRun(null); setBatch(null);
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
      setSelectionReadVersion(value => value + 1);
      setSnapshot(page.run.input);
      restoreQuery(page.run.input);
      // A delayed restore may publish its saved data, but cannot replace a
      // workspace the researcher selected after this read started.
      if (navigation === workspaceNavigation.current) {
        setView(nextView);
        if (remember) writeWorkspaceRoute({ library: savedLibrary, run: id, view: nextView });
      }
      setRecords(page.records);
      setPageTotal(page.total);
      setRecordOffset(offset);
      setMessage(stateLabel(page.run));
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
    if (!library || !selection.detailsReady || draftChanged || busy || selected.size < 1 || selected.size > 10) return;
    const ids = [...selection.ids];
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
      setView("downloads");
    } catch (x) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setError((x as Error).message);
    } finally {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setBatchBusy(false);
    }
  };
  const changeLibrary = (id: string, remember = true) => {
    if (id === library) return;
    retireLibraryPlans(); retirePlanScope();
    runGeneration.current++; historyRequest.current++; batchOperation.current++; batchHistoryRequest.current++;
    setHistory([]); setHistoryTotal(0); setHistoryOffset(0);
    setLibrary(id); setRecords([]); setRun(null); setPageTotal(0); setRecordOffset(0);
    setSnapshot(""); setQuery(""); setFilters(emptyFilters()); setView("search");
    setBatch(null); setSavedBatches([]); setBatchOffset(0); setBatchTotal(0);
    setBusy(false); setBatchBusy(false); setError(""); setMessage("");
    if (remember) { navigationTarget.current = null; writeWorkspaceRoute({ library: id, run: "", view: "search" }); }
  };
  // Reopening reads the server's complete effective query. A browser entry is
  // only a requested location, fenced by the current account's library list.
  useEffect(() => {
    if (!signedIn || !library || !libraries.length) return;
    const restore = () => {
      const target = navigationTarget.current;
      if (!target) return;
      if (!libraries.some(item => item.library_id === target.library)) {
        navigationTarget.current = null; writeWorkspaceRoute(null, true); return;
      }
      if (target.library !== library) { changeLibrary(target.library, false); return; }
      navigationTarget.current = null;
      if (target.run && target.run !== run?.run_id) void openSaved(target.run, 0, pageSize, false, target.view);
      else {
        if (!target.run && run) {
          searchController.navigate(); retirePlanScope(); retireChildView(); runGeneration.current++;
          setRun(null); setRecords([]); setPageTotal(0); setRecordOffset(0);
          setSnapshot(""); setQuery(""); setFilters(emptyFilters()); setContinuation(null); setBusy(false);
        } else if (run) {
          restoreQuery(snapshot);
          if (target.view === "search") setSelectionReadVersion(value => value + 1);
        }
        setView(target.view);
      }
    };
    restore();
    const back = () => {
      workspaceNavigation.current++;
      navigationTarget.current = readWorkspaceRoute();
      if (navigationTarget.current) restore();
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [signedIn, library, libraries, run?.run_id, snapshot, pageSize]);
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
  const exportCsv = async (selection: MetadataExportScope) => {
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
      anchor.download = metadataFilename(selection, "csv");
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (x) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected))
        setError(metadataExportError(x, selection));
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
  const exportXlsx = async (selection: MetadataExportScope) => {
    if (!library) return;
    const expected = sessionGeneration(), expectedLibrary = library;
    const operation = ++batchOperation.current;
    const signal = beginBatchRequest();
    setBatchBusy(true);
    try {
      const blob = await api.exportXlsx(expectedLibrary, selection, expected, signal, transferFor(operation, expectedLibrary, expected, signal));
      if (!isCurrentBatchOperation(operation, expectedLibrary, expected)) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = metadataFilename(selection, "xlsx");
      anchor.click(); URL.revokeObjectURL(url);
    } catch (x) {
      if (isCurrentBatchOperation(operation, expectedLibrary, expected)) setError(metadataExportError(x, selection));
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
      if (current()) setError(metadataExportError(failure, scope));
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
          {sessionCheckError && <div><p role="alert">{sessionCheckError}</p>
            <button className="secondary" disabled={busy || sessionChecking} onClick={() => void checkSavedSession()}>Check sign-in again</button></div>}
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
            <button disabled={busy || sessionChecking}>{busy ? "Signing in…" : "Sign in"}</button>
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
    <main className="shell research-workspace">
      <header className="topbar">
        <div className="brand"><h1>LitraDock</h1><span className="muted small">Research with PubMed</span></div>
        <div className="account-controls">
          <label className="sr-only">Library</label>
            <select
              value={library}
              onChange={e => changeLibrary(e.target.value)}
              aria-label="Choose library"
            >
              <option value="">Choose a library</option>
              {libraries.map((x) => (
                <option key={x.library_id} value={x.library_id}>
                  {x.name}
                </option>
              ))}
            </select>

          <button className="secondary" onClick={signOut} disabled={busy}>Sign out</button>
        </div>
      </header>
      <nav className="workspace-nav" aria-label="Workspace">
        {([['search', 'Search & PDFs'], ['history', 'Saved searches'], ['downloads', 'Downloads'], ['plans', 'Research plans'], ['library', 'Libraries']] as const).map(([key, label]) =>
          <button key={key} className={view === key ? 'active' : 'secondary'} aria-current={view === key ? 'page' : undefined} onClick={() => showView(key)}>{label}</button>)}
      </nav>
      {view !== "search" && pdfNotice.message && pdfNotice.library === library && pdfNotice.runID === run?.run_id &&
        <div className="pdf-view-notice" role="status"><p>{pdfNotice.message}</p><button className="secondary" onClick={() => showView("search")}>Return to PDF progress</button></div>}
      {view !== "search" && activeSearchMessage &&
        <div className="search-view-notice" role={activeSearchError ? "alert" : "status"}>
          <p>{activeSearchMessage}</p>
          <button className="secondary" onClick={() => showView("search")}>Return to search progress</button>
        </div>}
      {(error || (message && message !== stateLabel(run))) && <p className={error ? "error status" : "status"} role={error ? "alert" : "status"}>{error || message}</p>}
      {batchBusy && exportProgress?.operation === batchOperation.current && <div className="transfer-notice">
        <p role="status">{exportProgress.label}</p>
        <button className="secondary" onClick={() => { beginBatchRequest(); batchOperation.current++; setBatchBusy(false); setExportProgress(null); setMessage("Transfer cancelled. No file was saved."); }}>Cancel download</button>
      </div>}
      <div hidden={view !== "search"}>
        <section className="panel search-panel" aria-label="PubMed search">
          <form id="pubmed-search" onSubmit={submitSearch}>
            <div className="query"><label htmlFor="pubmed-query">Search PubMed</label>
              <textarea id="pubmed-query" value={query} onChange={e => setQuery(e.target.value)}
                maxLength={2000} rows={1} required placeholder="Topic, title, author or PubMed query"
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            </div>
            <button disabled={searchBlocked || !library || serviceInfo?.searchEnabled !== true}>{searchBlocked ? "Working…" : <>Search<span className="sr-only"> PubMed</span></>}</button>
          </form>
          <details className="search-options"><summary>Search options</summary>
            <p>Boolean and fielded queries are supported, for example <code>"heart failure"[Title] AND 2020:2024[dp]</code>. Shift+Enter adds a line.</p>
            <label>Records to retrieve per request <select aria-label="Retrieved limit" value={limit} onChange={e => setLimit(Number(e.target.value))}>
              {[5, 10, 25, 50, 100].map(n => <option key={n}>{n}</option>)}
            </select></label>
          </details>
          {serviceInfo?.userRouteEnabled === true && <UserRouteControls />}
        </section>
        <div className="research-grid">
          <SearchFilters filters={filters} onChange={setFilters} disabled={searchBlocked} appliedRun={run?.run_id} canSearch={!!library && !!query.trim() && serviceInfo?.searchEnabled === true} />
          <section className="active-results" aria-label="Active results">
            {!!filterCount(filters) && <p className="filter-state">{run && !draftChanged ? 'Filters applied' : 'Filters for next search'}</p>}
            <FilterChips filters={filters} onChange={setFilters} disabled={searchBlocked} />
            {draftChanged && <div className="draft-notice" role="status">Search changes are not applied. Results and selection still belong to the saved search.
              <button className="secondary" onClick={() => restoreQuery(snapshot)}>Restore active search</button>
            </div>}
            {serviceInfo?.searchEnabled === false && <p className="muted">New searches are temporarily disabled. Saved results remain available.</p>}
            <div className="result-head compact-result-head">
              <div><h2 id="results-heading" tabIndex={-1}>Results <span className="count">{countLabel(run?.total ?? 0, continuation?.capture ? "initial match" : "match", continuation?.capture ? "initial matches" : "matches")}</span></h2>
                <p className="muted small">{continuation?.capture ? `${countLabel(continuation.windowCount, "ID captured", "IDs captured")} · ${continuation.savedCount.toLocaleString()} saved` : `${run?.fetched ?? 0} loaded`} · {records.length ? recordOffset + 1 : 0}–{recordOffset + records.length} shown{run && !continuation?.capture ? ` · ${run.state}` : ''}</p>
              </div>
              <div className="result-display"><span className="small">{continuation?.capture && continuation.capture.state !== "not_started" ? "Order: saved sequence" : "Sort: PubMed relevance"}</span>
                <label>Per page <select aria-label="Page size" value={pageSize} disabled={busy} onChange={e => { const size = Number(e.target.value); setPageSize(size); if (run) void openSaved(run.run_id, 0, size); }}>
                  {[5, 25, 50, 100].map(n => <option key={n}>{n}</option>)}
                </select></label>
              </div>
            </div>
            {continuation?.capture && <CaptureControls status={continuation} state={searchState} controller={searchController}
              enabled={serviceInfo?.stagedQueryEnabled === true && serviceInfo?.userRouteEnabled === true} blocked={busy || draftChanged} />}
            <div className="selection-and-pdfs">
              <section className="selection-toolbar" aria-label="Saved record selection">
                <p aria-live="polite" style={{ lineHeight: 1.35, marginBottom: ".3rem" }}><strong>{selection.snapshot ? `${selection.count} selected of ${selection.total} saved ${selection.total === 1 ? 'record' : 'records'}` : run ? 'Selection not loaded' : 'No saved selection'}</strong></p>
                <div className="result-actions">
                  <button className="secondary" aria-label="Select all saved" disabled={!selection.canEdit || draftChanged || busy} onClick={selection.selectAll}>All saved</button>
                  <button className="secondary" disabled={!selection.canEdit || draftChanged || busy} onClick={selection.deselectAll}>Deselect all</button>
                  <details className="selection-scope"><summary>Selection scope</summary>
                    <div className="result-actions">
                      <button className="secondary" disabled={!selection.canEdit || !records.length || draftChanged || busy} onClick={selection.selectPage}>Select page</button>
                      <button className="secondary" disabled={!selection.canEdit || !records.length || draftChanged || busy} onClick={selection.deselectPage}>Deselect page</button>
                    </div>
                    <p>All saved covers this run across pages, up to {selectionMaximum.toLocaleString()} records. Page controls add or remove only this page. Choices are saved to your library and restored when you reopen the run. All / none also applies to newly retrieved records; individual exceptions remain. PubMed matches not yet saved are excluded.</p>{run && !selection.unavailable && !selection.pending && !selection.error && <button className="secondary" disabled={selection.loading || busy} onClick={() => void selection.reload()}>Reload saved selection</button>}
                  </details>
                </div>
                {selection.loading && <p role="status">Loading saved selection…</p>}
                {selection.saving && <p role="status">Saving selection…</p>}
                {selection.unavailable && <p role="alert">Saved selection is unavailable on this server. Reload after the service is enabled, or export all saved results.</p>}
                {selection.ready && !selection.canEdit && <p role="status">Saved choices are available to read. Selection changes are currently disabled.</p>}
                {selection.pending && <p role="status">Pending choice: {selectionIntentLabel(selection.pending.body)}. Displayed checks reflect the last confirmed server state.</p>}
                {selection.error && <p role="alert">{selection.error}</p>}
                {(selection.pending || selection.error) && <button className="secondary" disabled={selection.saving || selection.loading || busy} onClick={() => void selection.reload()}>Reload saved selection</button>}
                {selection.pending?.phase === 'uncertain' && !selection.saving && !selection.loading && <button onClick={() => void selection.retry()}>Retry same selection change</button>}
                {stagedExportContext && selection.count > 100 && <ExportPanel compact library={library} context={stagedExportContext} generation={sessionGeneration()}
                  signal={planScope.current.signal} blocked={!selection.ready || busy || batchBusy || draftChanged || searchBlocked}
                  onRefresh={() => { void selection.reload(); if (run) void searchController.read(run.run_id); }} />}
              </section>
              <details className="pdf-selection-details" open={!(continuation?.capture && (selection.count === 0 || selection.count > 100) && !pdfNotice.message)}>
                <summary hidden={!(continuation?.capture && (selection.count === 0 || selection.count > 100) && !pdfNotice.message)}>PDFs · 10 per batch / 100 per plan</summary>
                {selection.snapshot && !selection.snapshot.recordsComplete && <p className="small selection-limit-detail">{selection.snapshot.recordsReason} All choices remain saved. Export the full selection as metadata, or choose up to 100 records for PDFs or a research snapshot.</p>}
              <PdfAvailability selectedCount={selected.size} ids={[...selection.ids]} ready={selection.detailsReady && !busy && !draftChanged}
                enabled={serviceInfo?.pdfEnabled === true} plansEnabled={serviceInfo?.planEnabled === true}
                library={library} runID={run?.run_id} generation={sessionGeneration()} scopeSignal={planScope.current.signal}
                confirmedPlanID={confirmedPdfPlan} policy={serviceInfo?.pdfPolicySummary} onStart={retireChildView} onStatus={setPdfNotice}
                onBatch={id => openBatch(id, true)} onPlan={id => { setPdfPlan(value => ({ id, sequence: (value?.sequence ?? 0) + 1 })); setView('plans'); }} />
              </details>
            </div>
            <div className={continuation?.capture ? "result-secondary-options" : undefined}>
            {(run || searchState.pending || searchState.confirmed || searchState.busy || searchState.error) && <details className="saved-search-detail" open={!continuation?.capture && !!(searchState.pending || searchState.confirmed || searchState.busy || searchState.error || (run && ['queued', 'running', 'error'].includes(run.state)))}>
              <summary>Search progress and query details{!continuation?.capture && continuation?.canContinue ? ' · More records available' : ''}</summary>
              {run && <div className="query-snapshot"><span className="muted">Query snapshot</span><strong>{snapshot}</strong><span className="small">Search Run ID: {run.run_id}</span></div>}
              <ContinuationPanel key={`${library}:${sessionGeneration()}:${run?.run_id ?? ""}`} status={continuation} state={searchState} controller={searchController}
                runID={run?.run_id} visible={records.length} checked={selected.size} />
            </details>}
            <details className="export-options"><summary>Export saved results and other actions</summary>
            {stagedExportContext && selection.count <= 100 && <ExportPanel library={library} context={stagedExportContext} generation={sessionGeneration()}
              signal={planScope.current.signal} blocked={!selection.ready || busy || batchBusy || draftChanged || searchBlocked}
              onRefresh={() => { void selection.reload(); if (run) void searchController.read(run.run_id); }} />}
            {continuation?.capture && !stagedExportContext && <p role="status">Refresh saved progress and selection to prepare a matching export scope.
              <button className="secondary" disabled={busy || searchBlocked || selection.loading || selection.saving}
                onClick={() => { void selection.reload(); if (run) void searchController.read(run.run_id); }}>Refresh progress and selection</button></p>}
            <details open={!continuation?.capture}><summary>Single-file exports and XML batch</summary>
          <div className="result-head">
            <div className="result-actions">
              <span aria-live="polite">{selection.count} selected across saved record pages (maximum {selectionMaximum})</span>
              <button
                className="secondary"
                disabled={!run || batchBusy || pageTotal > 1000}
                onClick={() => run && exportCsv({ runID: run.run_id })}
              >
                Export saved CSV
              </button>
              <button
                className="secondary"
                disabled={!run || batchBusy || pageTotal > 1000}
                onClick={() => run && exportXlsx({ runID: run.run_id })}
              >
                Export saved XLSX
              </button>
              {(["json", "jsonl"] as const).map(format => (
                <button className="secondary" key={format} disabled={!run || busy || batchBusy || pageTotal > 1000}
                  aria-describedby="run-structured-scope"
                  onClick={() => run && void exportStructured({ runID: run.run_id }, format)}>
                  Export saved run {format.toUpperCase()}
                </button>
              ))}
              {(["csv", "xlsx", "json", "jsonl"] as const).map(format => (
                <button className="secondary" key={`selected-${format}`}
                  disabled={!run || !selection.ready || !selection.count || busy || batchBusy || draftChanged || selection.total > 1000}
                  onClick={() => {
                    if (!run || !selection.ready || !selection.revision || !selection.count) return;
                    const scope = { runID: run.run_id, selection: "selected" as const, selectionRevision: selection.revision,
                      selectedIDs: [...selection.ids], savedCount: selection.total };
                    if (format === "csv") void exportCsv(scope);
                    else if (format === "xlsx") void exportXlsx(scope);
                    else void exportStructured(scope, format);
                  }}>Export selected {format.toUpperCase()}</button>
              ))}
              <button
                className="secondary"
                disabled={
                  selected.size < 1 ||
                  draftChanged || busy ||
                  !selection.detailsReady ||
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
          <p id="run-structured-scope" className="muted small">Single-file saved exports include all saved records in this run. Single-file selected exports include exactly the confirmed checked records across pages, at the saved selection revision. Both support runs of up to 1,000 saved records; larger runs use metadata ZIP or explicit parts above. Unsaved provider matches are excluded. These are metadata files, not full-text downloads.</p>
            </details>
            </details>
            </div>
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

          {records.length ? (
            records.map((a, i) => (
              <ArticleCard
                onOpenBatch={id => void openBatch(id)}
                key={searchId(a) || `${String(a.Pmid)}-${i}`}
                article={a}
                selected={selected.has(searchId(a))}
                disabled={!selection.canEdit || busy || draftChanged}
                onSelect={() => {
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

          </section>
        </div>
      </div>
      <div hidden={view !== 'history'}>
        <SearchHistory runs={history} total={historyTotal} offset={historyOffset} selectedID={run?.run_id ?? ''} busy={busy}
          onOpen={id => void openSaved(id)} onPage={offset => void refreshHistory(library, offset)} />
      </div>
      <div hidden={view !== 'downloads'}>
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
                  <SourceOutcomeView outcome={item.sourceOutcome} />
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

      </div>
      <div hidden={view !== 'plans'}>
          {library && <PlanWorkspace
            key={`${sessionGeneration()}:${library}`}
            library={library} runID={run?.run_id ?? ""} generation={sessionGeneration()}
            selectedIDs={[...selection.ids]} enabled={serviceInfo?.planEnabled === true}
            selectedArticles={selection.records} savedSetEnabled={serviceInfo?.savedSetEnabled === true}
            pdfEnabled={serviceInfo?.pdfEnabled === true}
            scopeSignal={libraryPlanScope.current.signal} onPlanChange={retireChildView}
            admissionReady={selection.detailsReady && !draftChanged && !busy} openRequest={pdfPlan} onOpened={setConfirmedPdfPlan}
            onChild={id => { retireChildView(); void openBatch(id); }}
          />}

      </div>
      <div hidden={view !== 'library'}><section className="panel"><h2>Libraries</h2><p>Create a separate library for a different research collection.</p>
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
          <section className="capability">
            <strong>Batch, download and export</strong>
            <span>
              Search retrieves at most 100 identities per metadata page. Initial searches capture up to 1,000 identities; supported staged queries can explicitly capture more, up to the displayed limit. Each additional capture and metadata page requires an explicit request. Legacy runs keep their saved scope. Each batch processes up to 10 checked saved records, and a PDF plan contains at most 100. PDF acquisition requires the current server policy and a permitted repository original; unavailable records retain reasons and source links. Create batch acquires XML, while Download PDFs explicitly requests PDF. Server acquisition is separate from downloads to this device. No publisher account login is provided.
            </span>
          </section>

      </div>
      <footer><p>Use public research queries only. Do not enter patient information.</p><details><summary>Privacy, sources and service</summary>
        <p>PubMed queries and article identifiers are sent to NCBI. Public metadata does not establish full-text reuse permission. NCBI does not endorse this service; source records can contain errors and should be checked against the original publication.</p>
        {serviceInfo && <><p>Operator: {serviceInfo.operatorName}. Support: {serviceInfo.contact}.</p><p>Retention: {serviceInfo.retention}</p><p>Invited candidate access ends: {serviceInfo.expiresAt}.</p></>}
        {serviceInfo?.source && /^https:\/\/github\.com\/bestkakkoii\/LitraDock\/tree\/[0-9a-f]{40}$/.test(serviceInfo.source) && <p><a href={serviceInfo.source} target="_blank" rel="noopener noreferrer">Source code for this deployment</a></p>}
        <p>Use public research queries only; do not enter patient information. Account sessions, saved metadata and acquired originals remain in the server library until operator cleanup. Sign out on shared devices.</p>
      </details></footer>

    </main>
  );
}
const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<React.StrictMode><App /></React.StrictMode>);
