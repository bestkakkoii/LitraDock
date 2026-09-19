# Literature web frontend

React/TypeScript/Vite builds static assets for the native Go literature API. Node and Vite are build tools, not runtime services. The production app uses relative same-origin requests, secure session cookies and CSRF for writes. Credentials and library records are never stored in localStorage. Session, library, run and operation generations fence late JSON/blob results and401 responses before UI/download side effects.

Use Node24 and the resolved package-lock tree:

```sh
npm ci
npm test
npm run build
```

Serve the resulting dist directory through the Go FrontendDirectory setting. Development may use `npm run dev -- --host 127.0.0.1`. Build/test dependencies can use package.json ranges; package-lock records exact resolved versions. React/ReactDOM/scheduler are production dependencies and their license texts are in FRONTEND_NOTICES.md. This is not current vulnerability clearance.

The app supports sign-in/out, named libraries, genuine PubMed searches with separate provider/retrieved totals, saved search pagination, selected durable batches and per-item reasons, saved-batch reopen, bounded progress refresh and XML/CSV/ZIP downloads. Search retrieves1–100 records; a batch selects1–10 stable saved Search IDs. Source rights and availability remain server-authoritative. CSV is not XLSX, XML is not publisher PDF, and user sign-in does not provide publisher access.

Saved batches may be reopened after reload without creating another acquisition. Active progress is read serially at bounded intervals; after four minutes a user may reopen to check again. Rights-held or unsupported items retain direct source links/reasons. Browser Save downloads already acquired bytes to the device. ZIP contains admitted originals, a manifest and CSV, including unresolved states. Late session/library responses and downloads are discarded.

Tests use explicitly synthetic isolated inputs; they are not live-provider proof or product fallback data. Production static assets exclude fixtures. Public-source and runtime qualification must bind an exact revision and asset manifest; an earlier audit or test result does not qualify a later build. Physical-device/OS support, broader source coverage, XLSX and complete research recovery remain unqualified unless documented separately.

When the qualified service enables browser-origin PubMed, search/metadata use
fixed NCBI form POSTs from this browser, without an automatic server fallback.
Optional personal keys stay in tab memory and are sent only to NCBI; re-enter
after reload and remove them or sign out to clear them. Keep the tab open until
its response is saved. Use saved progress to reconcile interruption; an unknown
initial search is never replayed silently. HTTPS, Web Locks, streaming Fetch,
AbortSignal.any and origin storage are required. Pacing coordinates this browser
profile, not other devices/apps or the institution's network. Metadata and query
provenance remain client-submitted; source rights are checked independently.
