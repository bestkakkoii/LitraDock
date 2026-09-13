export function PdfAvailability({ selectedCount }: { selectedCount: number }) {
  return <section className="pdf-availability" aria-label="PDF downloads">
    <div>
      <h3>Download PDFs</h3>
      <p>PDF acquisition is currently unavailable. This service does not download publisher PDFs or sign in to publisher accounts.</p>
      <p className="muted small">You can still create a batch for permitted repository XML, save available XML originals, or export metadata and original bundles. XML and ZIP are not PDFs.</p>
    </div>
    <button disabled aria-describedby="pdf-unavailable">Download PDFs ({selectedCount} selected)</button>
    <span id="pdf-unavailable" className="small">Unavailable — no supported PDF acquisition service</span>
  </section>;
}
