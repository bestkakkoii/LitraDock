import { useState } from "react";
import { Continuation } from "./api";
import { SearchController, SearchState } from "./controller";

export function ContinuationPanel({ status, state, controller, runID, visible, checked }: {
  status: Continuation | null; state: SearchState; controller: SearchController;
  runID?: string; visible: number; checked: number;
}) {
  const [cancel, setCancel] = useState(false);
  const blocked = state.busy || !!state.pending || !!state.confirmed || !!state.browserPending;
  return <section className="continuation" aria-label="Search continuation">
    <h3>Saved search progress</h3>
    {status ? <>
      <p role="status"><strong>{status.state.replaceAll("_", " ")}</strong>{status.reason && ` · ${status.reason}`}</p>
      <p>{status.providerTotal.toLocaleString()} provider matches · {status.windowCount.toLocaleString()} captured identities (window limit {status.windowLimit.toLocaleString()})</p>
      <p>{status.processedCount} processed · {status.savedCount} saved · {status.missingCount} missing · {visible} visible · {checked} checked</p>
      {status.execution === "user_browser" && <p>Source route: this browser · {status.credentialMode === "personal_key" ? "personal key required" : "without a key"}. Saved responses are client submitted; they are not independently source-attested.</p>}
      <div className="result-actions">
        {status.canStart && <button disabled={blocked} onClick={() => void controller.startBrowser(status.runID)}>Resume in this browser</button>}
        {status.canRecover && <button className="secondary" disabled={blocked} onClick={() => void controller.recoverBrowser(status)}>Check saved progress</button>}
        <button disabled={blocked || !status.canContinue} onClick={() => void controller.action(status, "continue")}>Retrieve next metadata page</button>
        <button className="secondary" disabled={blocked || !status.canRetry} onClick={() => void controller.action(status, "retry")}>Retry metadata page</button>
        <button className="secondary" disabled={blocked || !status.canCancel} onClick={() => setCancel(true)}>Cancel metadata page</button>
      </div>
      {cancel && status.canCancel && <div><p>Cancel this queued or running metadata page? Saved records remain available.</p>
        <button disabled={blocked} onClick={() => { setCancel(false); void controller.action(status, "cancel"); }}>Confirm metadata cancellation</button>
        <button className="secondary" onClick={() => setCancel(false)}>Keep metadata page</button></div>}
      <details><summary>Membership and retrieval limits</summary>
        <p>Each explicit request retrieves at most {status.pageSize} identities. Attempts for the current page: {status.attempts}/3. No next page or retry starts automatically.</p>
        <p>Membership captured: {status.snapshotAt ?? "not yet captured"}. This preserves identities, not a frozen copy of source metadata. The 1,000-identity operational window is not the full provider result set. Refine the query and start a separate search for different coverage; totals across runs are not additive.</p>
        <p>New saved records follow the saved all/none selection policy and individual exceptions. They do not change an existing basket or submitted download plan. Refreshing or reopening only reads saved status.</p>
      </details>
      {!!status.missingPMIDs?.length && <details><summary>Missing metadata identities ({status.missingPMIDs.length})</summary>
        <p>These identities were not saved as records. Check their source pages; a link does not guarantee available metadata or full text.</p>
        <ul>{status.missingPMIDs.map(id => <li key={id}><a href={`https://pubmed.ncbi.nlm.nih.gov/${id}/`} target="_blank" rel="noopener noreferrer">PMID {id}</a></li>)}</ul>
      </details>}
    </> : runID && <p>This saved run has no continuation window. Existing records and downloads remain available; it will not be backfilled automatically.</p>}
    {state.busy && <p role="status">Loading search status…</p>}
    {state.busy && state.browserRunID && <button className="secondary" onClick={() => void controller.cancelBrowser()}>Stop browser request</button>}
    {state.browserPending && <div><p>Saving this browser request is unconfirmed. Retry saving checks the existing application request without repeating the PubMed request. Keep this tab open to retain an unsaved response.</p>
      <button disabled={state.busy} onClick={() => void controller.reconcileBrowser()}>Retry saving results</button></div>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.notice && <p role="status">{state.notice}</p>}
    {state.pending && <div><p>Unconfirmed {state.pending.kind === "search" ? "search" : `${state.pending.body.action} for ${state.pending.runID}`}. The original request is retained; the edited query or selection cannot replace it.</p>
      <button disabled={state.busy} onClick={() => void controller.retry()}>Retry same search request</button></div>}
    {(state.confirmed || runID) && <button className="secondary" disabled={state.busy} onClick={() => void controller.read(state.confirmed ?? runID!)}>
      {state.confirmed ? `Reopen confirmed search ${state.confirmed}` : "Refresh saved search status"}
    </button>}
  </section>;
}
