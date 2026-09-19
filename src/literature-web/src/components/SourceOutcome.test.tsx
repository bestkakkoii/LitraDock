// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ArticleCard } from "./ArticleCard";
import { SourceOutcome } from "../api";

it("shows a retained disposition and reopens its saved batch without acquisition; links reject credential/query payloads", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host), open = vi.fn(), select = vi.fn();
  const outcome: SourceOutcome = { status: "no_deposit", label: "No deposit in permitted source", detail: "This does not establish absence elsewhere.", nextAction: "Open the article source links.", evidence: "retained_source_metadata", observedAt: "2026-09-18T14:43:50Z", requestedFormat: "pdf", retryEligible: false, batchId: "BAT-synthetic", sourceLinks: { pubmed: null, pmc: null, doi: null, doiLinkState: null } };
  try {
    await act(async () => root.render(<ArticleCard article={{ Title: "SYNTHETIC <script>record</script>", SourceOutcome: outcome, OriginalUri: "https://user:secret@pubmed.ncbi.nlm.nih.gov/1/", PmcUri: "https://pmc.ncbi.nlm.nih.gov/articles/PMC1/?token=secret", DoiUri: "https://doi.org/10.0000/synthetic" }} selected={true} onSelect={select} onOpenBatch={open} />));
    expect(host.textContent).toContain("PDF: No deposit in permitted source");
    expect(host.textContent).toContain("No new source check was made");
    expect(host.querySelector("script")).toBeNull();
    expect([...host.querySelectorAll("a")].map(a => a.href)).toEqual(["https://doi.org/10.0000/synthetic"]);
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(open).toHaveBeenCalledExactlyOnceWith("BAT-synthetic"); expect(select).not.toHaveBeenCalled();
    await act(async () => root.render(<ArticleCard article={{ Title: "Another library" }} selected={false} onSelect={select} />));
    expect(host.textContent).not.toContain("No deposit"); expect(host.querySelector(".source-outcome")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
