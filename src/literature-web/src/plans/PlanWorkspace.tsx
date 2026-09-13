import { useLayoutEffect, useRef, useState } from "react";
import { sessionGeneration } from "../api";
import { SourceLinks } from "../components/ArticleCard";
import { Phase, PlanAction, phases } from "./api";
import { emptyPlanState, PlanController } from "./controller";

const labels: Record<Phase, string> = {
  waiting: "Waiting", queued: "Queued", running: "Running", completed: "Acquired on server",
  held: "Held", retry: "Retry needed", paused: "Paused", cancelled: "Cancelled",
};
type Props = {
  library: string; runID: string; generation: number; selectedIDs: string[];
  enabled: boolean; scopeSignal: AbortSignal;
  onPlanChange: () => void; onChild: (id: string) => void;
  admissionReady?: boolean; openRequest?: { id: string; sequence: number };
};

export function PlanWorkspace(props: Props) {
  const [state, setState] = useState(emptyPlanState);
  const controller = useRef<PlanController | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const model = new PlanController(props.library, props.runID, props.generation, setState);
    const stop = () => { model.dispose(); setState(emptyPlanState()); };
    controller.current = model;
    props.scopeSignal.addEventListener("abort", stop);
    if (!props.scopeSignal.aborted) void model.catalog();
    else stop();
    return () => { props.scopeSignal.removeEventListener("abort", stop); model.dispose(); controller.current = null; };
  }, [props.library, props.runID, props.generation, props.scopeSignal]);
  useLayoutEffect(() => {
    if (props.openRequest && !props.scopeSignal.aborted) void controller.current?.read(props.openRequest.id);
  }, [props.openRequest]);
  useLayoutEffect(() => { if (confirmCancel) cancelButton.current?.focus(); }, [confirmCancel]);
  const current = () => props.generation === sessionGeneration() && !props.scopeSignal.aborted;
  const page = state.page;
  const plan = page?.plan;
  const act = (action: PlanAction) => {
    if (!current()) return;
    if (action === "cancel") { setConfirmCancel(true); return; }
    void controller.current?.control(action);
  };
  const open = (id: string) => {
    if (!id || !current()) return;
    props.onPlanChange();
    setConfirmCancel(false);
    void controller.current?.read(id);
  };
  return <section className="panel plan-workspace" aria-label="Processing plans">
    <h2>Processing plans</h2>
    <p>Process up to 100 selected saved records in groups of at most 10. Plans remain in your library when you close this page.</p>
    {props.enabled ? <button
      disabled={props.admissionReady === false || state.busy || !!state.pending || !props.runID || props.selectedIDs.length < 1 || props.selectedIDs.length > 100}
      onClick={() => {
        if (!current()) return;
        props.onPlanChange();
        setConfirmCancel(false);
        void controller.current?.create(props.selectedIDs);
      }}>Create processing plan ({props.selectedIDs.length}/100)</button>
      : <p className="muted">New plans are disabled by the server. Saved plans can still be opened and controlled as permitted.</p>}
    <label className="plan-catalog">Saved plans
      <select value={plan?.planID ?? ""} onChange={event => open(event.target.value)} aria-label="Saved plans">
        <option value="">Choose a saved plan</option>
        {state.catalog.plans.map(item => <option key={item.planID} value={item.planID}>{item.planID} · {item.state} · {item.selectedCount} selected</option>)}
      </select>
    </label>
    <div className="pager">
      <button className="secondary" disabled={state.busy || state.catalog.offset === 0} onClick={() => void controller.current?.catalog(Math.max(0, state.catalog.offset - 25))}>Previous plans</button>
      <span>{state.catalog.total} saved plans</span>
      <button className="secondary" disabled={state.busy || state.catalog.plans.length === 0 || state.catalog.offset + state.catalog.plans.length >= state.catalog.total} onClick={() => void controller.current?.catalog(state.catalog.offset + 25)}>Next plans</button>
      <button className="secondary" disabled={state.busy} onClick={() => void controller.current?.catalog(state.catalog.offset)}>Refresh saved plans</button>
    </div>
    {state.busy && <p role="status">Updating plan status…</p>}
    {state.error && <p role="alert" className="error">{state.error}</p>}
    {state.notice && <p role="status">{state.notice}</p>}
    {state.pending && !state.busy && <div className="plan-pending">
      <p>Unconfirmed {state.pending.kind === "create" ? `plan submission for ${state.pending.body.searchIDs.length} records` : `${state.pending.body.value} request`}. Retry sends the same request; it does not create a replacement.</p>
      <button onClick={() => { if (current()) void controller.current?.retrySubmission(); }}>Retry same submission</button>
    </div>}
    {page && plan && <>
      <h3>Plan {plan.planID}</h3>
      <p>{plan.state} · {plan.selectedCount} selected saved records · Requested {(plan.requestedFormat ?? "xml").toUpperCase()} · Run {plan.runID}</p>
      <p className="muted">Last confirmed server update: {plan.updatedAt}</p>
      <p>{plan.admission.admittedCount} admitted to child batches · {plan.admission.waitingCount} awaiting admission (including paused records)</p>
      {plan.admission.reason && <p>{plan.admission.reason}{plan.admission.retryAfter ? ` · Check after ${plan.admission.retryAfter}` : ""}</p>}
      <dl className="plan-counts" aria-label="Plan progress counts">
        {phases.map(phase => <div key={phase}><dt>{labels[phase]}</dt><dd>{plan.counts[phase]}</dd></div>)}
      </dl>
      <p>{plan.retryEligibleCount} eligible for explicit retry. Each retry action processes only the next eligible child group, up to 10 items. {page.items.filter(item => item.downloadAvailable).length} of {page.items.length} items on this page currently available to save.</p>
      <p className="muted">Acquired means stored on the server. Current rights or integrity checks may prevent saving a previously acquired original.</p>
      <div className="plan-actions">
        {(["pause", "resume", "retry", "cancel"] as const).map(action => <button key={action} className="secondary"
          disabled={state.busy || !!state.pending || !plan.allowedActions.includes(action) || (!props.enabled && (action === "resume" || action === "retry"))}
          onClick={() => act(action)}>{({pause: "Pause plan", resume: "Resume plan", retry: "Retry next eligible group", cancel: "Cancel plan"})[action]}</button>)}
        <button className="secondary" disabled={state.busy} onClick={() => { if (current()) void controller.current?.read(plan.planID, page.offset); }}>Refresh plan</button>
      </div>
      {confirmCancel && <div role="alertdialog" aria-modal="false" aria-label="Confirm plan cancellation" className="plan-confirm" onKeyDown={event => { if (event.key === "Escape") setConfirmCancel(false); }}>
        <p>Cancel unfinished work in plan {plan.planID}? Acquired originals and prior outcomes are preserved. A cancelled plan cannot resume.</p>
        <button ref={cancelButton} disabled={state.busy || !plan.allowedActions.includes("cancel")} onClick={() => {
          if (!current()) return;
          setConfirmCancel(false);
          void controller.current?.control("cancel");
        }}>Confirm cancellation</button>
        <button className="secondary" onClick={() => setConfirmCancel(false)}>Keep plan</button>
      </div>}
      {state.pollingStopped && <p role="status">Automatic refresh stopped after 120 reads. Server work can continue; use Refresh plan to check again.</p>}
      {page.items.map(item => <article key={item.searchID} className="plan-item">
        <h4>{String(item.article.Title ?? item.searchID)}</h4>
        <p>{labels[item.phase]} · {item.searchID} · Attempts {item.attempts}{item.retryEligible ? " · Eligible for retry" : ""}</p>
        <p>{item.reason}</p>
        <p className="muted">PMID {String(item.article.Pmid ?? "—")} · PMCID {String(item.article.Pmcid ?? "—")} · DOI {String(item.article.Doi ?? "—")}</p>
        <SourceLinks article={item.article} />
        <p>{item.downloadAvailable ? `${item.format} available to save · ${item.bytes} bytes · SHA-256 ${item.original_hash}` : "Original currently unavailable to save; use the source links for details."}</p>
        {item.childBatchID && <button className="secondary" onClick={() => {
          if (current()) props.onChild(item.childBatchID!);
        }}>Open child batch {item.childBatchID}</button>}
      </article>)}
      <div className="pager">
        <button className="secondary" disabled={state.busy || page.offset === 0} onClick={() => void controller.current?.read(plan.planID, Math.max(0, page.offset - page.limit))}>Previous plan items</button>
        <span>{page.total ? page.offset + 1 : 0}–{page.offset + page.items.length} of {page.total} selected records</span>
        <button className="secondary" disabled={state.busy || page.items.length === 0 || page.offset + page.items.length >= page.total} onClick={() => void controller.current?.read(plan.planID, page.offset + page.limit)}>Next plan items</button>
      </div>
      <p className="muted">Plan-wide export is unavailable. Open a child batch to save its available PDF or XML originals and ZIP, or export XLSX/CSV. No publisher account login is provided.</p>
    </>}
  </section>;
}
