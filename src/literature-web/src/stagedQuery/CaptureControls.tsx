import { Continuation } from "../continuation/api";
import { SearchController, SearchState } from "../continuation/controller";

export function CaptureControls({ status, state, controller, enabled, blocked = false }: {
  status: Continuation; state: SearchState; controller: SearchController; enabled: boolean; blocked?: boolean;
}) {
  const capture = status.capture;
  if (!capture) return null;
  const disabled = blocked || state.busy || !!state.pending || !!state.confirmed || !!state.browserPending;
  // 已儲存筆數會直接更新；完整成功來源說明保留於搜尋詳情，避免重複佔用首屏。
  // 其他通知（含未確認與復原狀態）及錯誤仍須直接顯示。
  const notice = state.notice === "Browser response saved. Source provenance is labelled as client submitted." ? "" : state.notice;
  return <div className="staged-actions" aria-label="Load more search results">
    <button className="secondary" disabled={disabled || !enabled || !capture.canCapture}
      onClick={() => void controller.action(status, "capture")}>Find more results</button>
    <button className="secondary" disabled={disabled || !status.canContinue}
      onClick={() => void controller.action(status, "continue")}>Load more results</button>
    <span className="small">{status.windowCount - status.processedCount} awaiting metadata
      {capture.state === "complete" ? " · ID coverage complete" : capture.state === "limited" ? " · Capture limit reached" : " · Partial ID coverage"}</span>
    {state.busy && <p role="status">Loading search results…</p>}
    {state.busy && state.browserRunID && <button className="secondary" onClick={() => void controller.cancelBrowser()}>Stop browser request</button>}
    {!state.busy && (state.error || notice) && <p role={state.error ? "alert" : "status"}>{state.error || notice}</p>}
    {state.pending && <button className="secondary" disabled={state.busy} onClick={() => void controller.retry()}>Retry same request</button>}
    {state.browserPending && <button className="secondary" disabled={state.busy} onClick={() => void controller.reconcileBrowser()}>Retry saving results</button>}
    {status.canStart && <button className="secondary" disabled={disabled} onClick={() => void controller.startBrowser(status.runID)}>Resume in this browser</button>}
    {status.canRecover && <button className="secondary" disabled={disabled} onClick={() => void controller.recoverBrowser(status)}>Check saved progress</button>}
    {!enabled && <p>Finding additional IDs is currently disabled. Saved results remain available.</p>}
  </div>;
}
