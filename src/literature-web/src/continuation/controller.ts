import { api, ApiError, RunPage, sessionGeneration } from "../api";
import { Action, ActionIntent, Continuation, SearchIntent, submitAction, submitSearch, validateContinuation } from "./api";
import { BrowserRouteController } from "../userRoute/controller";
import { credentialMode } from "../userRoute/credentials";
import { browserRouteSupport } from "../userRoute/scheduler";

type Pending = { kind: "search"; body: SearchIntent } | { kind: "continuation"; runID: string; body: ActionIntent };
export type SearchState = { busy: boolean; pending: Pending | null; confirmed: string | null; error: string; notice: string; browserPending?: boolean; browserRunID?: string };
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
  private browser: BrowserRouteController;
  constructor(readonly library: string, readonly generation: number, private publish: (value: SearchState) => void,
    private page: (value: RunPage) => void, private scope: AbortSignal, private retirePage: () => void = () => {}, private browserEnabled: () => boolean = () => false,
    private captureEnabled: () => boolean = () => false) {
    scope.addEventListener("abort", this.stop);
    this.browser = new BrowserRouteController(library, generation, (notice, browserPending) => this.set({ notice, browserPending }));
  }
  private live = () => !this.disposed && !this.scope.aborted && this.generation === sessionGeneration();
  private set(value: Partial<SearchState>) { if (this.live()) { this.state = { ...this.state, ...value }; this.publish(this.state); } }
  navigate() {
    this.sequence++; this.abort.abort(); clearTimeout(this.timer);
    this.set({ busy: false, error: "", notice: "", browserRunID: undefined });
  }
  dispose() { this.navigate(); this.browser.dispose(); this.disposed = true; this.scope.removeEventListener("abort", this.stop); }
  private begin() {
    this.retirePage();
    this.navigate(); this.abort = new AbortController();
    const operation = this.sequence, signal = this.abort.signal;
    this.set({ busy: true });
    return { signal, current: () => this.live() && !signal.aborted && operation === this.sequence };
  }
  async search(query: string, limit: number) {
    if (!this.live() || this.state.busy || this.state.pending || this.state.confirmed || this.state.browserPending) return;
    if (this.browserEnabled() && browserRouteSupport()) { this.set({ error: browserRouteSupport() }); return; }
    this.set({ pending: { kind: "search", body: { query, limit, requestID: crypto.randomUUID(), ...(this.browserEnabled() ? { credentialMode: credentialMode() } : {}) } } });
    await this.retry(true);
  }
  async action(status: Continuation, action: Action) {
    if (!this.live() || this.state.busy || this.state.pending || this.state.confirmed || this.state.browserPending ||
      !(action === "capture" ? this.captureEnabled() && this.browserEnabled() && status.execution === "user_browser" && status.capture?.canCapture :
        action === "continue" ? status.canContinue : action === "retry" ? status.canRetry : status.canCancel)) return;
    try { validateContinuation(status, status.runID); }
    catch (error) { this.set({ error: (error as Error).message }); return; }
    this.set({ pending: { kind: "continuation", runID: status.runID, body: { requestID: crypto.randomUUID(), revision: status.revision, action,
      ...(this.browserEnabled() && action !== "cancel" ? { credentialMode: status.credentialMode ?? credentialMode() } : {}) } } });
    await this.retry(true);
  }
  async retry(executeBrowser = false) {
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
      if (executeBrowser && this.browserEnabled() && (pending.kind === "search" || pending.body.action !== "cancel") &&
          (pending.kind === "search" || pending.body.action !== "capture" || this.captureEnabled())) {
        this.set({ confirmed: null });
        await this.startBrowser(id, pending.kind === "search" ? "initial" : pending.body.action === "capture" ? "capture" : "metadata");
        return;
      }
      await this.read(id, false, !executeBrowser && this.browserEnabled()
        ? "Request reconciled. Review saved progress and resume explicitly; no provider request was repeated." : "");
    } catch (error) {
      if (!task.current()) return;
      if (error instanceof ApiError && error.status === 400) {
        this.set({ pending: null, error: "Request was not admitted. Check the query and retrieval limit before submitting again." });
      } else if (error instanceof ApiError && error.status === 409) {
        this.set({ pending: null, error: "Request conflict. Review current saved status before choosing another action." });
        if (pending.kind === "continuation") await this.read(pending.runID, false, "Request was not applied because saved status changed. Review the refreshed status and choose the action again.");
      } else this.set({ error: confirmed ? "Request confirmed; refresh saved status only." : "Response unconfirmed. Retry the same request; changing the draft does not replace it." });
    } finally { if (task.current()) this.set({ busy: false }); }
  }
  async startBrowser(id: string, purpose: "initial" | "capture" | "metadata" | "resume" = "resume") {
    if (!this.live() || !this.browserEnabled()) return;
    const task = this.begin();
    this.set({ browserRunID: id });
    let notice = "";
    try { await this.browser.execute(id, task.signal, this.captureEnabled, purpose); }
    catch (error) { if (task.current()) notice = (error as Error).message; }
    if (task.current()) await this.read(id, false, notice || this.state.notice);
  }
  async reconcileBrowser() {
    if (!this.live() || this.state.busy) return;
    const task = this.begin();
    try {
      const id = await this.browser.reconcile(task.signal);
      if (id && task.current()) await this.read(id, false, this.state.notice);
    } catch (error) { if (task.current()) this.set({ error: (error as Error).message }); }
    finally { if (task.current()) this.set({ busy: false }); }
  }
  async recoverBrowser(status: Continuation) {
    if (!this.live() || this.state.busy || !status.canRecover || !status.attemptID) return;
    const task = this.begin();
    try { await this.browser.recover(status.runID, status.attemptID, task.signal); if (task.current()) await this.read(status.runID); }
    catch (error) { if (task.current()) this.set({ error: (error as Error).message }); }
    finally { if (task.current()) this.set({ busy: false }); }
  }
  async cancelBrowser() {
    const id = this.state.browserRunID;
    if (!id || !this.live()) return;
    const task = this.begin(); // Abort provider transfer before reading its actual revision.
    try {
      const page = await api.run(this.library, id, 0, this.generation, 25, task.signal);
      if (!task.current()) return;
      if (page.continuation?.canCancel) {
        await submitAction(this.library, id, { requestID: crypto.randomUUID(), revision: page.continuation.revision, action: "cancel" }, this.generation, task.signal);
      }
      this.browser.dispose(); this.set({ browserPending: false });
      if (task.current()) await this.read(id, false, "Browser source work stopped; saved results were retained.");
    } catch (error) { if (task.current()) this.set({ error: "Cancellation is unconfirmed. Refresh saved progress before any retry." }); }
    finally { if (task.current()) this.set({ busy: false }); }
  }
  async read(id: string, automatic = false, notice = "") {
    if (!this.live()) return;
    if (!automatic) this.reads = 0;
    const task = this.begin();
    try {
      const page = await api.run(this.library, id, 0, this.generation, 25, task.signal);
      if (!task.current()) return;
      if (page.run.run_id !== id) throw new Error("Saved run identity did not match.");
      this.set({ confirmed: this.state.confirmed === id ? null : this.state.confirmed });
      this.page(page);
      if (notice) this.set({ notice });
      const active = page.continuation?.execution === "user_browser" ? page.continuation.state === "running" :
        page.continuation ? ["queued", "running"].includes(page.continuation.state) : ["queued", "running"].includes(page.run.state);
      if (active && !this.state.pending) {
        if (++this.reads < 120) this.timer = setTimeout(() => { if (task.current()) void this.read(id, true); }, 2000);
        else this.set({ notice: "Automatic status refresh stopped. Refresh saved status to check again." });
      }
    } catch (error) { if (task.current()) this.set({ error: `Saved status unavailable. ${(error as Error).message}` }); }
    finally { if (task.current()) this.set({ busy: false }); }
  }
}
