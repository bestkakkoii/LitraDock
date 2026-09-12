# Research workflow preview

Projects are independent collections of canonical records. Open a record and choose **Review, notes and reading copies** to set its project decision, tags, notes, reason and optional exact-version quote/section/page. Source and derived page numbers are explicitly different. Concurrent edits require reloading the latest revision. Acquisition failure never changes a scientific inclusion decision.

Reading copies preserve the input original and are labelled **Formatted Reading Copy** or **Abstract Only**. Queue a saved XML/HTML/text revision, or generate only its saved abstract. Saved HTML/text requires explicit user identity confirmation during original upload; this is not automatic scholarly identity validation. Original PDFs/scans remain downloadable; reflow and OCR are unavailable. Unsupported external figures are shown as missing, captions retained, and TeX notation remains visibly untypeset. The converter retains semantic structure, not publisher layout. Imported provenance is a supplied claim whose byte hashes/relations are checked, not an authenticated claim that the original converter ran on this server.

Conversions continue without a browser while the backend runs. Pause/cancel is durable; interrupted leases are paused and need explicit resume. Prepared output can be reconciled without replacing original bytes. One heavy operation is admitted at a time across the shared service. Per conversion: three attempts,8MiB source,100000 nodes/depth100,32MiB/200-page output and100-second process deadline; JavaScript heap256MiB is not a total process memory cap. The PDF/parser/Chromium processes require an appropriately constrained production deployment.

Choose a saved scope, optionally selected records, then preview or download APA/IEEE citations, RIS, BibTeX or CSL-JSON. Styles are pinned and run offline; missing structured metadata is disclosed. Citation order does not rename records. CSL-JSON is the preferred reusable structured projection; complete raw metadata and publication-type details remain in full reports and private bundles. Bibliography formatting is not a quality/relevance recommendation. Formatting supports1000 records/8MiB metadata per request; split larger scopes explicitly.

The scoped Excel/CSV report includes saved reviews, decision events, citations, conversions and derived references. Private scoped bundles include the selected canonical records and referenced originals/derived files plus research/search history; unrelated record contents are omitted. Whole-library backup remains separate. New format2/schema4 bundles restore to a new owned library and pause unfinished conversions. Legacy format1/schema3 whole-library bundles map new research tables to empty; older applications cannot read schema4. Preserve the old matching database/object pair for rollback; no destructive down migration or in-place merge exists.

Projects are limited to1000 per library, current reviews/history/conversion/citation export tables to10000 entries with explicit refusal rather than truncation. Displayed research history and files are paged; exports read the complete bounded scope. This is basic screening, not independent reviewer arbitration or PRISMA certification.

## Operator setup

Use Node22 or24 and the existing .NET/PostgreSQL setup. Users need only the hosted browser interface. Operator setup requires these project-local steps (no third-party accounts or LLM key):

```sh
npm ci --prefix src/document-worker --ignore-scripts
python3 src/document-worker/setup-assets.py
node src/document-worker/node_modules/playwright/cli.js install --with-deps chromium
export DOCUMENT_WORKER="$PWD/src/document-worker/worker.mjs"
```

On Windows use Python in place of python3 and set DOCUMENT_WORKER through protected process configuration to the absolute path. DOCUMENT_NODE can specify an installed Node executable. PLAYWRIGHT_BROWSERS_PATH may select project-local browser assets. The service removes database/session/provider variables from the document child. Do not disable the Chromium sandbox to make a failed environment appear supported. Use a non-root execution identity and a tested sandbox/container policy; production runtime hardening remains a separate gate.

Run the schema migration while the service is stopped, then restart using the configured document worker. Asset hashes are verified before use; mismatched/missing assets fail closed. Font setup fetches the pinned unmodified Noto font once, never during user conversion. No external media or arbitrary source URL is fetched by the renderer. Font/style/runtime notices are in THIRD-PARTY-NOTICES and src/document-worker/assets; these do not confer rights over scholarly files.
