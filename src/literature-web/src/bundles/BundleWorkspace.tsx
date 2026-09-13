import { useLayoutEffect, useRef, useState } from "react";
import { ExportIdentity } from "../plans/exports";
import { BundleController, BundleState } from "./controller";
import "./bundles.css";

type Props = { library: string; runID: string; generation: number; plan: ExportIdentity; scopeSignal: AbortSignal; planSignal: AbortSignal };
const displayDate = (value: string) => `${new Date(value).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`;
function safeLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? value : null; } catch { return null; }
}
function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try { const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); }
  finally { URL.revokeObjectURL(url); }
}
export function BundleWorkspace(props: Props) {
  const controller = useRef<BundleController | null>(null);
  const [state, setState] = useState<BundleState | null>(null);
  useLayoutEffect(() => {
    const c = new BundleController(props.library, props.plan, props.generation, setState, save);
    controller.current = c; setState(c.state);
    const retire = () => { c.dispose(); setState(null); };
    props.scopeSignal.addEventListener("abort", retire); props.planSignal.addEventListener("abort", retire);
    if (props.scopeSignal.aborted || props.planSignal.aborted) retire(); else void c.initialize();
    return () => { c.dispose(); props.scopeSignal.removeEventListener("abort", retire); props.planSignal.removeEventListener("abort", retire); };
  }, [props.library, props.runID, props.generation, props.plan.planID, props.scopeSignal, props.planSignal]);
  const c = controller.current;
  if (!state || !c) return null;
  const d = state.document, busy = !!state.busy;
  return <section className="bundle-workspace" aria-label="Partitioned original downloads">
    <h4>Download in smaller parts</h4>
    <p>Prepare all {props.plan.selectedCount} saved plan members once, then save available originals in smaller ZIP files. Page and record checkboxes do not change this scope.</p>
    <div className="bundle-actions">
      <button disabled={busy || (!state.enabled && !state.pending)} onClick={() => void c.prepare()}>{state.pending ? "Retry same preparation request" : "Prepare download parts"}</button>
      <button className="secondary" disabled={busy} onClick={() => void c.refresh()}>Refresh snapshots</button>
    </div>
    {!state.enabled && <p className="muted">New preparation is unavailable. Existing snapshots can still be reopened and downloaded, subject to current rights.</p>}
    <label className="bundle-catalog">Saved download snapshots
      <select aria-label="Saved download snapshots" value={d?.snapshotID ?? ""} onChange={e => { if (e.target.value) void c.open(e.target.value); }}>
        <option value="">Choose a saved snapshot</option>
        {d && !state.list.some(s => s.snapshotID === d.snapshotID) && <option value={d.snapshotID}>{d.snapshotID}</option>}
        {state.list.map(s => <option key={s.snapshotID} value={s.snapshotID}>{displayDate(s.createdAt)} · {s.partCount} parts · {s.members} members · {s.snapshotID}</option>)}
      </select>
    </label>
    {state.error && <p role="alert" className="error">{state.error}</p>}
    {state.notice && <p role="status">{state.notice}</p>}
    {busy && <p role="status">{state.busy}</p>}
    {d && <>
      <p className="bundle-identity">Snapshot {d.snapshotID} · Expires {displayDate(d.expiresAt)}</p>
      <p>{d.manifest.counts.includedRecords} included records · {d.manifest.counts.unresolvedRecords} unresolved · {d.parts.length} available parts</p>
      <div className="bundle-actions">
        <button className="secondary" disabled={busy || !c.hasManifest} onClick={() => c.saveManifest()}>Save bundle manifest</button>
        <button className="secondary" onClick={() => void c.open(d.snapshotID)}>Reopen this snapshot</button>
      </div>
      {!!d.parts.length && <>
        <div className="bundle-actions">
          <button disabled={busy || !state.selected.length} onClick={() => void c.download(state.selected)}>Download selected parts</button>
          <button className="secondary" disabled={busy} onClick={() => c.select(d.parts.map(p => p.number))}>Select all parts</button>
          <button className="secondary" disabled={busy} onClick={() => c.select([])}>Deselect all parts</button>
          <span aria-live="polite">{state.selected.length} of {d.parts.length} parts selected</span>
        </div>
        <ul className="bundle-parts">{d.parts.map(part => {
          const p = state.progress[part.number], handed = state.handed.includes(part.number), active = state.activePart === part.number;
          return <li key={part.number}>
            <label><input type="checkbox" checked={state.selected.includes(part.number)} disabled={busy}
              onChange={e => c.select(e.target.checked ? [...state.selected, part.number] : state.selected.filter(n => n !== part.number))} />Part {part.number}</label>
            <p>{part.files.length} original {part.files.length === 1 ? "file" : "files"} · {part.bytes.toLocaleString()} ZIP bytes</p>
            {p && <p role="status">{p.received.toLocaleString()} / {p.total.toLocaleString()} bytes · {p.state === "verifying" ? "Verifying complete SHA256; not yet saved" : p.state === "ready" ? "Verified and handed to browser" : p.state === "paused" ? "Paused; not saved" : `${Math.floor(p.received / p.total * 100)}% transferred; not yet saved`}</p>}
            {p && <progress aria-label={`Part ${part.number} received bytes`} max={p.total} value={p.received} />}
            <div className="bundle-actions">
              <button className="secondary" disabled={busy} onClick={() => void c.download([part.number])}>{handed ? `Save part ${part.number} again` : p ? `Retry part ${part.number}` : `Save part ${part.number}`}</button>
              {active && <button className="secondary" onClick={() => c.cancel()}>Cancel part {part.number}</button>}
            </div>
          </li>;
        })}</ul>
      </>}
      {!d.parts.length && <p>No originals are available in this snapshot. Its complete metadata and unresolved reasons can still be saved.</p>}
      <details><summary>Unresolved records and source links ({d.manifest.counts.unresolvedRecords})</summary>
        <ul className="bundle-reasons">{d.manifest.items.filter(i => i.availability !== "included").map(item => {
          const record = d.manifest.research.records.find(r => r.searchId === item.searchId);
          return <li key={item.searchId}><p>{record?.publication?.title ?? item.searchId}</p><p>{item.searchId} · {item.availabilityReason || item.reason}</p>
            <div className="bundle-actions">{Object.entries(record?.sourceLinks ?? {}).map(([name, value]) => {
              const href = safeLink(value); return href ? <a key={name} href={href} target="_blank" rel="noopener noreferrer">{name}</a> : null;
            })}</div></li>;
        })}</ul>
      </details>
    </>}
    <details><summary>Transfer limits, cancellation and alternatives</summary>
      <p>Up to 100 members and 128 MiB of unique originals per snapshot; each part contains at most 8 MiB of originals and 17 MiB ZIP output. Metadata is limited to 8 MiB. Member count does not guarantee all originals fit.</p>
      <p>Only one part transfers at a time. Cancel or interruption retains the current part’s tentative bytes in this tab for explicit Retry. Starting another part, reopening, closing this tab, or changing plan, library or session discards them. No partial file is saved; complete SHA256 must match before handoff.</p>
      <p>Snapshots expire after 24 hours. Preparation records availability at that time; each part download rechecks current rights and original bytes. These actions never acquire new originals. Use the existing plan metadata, child batches or individual originals if a part is unavailable. Multiple downloads may require browser permission; Save again restarts a complete file from byte zero.</p>
    </details>
  </section>;
}
