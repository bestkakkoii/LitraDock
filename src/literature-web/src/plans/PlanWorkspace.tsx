import { useLayoutEffect, useRef, useState } from "react";
import { Article, sessionGeneration } from "../api";
import { addToBasket, associationCount, BasketMember } from "./basket";
import { SourceLinks } from "../components/ArticleCard";
import { Phase, PlanAction, phases } from "./api";
import { emptyPlanState, PlanController } from "./controller";
import { PlanExports } from "./PlanExports";

const labels: Record<Phase, string> = {
  waiting: "Waiting", queued: "Queued", running: "Running", completed: "Acquired on server",
  held: "Held", retry: "Retry needed", paused: "Paused", cancelled: "Cancelled",
};
type Props = {
  library: string; runID: string; generation: number; selectedIDs: string[];
  enabled: boolean; scopeSignal: AbortSignal;
  selectedArticles?: Article[]; savedSetEnabled?: boolean; pdfEnabled?: boolean;
  onPlanChange: () => void; onChild: (id: string) => void;
  admissionReady?: boolean; onOpened?: (id: string) => void; openRequest?: { id: string; sequence: number };
};

export function PlanWorkspace(props: Props) {
  const [state, setState] = useState(emptyPlanState);
  const [basket, setBasket] = useState<BasketMember[]>([]);
  const [basketError, setBasketError] = useState("");
  const [format, setFormat] = useState<"pdf" | "xml">("pdf");
  const controller = useRef<PlanController | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const exportScope = useRef(new AbortController());
  const retireExports = () => { exportScope.current.abort(); exportScope.current = new AbortController(); };
  useLayoutEffect(() => {
    retireExports();
    setBasket([]); setBasketError("");
    const model = new PlanController(props.library, props.runID, props.generation, setState);
    const stop = () => { exportScope.current.abort(); model.dispose(); setState(emptyPlanState()); setBasket([]); setBasketError(""); };
    controller.current = model;
    props.scopeSignal.addEventListener("abort", stop);
    if (!props.scopeSignal.aborted) void model.catalog();
    else stop();
    return () => { exportScope.current.abort(); props.scopeSignal.removeEventListener("abort", stop); model.dispose(); controller.current = null; };
  }, [props.library, props.generation, props.scopeSignal]);
  useLayoutEffect(() => {
    if (controller.current?.changeRun(props.runID)) { retireExports(); setConfirmCancel(false); }
  }, [props.runID]);
  useLayoutEffect(() => {
    const id = props.openRequest?.id;
    if (id && id !== controller.current?.state.page?.plan.planID) retireExports();
    if (id && !props.scopeSignal.aborted) void controller.current?.read(id).then(confirmed => {
      if (confirmed && !props.scopeSignal.aborted && props.generation === sessionGeneration()) props.onOpened?.(id);
    });
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
    if (id !== plan?.planID) retireExports();
    setConfirmCancel(false);
    void controller.current?.read(id);
  };
  return <section className="panel plan-workspace" aria-label="Processing plans">
    <h2>Processing plans</h2>
    <section className="saved-basket" aria-label="Saved-record basket">
      <h3>Combine saved searches</h3>
      <p>{basket.length} records in basket · {new Set(basket.flatMap(item => item.runIDs)).size} saved searches</p>
      <div className="plan-actions">
        <button className="secondary" disabled={!props.runID || props.admissionReady === false || !props.selectedIDs.length}
          onClick={() => {
            if (!current()) return;
            try { setBasket(addToBasket(basket, props.runID, props.selectedArticles ?? props.selectedIDs.map(SearchId => ({ SearchId })))); setBasketError(""); }
            catch (error) { setBasketError((error as Error).message); }
          }}>Add checked records to basket ({props.selectedIDs.length})</button>
        <button className="secondary" disabled={!basket.length} onClick={() => { setBasket([]); setBasketError(""); }}>Clear basket</button>
        <label>Requested originals <select aria-label="Basket original format" value={format} onChange={event => setFormat(event.target.value as "pdf" | "xml")}>
          <option value="pdf">PDF</option><option value="xml">XML</option>
        </select></label>
        <button disabled={!props.savedSetEnabled || (format === "pdf" && !props.pdfEnabled) || !basket.length || state.busy || !!state.pending}
          onClick={() => {
            if (!current()) return;
            props.onPlanChange(); retireExports(); setConfirmCancel(false);
            void controller.current?.createSavedSet(basket, format);
          }}>Download basket {format.toUpperCase()}s ({basket.length})</button>
      </div>
      {!props.savedSetEnabled && <p className="muted">New multi-search plans are unavailable. Existing saved plans remain accessible.</p>}
      {format === "pdf" && !props.pdfEnabled && <p className="muted">PDF acquisition is unavailable under the current source policy.</p>}
      {basketError && <p role="alert" className="error">{basketError}</p>}
      <details><summary>Basket records, search provenance and limits</summary>
        <p>Independent of checked records in the current search. Up to 100 unique saved records and 1,000 record/search associations; currently {associationCount(basket)} associations. Adding records does not acquire anything. Processing uses existing bounded groups and source budgets.</p>
        {basket.map(item => <article key={item.searchID} className="plan-item">
          <h4>{String(item.article.Title ?? item.searchID)}</h4><p>{item.searchID}</p>
          <p>Saved searches: {item.runIDs.join(", ")}</p>
          <button className="secondary" onClick={() => setBasket(previous => previous.filter(member => member.searchID !== item.searchID))}>Remove {item.searchID}</button>
        </article>)}
      </details>
    </section>
    {props.enabled ? <button
      disabled={props.admissionReady === false || state.busy || !!state.pending || !props.runID || props.selectedIDs.length < 1 || props.selectedIDs.length > 100}
      onClick={() => {
        if (!current()) return;
        props.onPlanChange();
        retireExports();
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
      <p>Unconfirmed {state.pending.kind === "create" ? `plan submission for ${"members" in state.pending.body ? state.pending.body.members.length : state.pending.body.searchIDs.length} records (${state.pending.body.format ?? "xml"})` : `${state.pending.body.value} request`}. Retry sends the same request; it does not create a replacement.</p>
      <button onClick={() => { if (current()) void controller.current?.retrySubmission(); }}>Retry same submission</button>
    </div>}
    {page && plan && <>
      <h3>Plan {plan.planID}</h3>
      <p>{plan.state} · {plan.selectedCount} saved records · Requested {(plan.requestedFormat ?? "xml").toUpperCase()}</p>
      <details><summary>Saved search scope and processing details</summary>
      <p>{plan.scopeKind === "saved_set" ? `Saved searches: ${plan.sourceRunIDs?.join(", ")}` : `Run ${plan.runID}`}</p>
      <p className="muted">Last confirmed server update: {plan.updatedAt}</p>
      <p>Processing uses groups of at most 10. Closing or reopening this plan does not admit or retry work.</p>
      </details>
      <p>{plan.admission.admittedCount} admitted to child batches · {plan.admission.waitingCount} awaiting admission (including paused records)</p>
      {plan.admission.reason && <p>{plan.admission.reason}{plan.admission.retryAfter ? ` · Check after ${plan.admission.retryAfter}` : ""}</p>}
      <dl className="plan-counts" aria-label="Plan progress counts">
        {phases.map(phase => <div key={phase}><dt>{labels[phase]}</dt><dd>{plan.counts[phase]}</dd></div>)}
      </dl>
      <p>{plan.retryEligibleCount} eligible for explicit retry. Each retry action processes only the next eligible child group, up to 10 items. {page.items.filter(item => item.downloadAvailable).length} of {page.items.length} items on this page currently available to save.</p>
      <p className="muted">Acquired means stored on the server. Current rights or integrity checks may prevent saving a previously acquired original.</p>
      <PlanExports key={`${props.generation}:${props.library}:${plan.scopeKind === "saved_set" ? "saved_set" : props.runID}:${plan.planID}`}
        library={props.library} runID={plan.scopeKind === "saved_set" ? "" : props.runID} generation={props.generation} plan={plan}
        scopeSignal={props.scopeSignal} planSignal={exportScope.current.signal} />
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
        {item.runIDs && <details><summary>Record search provenance</summary><p>{item.runIDs.join(", ")}</p></details>}
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
    </>}
  </section>;
}
