import { api, ApiError, RunPage, sessionGeneration } from "../api";
import { Action, ActionIntent, Continuation, SearchIntent, submitAction, submitSearch } from "./api";

type Pending = { kind: "search"; body: SearchIntent } | { kind: "continuation"; runID: string; body: ActionIntent };
export type SearchState = { busy: boolean; pending: Pending | null; confirmed: string | null; error: string; notice: string };
export const emptySearchState = (): SearchState => ({ busy: false, pending: null, confirmed: null, error: "", notice: "" });

// One library/session owner; each read or mutation also owns an abortable operation.
// Navigation may retire publication, but cannot replace an uncertain admission.
export class SearchController {
  state = emptySearchState();
  private sequence = 0;
  private abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private reads = 0;
  private stop = () => this.navigate();
  constructor(readonly library: string, readonly generation: number, private publish: (value: SearchState) => void,
    private page: (value: RunPage) => void, private scope: AbortSignal) { scope.addEventListener("abort", this.stop); }
  private live = () => !this.disposed && !this.scope.aborted && this.generation === sessionGeneration();
  private set(value: Partial<SearchState>) { if (this.live()) { this.state = { ...this.state, ...value }; this.publish(this.state); } }
  navigate() {
    this.sequence++; this.abort.abort(); clearTimeout(this.timer);
    this.set({ busy: false, error: "", notice: "" });
  }
  dispose() { this.navigate(); this.disposed = true; this.scope.removeEventListener("abort", this.stop); }
  private begin() {
    this.navigate(); this.abort = new AbortController();
    const operation = this.sequence, signal = this.abort.signal;
    this.set({ busy: true });
    return { signal, current: () => this.live() && !signal.aborted && operation === this.sequence };
  }
  async search(query: string, limit: number) {
    if (!this.live() || this.state.busy || this.state.pending || this.state.confirmed) return;
    this.set({ pending: { kind: "search", body: { query, limit, requestID: crypto.randomUUID() } } });
    await this.retry();
  }
  async action(status: Continuation, action: Action) {
    if (!this.live() || this.state.busy || this.state.pending || this.state.confirmed ||
      !(action === "continue" ? status.canContinue : action === "retry" ? status.canRetry : status.canCancel)) return;
    this.set({ pending: { kind: "continuation", runID: status.runID, body: { requestID: crypto.randomUUID(), revision: status.revision, action } } });
    await this.retry();
  }
  async retry() {
    const pending = this.state.pending;
    if (!pending || this.state.busy || !this.live()) return;
    const task = this.begin();
    let confirmed = false;
    try {
      const id = pending.kind === "search" ? await submitSearch(this.library, pending.body, this.generation, task.signal)
        : await submitAction(this.library, pending.runID, pending.body, this.generation, task.signal);
      if (!task.current()) return;
      confirmed = true;
      this.set({ pending: null, confirmed: id, notice: "Request confirmed. Loading saved status." });
      await this.read(id); // read owns the next operation; its errors never become a POST retry.
    } catch (error) {
      if (!task.current()) return;
      if (error instanceof ApiError && error.status === 400) {
        this.set({ pending: null, error: "Request was not admitted. Check the query and retrieval limit before submitting again." });
      } else if (error instanceof ApiError && error.status === 409) {
        this.set({ pending: null, error: "Request conflict. Review current saved status before choosing another action." });
        if (pending.kind === "continuation") await this.read(pending.runID);
      } else this.set({ error: confirmed ? "Request confirmed; refresh saved status only." : "Response unconfirmed. Retry the same request; changing the draft does not replace it." });
    } finally { if (task.current()) this.set({ busy: false }); }
  }
  async read(id: string, automatic = false) {
    if (!this.live()) return;
    if (!automatic) this.reads = 0;
    const task = this.begin();
    try {
      const page = await api.run(this.library, id, 0, this.generation, 25, task.signal);
      if (!task.current()) return;
      if (page.run.run_id !== id) throw new Error("Saved run identity did not match.");
      this.set({ confirmed: this.state.confirmed === id ? null : this.state.confirmed });
      this.page(page);
      const active = page.continuation ? ["queued", "running"].includes(page.continuation.state) : ["queued", "running"].includes(page.run.state);
      if (active && !this.state.pending) {
        if (++this.reads < 120) this.timer = setTimeout(() => { if (task.current()) void this.read(id, true); }, 2000);
        else this.set({ notice: "Automatic status refresh stopped. Refresh saved status to check again." });
      }
    } catch (error) { if (task.current()) this.set({ error: `Saved status unavailable. ${(error as Error).message}` }); }
    finally { if (task.current()) this.set({ busy: false }); }
  }
}
