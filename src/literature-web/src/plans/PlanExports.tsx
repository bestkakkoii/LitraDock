import { useLayoutEffect, useRef, useState } from "react";
import { sessionGeneration } from "../api";
import { exportFailure, exportPlan, ExportIdentity, PlanExportFormat } from "./exports";
import { TransferProgress, transferLabel } from "../transfer";

type Props = { library: string; runID: string; generation: number; plan: ExportIdentity;
  scopeSignal: AbortSignal; planSignal: AbortSignal };

export function PlanExports(props: Props) {
  const abort = useRef(new AbortController());
  const operation = useRef(0);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<PlanExportFormat | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController(); abort.current = controller;
    inFlight.current = false; setBusy(null); setError(""); setNotice("");
    const retire = () => { abort.current.abort(); operation.current++; inFlight.current = false; setBusy(null); setError(""); setNotice(""); };
    props.scopeSignal.addEventListener("abort", retire); props.planSignal.addEventListener("abort", retire);
    if (props.scopeSignal.aborted || props.planSignal.aborted) retire();
    return () => {
      abort.current.abort(); operation.current++;
      props.scopeSignal.removeEventListener("abort", retire); props.planSignal.removeEventListener("abort", retire);
    };
  }, [props.library, props.runID, props.generation, props.plan.planID, props.scopeSignal, props.planSignal]);
  const save = async (format: PlanExportFormat) => {
    if (inFlight.current) return;
    const signal = abort.current.signal, id = ++operation.current;
    const current = () => !signal.aborted && !props.scopeSignal.aborted && !props.planSignal.aborted && id === operation.current && props.generation === sessionGeneration();
    if (!current()) return;
    inFlight.current = true;
    setBusy(format); setError(""); setNotice("");
    try {
      setProgress(null);
      const { blob, filename } = await exportPlan(props.library, props.plan, format, props.generation, signal,
        { onProgress: value => { if (current()) setProgress(value); } });
      if (!current()) return;
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
      } finally { URL.revokeObjectURL(url); }
      setNotice(format === "json" ? "Metadata sent to your browser. Original availability was not revalidated."
        : "ZIP sent to your browser. Its manifest reports actual included and unresolved records separately; historical acquisition counts are not download counts.");
    } catch (failure) { if (current()) setError(exportFailure(failure)); }
    finally { if (current()) { inFlight.current = false; setBusy(null); } }
  };
  return <section className="plan-exports" aria-label="Saved plan exports">
    <h4>Export the saved plan</h4>
    <p id="plan-export-scope">Both exports cover all {props.plan.selectedCount} saved plan members, independent of checkboxes and page. Opening or refreshing a plan does not export or acquire anything.</p>
    <div className="plan-actions">
      <button className="secondary" disabled={!!busy} aria-describedby="plan-export-scope plan-export-limits" onClick={() => void save("zip")}>Save plan originals ZIP</button>
      <button className="secondary" disabled={!!busy} aria-describedby="plan-export-scope" onClick={() => void save("json")}>Export plan metadata JSON</button>
    </div>
    {busy && <p role="status">{progress ? `${transferLabel(progress)} · Not yet saved` : `Preparing plan ${busy === "zip" ? "originals ZIP" : "metadata JSON"}…`}</p>}
    {busy && <button className="secondary" onClick={() => { abort.current.abort(); operation.current++; inFlight.current = false; setBusy(null); setNotice("Transfer cancelled. No file was saved."); abort.current = new AbortController(); }}>Cancel transfer</button>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <details><summary>Export scope, limits and alternatives</summary>
    <p id="plan-export-limits" className="muted">Up to 100 saved members; at most 32 MiB of unique originals and 37 MiB ZIP output. Selecting 100 papers does not mean their files fit. Metadata JSON is limited to 8 MiB.</p>
    <p className="muted">ZIP contains available requested-format originals, records.json and manifest.json with included/unresolved counts and reasons. Missing or restricted originals remain documented, not replaced. Metadata JSON preserves historical outcomes and source links without rechecking original availability.</p>
    <p className="muted">For smaller downloads or unavailable originals, use the child-batch buttons and source links below. Child batches retain individual Save, ZIP and CSV/XLSX exports. No publisher login or generated replacement PDF is provided.</p>
    </details>
  </section>;
}
