export type WorkspaceView = "search" | "history" | "downloads" | "plans" | "library";
export type WorkspaceRoute = { library: string; run: string; view: WorkspaceView };
const views: WorkspaceView[] = ["search", "history", "downloads", "plans", "library"];
// Only navigation identities live in this browser entry. Metadata, credentials,
// filters and selection are never trusted or persisted in browser history.
export function readWorkspaceRoute(): WorkspaceRoute | null {
  const value = window.history.state?.litradockWorkspace;
  return value && typeof value.library === "string" && value.library.length <= 256 &&
    typeof value.run === "string" && value.run.length <= 256 && views.includes(value.view)
    ? { library: value.library, run: value.run, view: value.view } : null;
}
export function writeWorkspaceRoute(route: WorkspaceRoute | null, replace = false) {
  const prior = readWorkspaceRoute();
  if (JSON.stringify(prior) === JSON.stringify(route)) return;
  window.history[replace ? "replaceState" : "pushState"]({ litradockWorkspace: route }, "");
}
