import { useLayoutEffect, useRef, useState } from "react";
import { sessionGeneration } from "../api";
import { definitiveAdmissionError, PdfRequest } from "../pdfRequest";

type Props = {
  selectedCount: number; ids?: string[]; ready?: boolean; enabled?: boolean; plansEnabled?: boolean;
  library?: string; runID?: string; generation?: number; scopeSignal?: AbortSignal; policy?: string; confirmedPlanID?: string;
  onBatch?: (id: string) => Promise<void>; onPlan?: (id: string) => void; onStart?: () => void;
};
export function PdfAvailability(props: Props) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [pending, setPending] = useState<PdfRequest | null>(null);
  const abort = useRef(new AbortController());
  useLayoutEffect(() => {
    const controller = new AbortController(); abort.current = controller;
    setBusy(false); setPending(null); setMessage("");
    const stop = () => { controller.abort(); setBusy(false); setPending(null); setMessage(""); };
    props.scopeSignal?.addEventListener("abort", stop);
    if (props.scopeSignal?.aborted) stop();
    return () => { controller.abort(); props.scopeSignal?.removeEventListener("abort", stop); };
  }, [props.library, props.runID, props.generation, props.scopeSignal]);
  useLayoutEffect(() => {
    if (pending?.kind === "plan" && pending.confirmedID === props.confirmedPlanID) setPending(null);
  }, [pending, props.confirmedPlanID]);
  const submit = async () => {
    if (busy || !props.enabled || !props.ready || !props.library || !props.runID) return;
    const signal = abort.current.signal, generation = props.generation;
    const current = () => !signal.aborted && generation === sessionGeneration();
    if (!current()) return;
    setBusy(true); setMessage("");
    let admitted = false;
    try {
      const request = pending ?? new PdfRequest(props.library, props.runID, props.ids ?? [], generation!, props.plansEnabled === true);
      setPending(request);
      props.onStart?.();
      const id = await request.send(signal);
      admitted = true;
      if (!current()) return;
      if (request.kind === "batch") await props.onBatch?.(id);
      else props.onPlan?.(id);
      if (!current()) return;
      if (request.kind === "batch") setPending(null);
      setMessage(`PDF ${request.kind} saved for ${request.body.searchIDs.length} records. Follow its status below; acquisition on the server is not a device download.`);
    } catch (error) {
      if (!current()) return;
      // A confirmed POST survives every subsequent detail error; reopening stays GET-only.
      if (!admitted && definitiveAdmissionError(error)) {
        setPending(null); setMessage(`${(error as Error).message} Reopen saved work to check its current status before another action.`);
      } else setMessage(admitted ? "The PDF request is saved, but its details could not be opened. Retry opening the saved work; no new acquisition will be submitted." : "The response or detail was not confirmed. Retry the same PDF request; its saved identifiers and format will not change.");
    } finally { if (current()) setBusy(false); }
  };
  const disabled = busy || !props.enabled || !props.ready || (!pending &&
    (props.selectedCount < 1 || props.selectedCount > 100 || (props.selectedCount > 10 && !props.plansEnabled)));
  return <section className="pdf-availability" aria-label="PDF downloads">
    <div>
      <h3>Download PDFs</h3>
      {props.enabled ? <p>Acquire permitted repository PDFs for the selected saved records. Up to 10 records creates one batch; 11–100 creates one processing plan. Then use Save PDF or Save PDF ZIP to download available files to this device.</p>
        : <p>PDF acquisition is currently unavailable under the server policy. Existing saved originals remain available as permitted.</p>}
      {props.policy && <p className="muted small">{props.policy}</p>}
      <p className="muted small">Some records may be held with source links and reasons. No publisher account login is provided. XML and ZIP are not PDFs; a PDF ZIP contains available PDFs and a manifest of all outcomes.</p>
    </div>
    <button disabled={disabled} onClick={() => void submit()}>{busy ? "Submitting PDF request…" : pending ? `${pending.confirmedID ? "Reopen saved PDF request" : "Retry same PDF request"} (${pending.body.searchIDs.length})` : `Download PDFs (${props.selectedCount} selected)`}</button>
    {!props.plansEnabled && props.selectedCount > 10 && <p>Plans are disabled. Select up to 10 saved records for a PDF batch.</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
