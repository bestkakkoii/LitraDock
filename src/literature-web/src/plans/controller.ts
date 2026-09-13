import { ApiError, sessionGeneration } from "../api";
import { ControlPlan, CreatePlan, PlanAction, PlanCatalog, PlanPage, planApi } from "./api";
import { SavedMember, savedMembers } from "./basket";

type Pending = { kind: "create"; body: CreatePlan } | { kind: "control"; planID: string; body: ControlPlan; selectedCount: number; savedSet: boolean };
export type PlanState = {
  catalog: PlanCatalog; page: PlanPage | null; busy: boolean; error: string;
  notice: string; pending: Pending | null; automaticReads: number; pollingStopped: boolean;
  confirmed: { planID: string; savedSet: boolean } | null;
};
export const emptyPlanState = (): PlanState => ({
  catalog: { plans: [], total: 0, offset: 0, limit: 25 }, page: null,
  busy: false, error: "", notice: "", pending: null, confirmed: null, automaticReads: 0, pollingStopped: false,
});

// A controller belongs to one mounted account/library/run scope. All requests,
// callbacks and timers also capture an operation so an aborted fetch cannot publish.
export class PlanController {
  state = emptyPlanState();
  private readonly api;
  private operation = 0;
  private disposed = false;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private openedID = "";
  private mutationSavedSet = false;
  constructor(
    readonly library: string,
    public runID: string,
    readonly generation: number,
    private readonly publish: (state: PlanState) => void,
  ) { this.api = planApi(library, generation); }

  private set(patch: Partial<PlanState>) {
    if (!this.disposed && this.generation === sessionGeneration()) {
      this.state = { ...this.state, ...patch };
      this.publish(this.state);
    }
  }
  private begin() {
    this.mutationSavedSet = false;
    clearTimeout(this.timer);
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const operation = ++this.operation;
    const current = () => !this.disposed && !controller.signal.aborted &&
      operation === this.operation && this.generation === sessionGeneration();
    this.set({ busy: true, error: "" });
    return { current, signal: controller.signal };
  }
  private schedule() {
    clearTimeout(this.timer);
    const page = this.state.page;
    if (this.disposed || this.state.pending || this.state.error || !page || page.plan.state !== "active") return;
    if (this.state.automaticReads >= 120) {
      this.set({ pollingStopped: true });
      return;
    }
    const operation = this.operation;
    // Never shorten a server delay or overflow setTimeout into a hot loop.
    if (page.nextPollAfterMs > 2_147_483_647) {
      this.set({ notice: "The server requested a long refresh delay. Automatic refresh is stopped; check again later." });
      return;
    }
    const delay = Math.max(2000, page.nextPollAfterMs);
    this.timer = setTimeout(() => {
      if (!this.disposed && operation === this.operation && this.generation === sessionGeneration())
        void this.read(page.plan.planID, page.offset, true);
    }, delay);
  }
  dispose() {
    this.disposed = true;
    this.operation++;
    this.abort?.abort();
    clearTimeout(this.timer);
  }
  changeRun(runID: string): boolean {
    if (runID === this.runID) return false;
    this.runID = runID;
    if (this.mutationSavedSet) return false;
    const pending = this.state.pending;
    if (this.state.confirmed?.savedSet) return false;
    if (!pending && !this.openedID && !this.state.page && !this.state.confirmed) return false; // Initial catalog is library-scoped.
    const savedSet = pending?.kind === "create" ? "scopeKind" in pending.body
      : pending?.kind === "control" ? pending.savedSet : (this.state.page?.plan ?? this.state.catalog.plans.find(plan => plan.planID === this.openedID))?.scopeKind === "saved_set";
    if (savedSet) return false;
    // Library catalog remains visible; only obsolete single-run operations retire.
    this.operation++; this.abort?.abort(); clearTimeout(this.timer);
    this.openedID = "";
    this.set({ page: null, pending: null, confirmed: null, busy: false, error: "", notice: "", automaticReads: 0, pollingStopped: false });
    return true;
  }
  async catalog(offset = 0) {
    if (this.disposed) return;
    const task = this.begin();
    try {
      const catalog = await this.api.catalog(offset, task.signal);
      if (task.current()) this.set({ catalog });
    } catch (error) {
      if (task.current()) this.set({ error: `Saved plans unavailable. ${(error as Error).message}` });
    } finally {
      if (task.current()) { this.set({ busy: false }); this.schedule(); }
    }
  }
  async read(id: string, offset = 0, automatic = false) {
    if (!id || this.disposed) return;
    this.openedID = id;
    const changed = id !== this.state.page?.plan.planID;
    if (changed) this.set({ page: null, notice: "" }); // A GET cannot settle an uncertain POST.
    this.set(automatic ? { automaticReads: this.state.automaticReads + 1 } : { automaticReads: 0, pollingStopped: false });
    const task = this.begin();
    try {
      const page = await this.api.detail(id, offset, task.signal);
      if (task.current()) { this.acceptPage(page); return true; }
    } catch (error) {
      if (task.current()) this.set({ error: `Status unavailable; last confirmed counts are retained. ${(error as Error).message}` });
    } finally {
      if (task.current()) { this.set({ busy: false }); this.schedule(); }
    }
  }
  private acceptPage(page: PlanPage) {
    this.set({ page, confirmed: this.state.confirmed?.planID === page.plan.planID ? null : this.state.confirmed, catalog: { ...this.state.catalog,
      plans: this.state.catalog.plans.map(plan => plan.planID === page.plan.planID ? page.plan : plan),
    } });
  }
  async create(searchIDs: string[]) {
    if (this.state.busy || !this.runID || this.disposed) return;
    if (searchIDs.length < 1 || searchIDs.length > 100 || new Set(searchIDs).size !== searchIDs.length || searchIDs.some(id => !id)) {
      this.set({ error: "Choose 1 to 100 distinct saved records." });
      return;
    }
    // Until a receipt resolves, a second submission must replay the frozen body.
    // Changing the draft never silently changes a possibly committed request.
    if (this.state.pending || this.state.confirmed) return;
    const pending: Pending = { kind: "create", body: { requestID: crypto.randomUUID(), runID: this.runID, searchIDs: [...searchIDs] } };
    this.set({ pending });
    await this.mutate(pending);
  }
  async createSavedSet(members: SavedMember[], format: "pdf" | "xml") {
    if (this.disposed || this.state.busy || this.state.pending || this.state.confirmed) return;
    let frozen: SavedMember[];
    try { frozen = savedMembers(members); }
    catch (error) { this.set({ error: (error as Error).message }); return; }
    const pending: Pending = { kind: "create", body: { requestID: crypto.randomUUID(), scopeKind: "saved_set", members: frozen, format } };
    this.set({ pending }); await this.mutate(pending);
  }
  async control(value: PlanAction) {
    const plan = this.state.page?.plan;
    if (!plan || this.disposed || this.state.busy || this.state.pending || this.state.confirmed || !plan.allowedActions.includes(value)) return;
    const pending: Pending = { kind: "control", planID: plan.planID,
      body: { requestID: crypto.randomUUID(), expectedRevision: plan.revision, value }, selectedCount: plan.selectedCount, savedSet: plan.scopeKind === "saved_set" };
    this.set({ pending });
    await this.mutate(pending);
  }
  async retrySubmission() {
    if (this.state.pending && !this.state.busy && !this.disposed) await this.mutate(this.state.pending);
  }
  private async mutate(pending: Pending) {
    const task = this.begin();
    this.set({ notice: "" });
    this.mutationSavedSet = pending.kind === "create" ? "scopeKind" in pending.body : pending.savedSet;
    let committed = false;
    try {
      const receipt = pending.kind === "create"
        ? await this.api.create(pending.body, task.signal)
        : await this.api.control(pending.planID, pending.body, task.signal, pending.selectedCount);
      if (!task.current()) return;
      committed = true;
      this.openedID = receipt.planID;
      this.set({ pending: null, confirmed: { planID: receipt.planID, savedSet: this.mutationSavedSet }, notice: "Request confirmed. Loading current plan status.", automaticReads: 0, pollingStopped: false });
      // Replayed receipts can be old; only a current GET supplies displayed state.
      const page = await this.api.detail(receipt.planID, 0, task.signal);
      if (!task.current()) return;
      this.acceptPage(page);
      this.set({ notice: pending.kind === "control"
        ? `Request confirmed for ${receipt.affectedCount ?? 0} items. Current plan status: ${page.plan.state}.`
        : "Plan saved. Server processing can continue after you close this page." });
      const catalog = await this.api.catalog(this.state.catalog.offset, task.signal);
      if (task.current()) this.set({ catalog });
    } catch (error) {
      if (!task.current()) return;
      if (committed) {
        this.set({ error: "Request confirmed, but current status is unavailable. Reopen the confirmed plan; no new submission is needed." });
      } else if (error instanceof ApiError && error.status === 409) {
        this.set({ pending: null, error: "The request conflicts with current plan status or capacity. Refreshing; review before choosing another action." });
        try {
          if (pending.kind === "control") {
            const page = await this.api.detail(pending.planID, 0, task.signal);
            if (task.current()) this.acceptPage(page);
          } else {
            const catalog = await this.api.catalog(0, task.signal);
            if (task.current()) this.set({ catalog });
          }
        } catch { if (task.current()) this.set({ error: "Request conflict; current status is unavailable. Refresh saved plans." }); }
      } else {
        const definitive = error instanceof ApiError && [400, 404].includes(error.status);
        if (definitive) this.set({ pending: null });
        this.set({ error: committed ? "Request confirmed, but current status is unavailable. Refresh saved plans; do not create another plan."
          : definitive ? (error as Error).message
          : "The response was not confirmed. Retry the same submission to check its outcome, or reopen saved plans." });
      }
    } finally {
      if (task.current()) { this.mutationSavedSet = false; this.set({ busy: false }); this.schedule(); }
    }
  }
}
