import { useLayoutEffect, useRef, useState } from "react";
import { ExportContext, ExportScope, MetadataFormat } from "./api";
import { emptyExportState, StagedExportController } from "./controller";
import { countLabel } from "./capture";
import { transferLabel } from "../transfer";

function handoff(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  } finally { URL.revokeObjectURL(url); }
}
export function ExportPanel({ library, context, generation, signal, blocked = false, compact = false, onRefresh }: {
  library: string; context: ExportContext; generation: number; signal: AbortSignal; blocked?: boolean; compact?: boolean; onRefresh: () => void;
}) {
  const [scope, setScope] = useState<ExportScope>("selected"), [format, setFormat] = useState<MetadataFormat>("csv");
  const [limit, setLimit] = useState(1000), [state, setState] = useState(emptyExportState);
  const controller = useRef<StagedExportController | null>(null), previous = useRef("");
  useLayoutEffect(() => {
    const model = new StagedExportController(library, context, generation, signal, setState, handoff);
    controller.current = model;
    const identity = JSON.stringify([library, context.runID, context.selectionRevision, context.captureRevision, generation]);
    setState({ ...emptyExportState(), notice: previous.current && previous.current !== identity
      ? "Saved results or selection changed. New downloads start a new export scope." : "" });
    previous.current = identity;
    return () => { model.dispose(); if (controller.current === model) controller.current = null; };
  }, [library, context.runID, context.selectionRevision, context.captureRevision, generation, signal]);
  const count = scope === "selected" ? context.selectedIDs.length : context.savedCount;
  const disabled = blocked || state.busy;
  const primary = <button disabled={disabled || count === 0} onClick={() => void controller.current?.save(`zip-${format}`, scope, limit)}>
    Download {scope === "selected" ? "selected" : "all saved"} metadata ZIP</button>;
  return <section className={`staged-export${compact ? " compact-metadata-export" : ""}`} aria-label="Export saved metadata">
    {compact && primary}
    {state.busy && <div role="status">{state.progress ? `${transferLabel(state.progress)} · Not yet sent` : "Preparing metadata export…"}
      <button className="secondary" onClick={() => controller.current?.cancel()}>Cancel export</button></div>}
    {state.notice && <p role="status">{state.notice}</p>}
    {state.error && <div><p role="alert">{state.error}</p><button className="secondary" disabled={disabled} onClick={onRefresh}>Refresh progress and selection</button></div>}
    <details className="metadata-export-options" open={!compact}>
    <summary hidden={!compact}>Export options</summary>
    <div className="staged-export-options">
      <label>Scope <select aria-label="Metadata export scope" disabled={disabled} value={scope}
        onChange={e => { setScope(e.target.value as ExportScope); controller.current?.resetParts(); }}>
        <option value="selected">Selected ({context.selectedIDs.length.toLocaleString()})</option>
        <option value="all">All saved ({context.savedCount.toLocaleString()})</option>
      </select></label>
      <label>Format <select aria-label="Metadata export format" disabled={disabled} value={format}
        onChange={e => { setFormat(e.target.value as MetadataFormat); controller.current?.resetParts(); }}>
        {(["csv", "xlsx", "json", "jsonl"] as const).map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}
      </select></label>
      {!compact && primary}
    </div>
    <p className="small">{countLabel(count, "saved record")} · One ZIP contains the complete chosen metadata scope and a captured-ID manifest. PDFs are downloaded separately.</p>
    <details><summary>Individual export parts and captured IDs</summary>
      <p>Download individual parts if a complete ZIP exceeds the file or text limits. Each part keeps the same saved selection and captured membership; a changed scope requires a new export.</p>
      <div className="result-actions">
        <label>Records per part <select aria-label="Export part size" disabled={disabled} value={limit}
          onChange={e => { setLimit(Number(e.target.value)); controller.current?.resetParts(); }}>
          {[1, 10, 25, 100, 500, 1000].map(value => <option key={value} value={value}>{value.toLocaleString()}</option>)}
        </select></label>
        <button className="secondary" disabled={disabled || state.offset >= count}
          onClick={() => void controller.current?.save(format, scope, limit)}>{state.offset ? "Download next part" : "Download first part"}</button>
        <button className="secondary" disabled={disabled || state.offset === 0} onClick={() => controller.current?.resetParts()}>Start parts again</button>
      </div>
      <p>{state.offset < count ? `Next part: records ${state.offset + 1}–${Math.min(count, state.offset + limit)} of ${count}.` : count ? "All parts sent for this saved scope." : "No saved records in this scope."} {Math.max(0, count - state.offset)} remaining.</p>
      <button className="secondary" disabled={disabled} onClick={() => void controller.current?.save("manifest", "all", limit)}>Download captured-ID manifest</button>
      <p>All {context.capturedCount.toLocaleString()} captured IDs include saved, missing or pending metadata status and source links. Captured IDs do not guarantee available metadata or PDFs.</p>
      <p>Maximum ZIP: 64 MiB. Parts contain at most 1,000 metadata records. This export does not contact PubMed.</p>
    </details>
    </details>
  </section>;
}
