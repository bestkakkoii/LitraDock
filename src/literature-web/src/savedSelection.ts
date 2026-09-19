import { useLayoutEffect, useRef, useState } from "react";
import { type Article, type Run, type ServiceInfo, sessionGeneration } from "./api";
import { searchId } from "./selection";
import { type PendingSelection, RunSelectionController, type SelectionState } from "./runSelection";

export function useSavedSelection(library: string, run: Run | null, generation: number, scopeSignal: AbortSignal,
  visible: Article[] = [], capabilities: ServiceInfo | null = null, refreshVersion = 0) {
  const [state, setState] = useState<SelectionState>({ snapshot: null, pending: null, phase: "loading", error: "" });
  // Retain uncertain payloads across run/library navigation in this session. A
  // new account never inherits these requests. Reload reads durable server state.
  const journal = useRef({ generation, entries: new Map<string, PendingSelection>() });
  if (journal.current.generation !== generation) journal.current = { generation, entries: new Map() };
  const enabled = capabilities?.durableSelectionEnabled === true &&
    [1000, 20000].includes(capabilities.selectionRecordLimit ?? 0);
  const controller = useRef<RunSelectionController | null>(null);
  useLayoutEffect(() => {
    const key = JSON.stringify([library, run?.run_id]), entries = journal.current.entries;
    const model = library && run && enabled ? new RunSelectionController(library, run.run_id, generation, scopeSignal, setState,
      pending => { if (pending) entries.set(key, pending); else entries.delete(key); }, entries.get(key) ?? null) : null;
    controller.current = model;
    setState(model?.state ?? { snapshot: null, pending: null, phase: "error", error: "" });
    const stop = () => setState({ snapshot: null, pending: null, phase: "error", error: "" });
    scopeSignal.addEventListener("abort", stop);
    return () => { model?.dispose(); scopeSignal.removeEventListener("abort", stop); };
  }, [library, run?.run_id, generation, scopeSignal, enabled]);
  useLayoutEffect(() => { void controller.current?.load(); }, [library, run?.run_id, generation, scopeSignal, enabled, run?.fetched, run?.state, refreshVersion]);
  const current = !scopeSignal.aborted && generation === sessionGeneration();
  const snapshot = current ? state.snapshot : null;
  const ready = !!snapshot && current && state.phase === "ready";
  const canEdit = ready && snapshot.canEdit && capabilities?.selectionWriteEnabled === true;
  const ids = snapshot?.selectedIDs ?? [];
  const selected = new Set(ids);
  const setPage = (value: boolean) => {
    if (canEdit && visible.length) void controller.current?.apply({ action: "set", ids: visible.map(searchId), selected: value });
  };
  return {
    selected, ids, count: snapshot?.selectedCount ?? 0, total: snapshot?.savedCount ?? 0,
    records: snapshot?.selectedRecords ?? [], revision: snapshot?.revision,
    snapshot, pending: current ? state.pending : null, phase: state.phase,
    loading: !!run && state.phase === "loading", saving: state.phase === "saving",
    error: state.error, unavailable: !!run && !enabled,
    ready, canEdit, detailsReady: ready && snapshot.recordsComplete,
    reload: () => controller.current?.load(true), retry: () => controller.current?.retry(),
    selectAll: () => { if (canEdit) void controller.current?.apply({ action: "all" }); },
    deselectAll: () => { if (canEdit) void controller.current?.apply({ action: "none" }); },
    selectPage: () => setPage(true), deselectPage: () => setPage(false),
    toggle: (article: Article) => {
      const id = searchId(article);
      if (canEdit && visible.some(item => searchId(item) === id))
        void controller.current?.apply({ action: "set", ids: [id], selected: !selected.has(id) });
    },
  };
}
