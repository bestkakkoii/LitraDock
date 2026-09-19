export type Capture = {
  strategy: "create_date_v1";
  state: "not_started" | "ready" | "complete" | "limited";
  pendingSegments: number; completedSegments: number; requests: number;
  requestLimit: 256; membershipLimit: 20000; providerBoundary: 10000;
  latestProviderTotal: number | null;
  order: "initial_then_segment"; canCapture: boolean; reason: string;
};
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;

export function validateCapture(value: unknown): Capture {
  const capture = value as Capture | null;
  if (!capture || Array.isArray(capture) || capture.strategy !== "create_date_v1" ||
      !["not_started", "ready", "complete", "limited"].includes(capture.state) ||
      !integer(capture.pendingSegments) || !integer(capture.completedSegments) ||
      capture.requestLimit !== 256 || !integer(capture.requests, capture.requestLimit) ||
      capture.membershipLimit !== 20000 || capture.providerBoundary !== 10000 ||
      (capture.latestProviderTotal !== null && !integer(capture.latestProviderTotal)) ||
      capture.order !== "initial_then_segment" || typeof capture.canCapture !== "boolean" || typeof capture.reason !== "string" ||
      (capture.canCapture && (["complete", "limited"].includes(capture.state) || capture.requests >= capture.requestLimit)))
    throw new Error("Saved capture status is invalid. Refresh saved progress; no source request was admitted.");
  return capture;
}

export const countLabel = (count: number, singular: string, plural = `${singular}s`) =>
  `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
