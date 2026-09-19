import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, sessionGeneration } from "../api";
import { definitiveAdmissionError, PdfRequest } from "../pdfRequest";
import { handoffPdf, pdfFile, pdfOutcomes, PdfStatus, readPdfStatus, waitForPdf } from "../pdfDownload";
import { transferLabel } from "../transfer";
import { SourceOutcomeView } from "./SourceOutcome";
import { SourceLinks } from "./ArticleCard";

type Props = {
  selectedCount: number; ids?: string[]; ready?: boolean; enabled?: boolean; plansEnabled?: boolean;
  library?: string; runID?: string; generation?: number; scopeSignal?: AbortSignal; policy?: string; confirmedPlanID?: string;
  onBatch?: (id: string) => Promise<void>; onPlan?: (id: string) => void; onStart?: () => void;
  onStatus?: (value: { library: string; runID: string; message: string }) => void;
};
export function PdfAvailability(props: Props) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [pending, setPending] = useState<PdfRequest | null>(null), [status, setStatus] = useState<PdfStatus>();
  const [sent, setSent] = useState(false), [error, setError] = useState(false);
  const scope = useRef(new AbortController()), attempt = useRef<AbortController | null>(null), locked = useRef(false);
  useLayoutEffect(() => {
    const controller = new AbortController(); scope.current = controller;
    const stop = () => { controller.abort(); attempt.current?.abort(); locked.current = false; setBusy(false); setPending(null); setStatus(undefined); setMessage(""); setSent(false); setError(false); };
    setBusy(false); setPending(null); setStatus(undefined); setMessage(""); setSent(false); setError(false); locked.current = false;
    props.scopeSignal?.addEventListener("abort", stop);
    if (props.scopeSignal?.aborted) stop();
    return () => { controller.abort(); attempt.current?.abort(); props.scopeSignal?.removeEventListener("abort", stop); };
  }, [props.library, props.runID, props.generation, props.scopeSignal]);
  // Publish message changes only; a scope change must not relabel an old message
  // with the new run before the layout effect has cleared it.
  useEffect(() => {
    props.onStatus?.({ library: props.library ?? "", runID: props.runID ?? "", message });
  }, [message, props.onStatus]);

  // Only a deliberate click enters this function: no polling effect, reload or
  // re-render can start an acquisition or repeat a browser file handoff.
  const submit = async (action: "download" | "outcomes" | "details" = "download", itemID?: string, fresh = false) => {
    if (locked.current || scope.current.signal.aborted || props.generation !== sessionGeneration()) return;
    if ((!pending || fresh) && (!props.enabled || !props.ready || !props.library || !props.runID)) return;
    const controller = new AbortController(), parent = scope.current.signal;
    attempt.current = controller; const signal = controller.signal;
    const stop = () => controller.abort(); parent.addEventListener("abort", stop, { once: true });
    const current = () => !signal.aborted && !parent.aborted && props.generation === sessionGeneration();
    locked.current = true; setBusy(true); setError(false);
    let intent = fresh ? null : pending;
    try {
      if (!intent) {
        intent = new PdfRequest(props.library!, props.runID!, props.ids ?? [], props.generation!, props.plansEnabled === true);
        setPending(intent); setStatus(undefined); setSent(false); props.onStart?.();
      }
      setMessage(`Preparing PDFs for ${intent.body.searchIDs.length} selected ${intent.body.searchIDs.length === 1 ? "record" : "records"}…`);
      await intent.send(signal);
      if (!current()) return;
      if (action === "details") {
        if (intent.kind === "batch") await props.onBatch?.(intent.confirmedID!); else props.onPlan?.(intent.confirmedID!);
        if (current()) setMessage("Saved download details opened. Return to Search & PDFs for this request's progress and save actions.");
        return;
      }
      let progress = await readPdfStatus(intent, signal);
      if (!current()) return;
      setStatus(progress);
      if (action === "download" && !itemID) {
        for (let poll = 0; progress.pending > 0; poll++) {
          setMessage(`Preparing PDFs: ${progress.ready} ready · ${progress.pending} pending · ${progress.unresolved} without an available PDF.`);
          if (poll >= 89) { setMessage("Still processing. Choose Continue checking when you are ready; your saved request will be reused."); return; }
          await waitForPdf(signal); progress = await readPdfStatus(intent, signal);
          if (!current()) return;
          setStatus(progress);
        }
        if (!progress.ready) { setMessage("No PDF is available for this selection. Review the reasons and source links here, or export these source outcomes."); return; }
      }
      setMessage(action === "outcomes" ? "Preparing source outcomes…" : "Preparing the file download…");
      const file = action === "outcomes" ? await pdfOutcomes(intent, progress, signal) : await pdfFile(intent, progress, signal,
        { onProgress: value => { if (current()) setMessage(`${transferLabel(value)} · Preparing the file download…`); } }, itemID);
      if (!current()) return;
      if ("status" in file) {
        setStatus(file.status);
        if (!file.blob) {
          setSent(false);
          setMessage("No PDF remained available when the package was prepared. No file was downloaded. Review the current reasons and source links here, or export these source outcomes.");
          return;
        }
      }
      handoffPdf({ blob: file.blob!, filename: file.filename }, intent, signal);
      setSent(action === "download");
      setMessage(action === "outcomes" ? "Source outcomes sent to your browser." : "Download sent to your browser. If no file appeared, choose Save again. Unresolved records are listed here and included in multi-record ZIP manifests.");
    } catch (failure) {
      if (!current()) return;
      setError(true);
      if (!intent?.confirmedID && definitiveAdmissionError(failure)) {
        setPending(null); setMessage("This PDF request was not accepted. Refresh the selection or open saved downloads to check its status.");
      } else if (!intent?.confirmedID) setMessage("The response was interrupted. Retry the same request to confirm it; no new selection will be submitted.");
      else if (failure instanceof ApiError && [409, 429].includes(failure.status)) setMessage(failure.status === 429
        ? "File preparation is busy. Wait, then try again explicitly, or export source outcomes."
        : "This file could not be prepared within the download limits. Save individual PDFs in File and source details, or export source outcomes.");
      else setMessage(`${failure instanceof Error ? failure.message : "Download unavailable."} Try again to continue the same saved request.`);
    } finally {
      parent.removeEventListener("abort", stop);
      if (current()) { locked.current = false; setBusy(false); }
    }
  };
  const stopWaiting = () => {
    attempt.current?.abort(); locked.current = false; setBusy(false); setError(false);
    setMessage("Checking stopped on this page. Saved processing may continue. Continue checking to recover this same request; use saved details to pause or cancel processing.");
  };
  const validSelection = props.selectedCount >= 1 && props.selectedCount <= 100 && (props.selectedCount <= 10 || props.plansEnabled);
  const changedSelection = pending && (pending.body.searchIDs.length !== props.ids?.length || pending.body.searchIDs.some(id => !props.ids?.includes(id)));
  return <section className="pdf-availability" aria-label="PDF downloads">
    <h3 className="sr-only">Download PDFs</h3>
    {!props.enabled && <p>PDF acquisition is currently unavailable under the server policy. Existing saved originals remain available as permitted.</p>}
    <button disabled={busy || (!pending && (!props.enabled || !props.ready || !validSelection))} onClick={() => void submit()}>
      {busy ? "Preparing PDFs…" : pending ? sent ? "Save again" : pending.confirmedID ? status?.pending || !status ? "Continue checking" : "Check and download again" : "Retry same PDF request" : `Download PDFs (${props.selectedCount} selected)`}
    </button>
    {busy && <button className="secondary" onClick={stopWaiting}>Stop waiting</button>}
    <p className="pdf-scope">{pending ? `${pending.body.searchIDs.length} ${pending.body.searchIDs.length === 1 ? "record" : "records"} in this download` : `${props.selectedCount} selected saved ${props.selectedCount === 1 ? "record" : "records"}`}. Available originals: PDF or ZIP.</p>
    <div className="pdf-progress" aria-live="polite" aria-atomic="true">
      {message && <p role={error ? "alert" : "status"}>{message}</p>}
      {status && <p><strong>{status.ready} ready · {status.pending} pending · {status.unresolved} without an available PDF</strong> · {status.items.length} selected</p>}
    </div>
    {status && <button className="secondary" disabled={busy} onClick={() => void submit("outcomes")}>Export source outcomes</button>}
    {changedSelection && <button className="secondary" disabled={busy || !props.ready || !props.enabled || !validSelection} onClick={() => void submit("download", undefined, true)}>Download current selection ({props.selectedCount})</button>}
    {status && <details open={status.ready === 0 && status.pending === 0} className="pdf-results"><summary>File and source details ({status.items.length} {status.items.length === 1 ? "record" : "records"})</summary>
      <div className="pdf-result-list">{status.items.map(item => <article key={item.id}>
        <h4>{String(item.article.Title ?? item.id)}</h4>
        <SourceOutcomeView outcome={item.outcome} />
        {!item.outcome && <p>{item.ready ? "Original PDF available" : item.pending ? "Processing" : item.reason || "No original PDF is available. Open the source links for access options."}</p>}
        <SourceLinks article={item.article} />
        {item.ready && <button disabled={busy} onClick={() => void submit("download", item.id)}>Save this PDF</button>}
      </article>)}</div>
    </details>}
    <details><summary>Sources and download details</summary>
      <p>Choose up to {props.plansEnabled ? "100" : "10"} saved records. Only originals permitted by the source policy are acquired. No publisher account login is provided. A ZIP contains available PDFs and an outcome manifest; XML and ZIP are not PDFs.</p>
      {props.policy && <p className="muted small">{props.policy}</p>}
      <p>Files remain subject to source rights and current availability. Stopping this page's checks does not cancel already saved processing. ZIPs are limited to 32 MiB of unique originals; larger selections can use individual PDF saves.</p>
      {pending?.confirmedID && <button className="secondary" disabled={busy} onClick={() => void submit("details")}>Open saved download details</button>}
    </details>
  </section>;
}
