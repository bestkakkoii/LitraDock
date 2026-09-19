import { SourceOutcome } from "../api";

export function SourceOutcomeView({ outcome, onOpenBatch }: { outcome?: SourceOutcome; onOpenBatch?: (id: string) => void }) {
  if (!outcome) return null;
  return <section className="source-outcome" aria-label="Original source outcome">
    <p><strong>{outcome.requestedFormat?.toUpperCase() || "Original"}: {outcome.label}</strong></p>
    <p>{outcome.detail}</p>
    <p className="muted small">{outcome.nextAction}</p>
    {outcome.observedAt && <p className="muted small">Retained source observation: {outcome.observedAt}. No new source check was made.</p>}
    {onOpenBatch && outcome.batchId && <button className="secondary small-button" onClick={() => onOpenBatch(outcome.batchId!)}>Open saved source outcome</button>}
  </section>;
}
