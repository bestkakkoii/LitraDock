import { expect, it } from "vitest";
import { validateContinuation } from "../continuation/api";
import { capture, continuation, runID } from "./fixtures";
import { countLabel } from "./capture";

it.each([100, 1000, 9999, 10000, 20000])("permits %i captured IDs above the initial observation only with a valid staged capture", count => {
  const value = continuation({ windowCount: count, processedCount: 0, savedCount: 0, missingCount: 0 });
  expect(validateContinuation(value, runID)?.windowCount).toBe(count);
  if (count > 1000) expect(() => validateContinuation({ ...value, capture: undefined }, runID)).toThrow();
});
it.each([
  { strategy: "unknown" }, { state: "working" }, { pendingSegments: -1 }, { completedSegments: 1.1 }, { requests: 257 },
  { requestLimit: 300 }, { membershipLimit: 30000 }, { providerBoundary: 20000 }, { providerBoundary: 10000 }, { latestProviderTotal: -1 },
  { latestProviderTotal: NaN }, { order: "global_relevance" }, { canCapture: "yes" }, { reason: null },
  { state: "complete", canCapture: true }, { state: "limited", canCapture: true }, { requests: 256, canCapture: true },
])("rejects malformed capture %j before admitting work", patch => {
  expect(() => validateContinuation(continuation({ capture: { ...capture(), ...patch } as never }), runID)).toThrow();
});
it("keeps missing count exact while bounding links and permits legitimate exhausted coverage", () => {
  const ids = Array.from({ length: 100 }, (_, i) => String(i + 1));
  const value = continuation({ processedCount: 1003, savedCount: 803, missingCount: 200, missingPMIDs: ids,
    capture: capture({ state: "limited", canCapture: false, requests: 256 }) });
  expect(validateContinuation(value, runID)?.missingCount).toBe(200);
  expect(() => validateContinuation({ ...value, missingPMIDs: [...ids, "101"] }, runID)).toThrow();
  expect(() => validateContinuation({ ...value, capture: null as never }, runID)).toThrow();
  expect(() => validateContinuation({ ...value, windowCount: 20001 }, runID)).toThrow();
});
it("uses the singular wording requested by A1-USERROUTE-UX-003", () => {
  expect(countLabel(1, "match", "matches")).toBe("1 match");
  expect(countLabel(0, "match", "matches")).toBe("0 matches");
  expect(countLabel(1, "captured identity", "captured identities")).toBe("1 captured identity");
});
