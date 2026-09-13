# Native literature server candidate

Go net/http and pgx implement account/session admission, tenant-scoped libraries, genuine PubMed search, durable selected batches and processing plans, permitted PMC OAI XML and checksum-bound PMC deposit PDF originals, per-item reasons, typed XLSX, UTF-8 CSV/JSON/JSONL and original ZIP export. React/TypeScript/Vite compiles to static files served directly by Go. Neither .NET nor Node is required at runtime. This bounded invited-demo implementation does not establish complete research/import/export parity or a formal production release.

## Build

From `src/literature-server`, use Go 1.27.1:

```sh
go mod download
go test -count=1 -v ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -o server .
```

From `src/literature-web`, use Node24 and the exact npm lock:

```sh
npm ci
npm test
npm run build
```

Deploy `server`, the compiled frontend `dist` contents, project `LICENSE`, Go `THIRD_PARTY_NOTICES.md`, frontend `FRONTEND_NOTICES.md`, and an exact package manifest. Tests and testdata are source acceptance inputs, never runtime paper data. Go tests do not call providers; unavailable guarded PostgreSQL/captured replay inputs explicitly skip. The snapshot tool includes only its explicit tracked source allowlist. The runtime packer additionally verifies two equal binary builds, two equal static builds, source hashes, deterministic archive and missing/unexpected/modified-member rejection.

## Protected configuration and native schema

Copy `config.example.json` into a protected operator location outside source, then replace every operator/path/database/expiry field with actual values. The example is deliberately expired, uses a nonexistent local socket and disables providers. It is not a deployable receipt. Supply its path through `LITRADOCK_GO_CONFIG`; never place secrets in argv, source, browser storage or logs. `FrontendDirectory` points to the installed compiled static directory. `Database` uses a dedicated least-privilege PostgreSQL role and database whose name starts `litradock_native_`. Internal PostgreSQL and application listeners stay private.

With the service stopped, run `./server bootstrap` once against a fresh empty dedicated database. The transaction creates native schema 3 and rejects a nonempty database. Set `LITRADOCK_OPERATOR_LOGIN` and `LITRADOCK_OPERATOR_PASSWORD` through a protected secret environment supplied by the operator, then run `./server provision`. Do not type a literal password into a shell command/history. Passwords require12–256 Unicode code points; standard-library PBKDF2-SHA256 uses600000 iterations and random salt. Provision creates a new explicit account and refuses to overwrite an existing one. It is not existing-account recovery or automatic enabling. Clear the operator environment after the process exits. Both verbs have bounded transactions and non-secret output.

Normal `./server` accepts native schema 3, 4 or 5, truthful operator/contact/retention, a future expiry, an exact origin and a127.0.0.1 listener. `LocalTest=true` only permits HTTP loopback and a separate test cookie. Nonlocal mode requires HTTPS and Secure cookies; actual proxy/TLS qualification remains a separate gate. Write Origin, Host and CSRF are checked. Session admission revalidates account/session lifecycle. A legacy migration database reader remains an explicit separate mode, not an import tool or compatibility service.

## Product and source limits

Search accepts up to2000 code points and a retrieval limit1–100; provider total and retrieved count remain distinct. Each batch selects1–10 stable saved Search IDs and uses a UUID idempotency key. Pause/cancel preserve original bytes; lease recovery and up to3 attempts retain truthful partial/retry states. Selected PMC OAI XML requires matching separate identifiers and one reviewed complete article grant template; a nonempty rights URI alone is insufficient. Redirects, unsafe targets, ambiguous rights, unsupported versions, source login/challenge and unavailable PDFs never become fabricated originals. Current policy is rechecked for downloads and exports.

Each original is bounded to8MiB each/256MiB aggregate including retained PDF rights evidence and stored atomically in PostgreSQL with SHA256, rights/source URI, repository stamp and separate identifiers. CSV permits at most1000 saved rows/4MiB; ZIP permits32MiB original bytes plus bounded metadata. Limits reject explicitly, without silent truncation. CSV is not XLSX. Browser Save is separate from server acquisition.

Provider access defaults off. Coordinate a unique bounded window before enabling search/acquisition, including any other application using the same egress. The database stores400ms pacing, Retry-After and candidate allowances; another database is not automatically serialized by these locks. Product sign-in does not create an upstream account or API license. Official references: https://www.ncbi.nlm.nih.gov/books/NBK25497/ and https://pmc.ncbi.nlm.nih.gov/tools/oai/ .

## Qualification and operation boundary

`SOURCE-MANIFEST.json` is generated archive evidence, not a tracked source input. Regenerate it with `scripts/create-native-source.py --revision <exact-40-hex-commit> --output <new-archive.tar>`. Its revision names the input commit; it cannot name a future commit containing itself. A public source checkout contains the allowlisted code paths; the source archive additionally contains this generated manifest. When publishing extracted deterministic archives, force content staging or refresh file timestamps and verify Git blobs, because identical archive timestamps and file sizes can hide changed contents from stat-based index checks.

For destructive isolated native engine tests, read `native_test.go`, use a disposable dedicated database and set `LITRADOCK_NATIVE_TEST=yes` plus its protected configuration path. `go test -count=1 -v ./...` runs actual PostgreSQL assertions when enabled. `LITRADOCK_NATIVE_ORIGINAL_REPLAY` optionally points to a private captured-envelope index; replay is not a new provider call. Synthetic fixtures are labelled and never admitted into the user candidate. The inherited `LITRADOCK_GO_INTEGRATION`/metadata replay gates belong to the earlier copied-schema migration checks and may skip independently.

One supervisor owns the process. Privileged supervisor PID/log/script parents must not be writable by the application; verify target UID before a privileged stop. Enforce measured cgroup CPU/memory/PID bounds, and qualify GUI start/stop/restart/logs on the actual installation. Vendor-manager updates require renewed boundary checks. Actual site scripts, credentials, paths and receipts are private and excluded from this source distribution.

Stop before paired backup; schema 3 keeps metadata and original bytea in one PostgreSQL snapshot. Restore first into an isolated database and compare identities, hashes and paused work. Before exposing any restored account state, revoke restored sessions; a supported native restore/session-revocation operator command is still pending. Keep code/config/DB backup identities together, and never run an older schema writer against a newer schema without explicit compatibility qualification. Deployment-specific TLS, source integration and rollback evidence must be verified for the exact package. Native import/research recovery, practical bulk, broader source coverage, off-host backup/alerts, physical devices and spreadsheet applications, clean install, signing and current vulnerability clearance remain separate release gates.

XLSX exports preserve identifiers as text, including leading zeros, and attach explicit usable source hyperlinks. Export a saved run for metadata or a saved batch for current reasons and original provenance; CSV and ZIP remain available. Selection persists across pages of the same saved run (5/25/50/100 rows per page) and clears when its run, library or account changes. Ordinary batches retain a maximum of 10 selected items. When processing plans are explicitly enabled, select up to 100 saved records from one run; retrieval remains bounded to 100 records. See `docs/adr/0013-native-xlsx-and-saved-selection.md` in the source tree.

## Durable processing plans

`PlanEnabled` defaults to false. With schema 2 and the operator policy enabled, one plan admits 1–100 explicit saved Search IDs from one run/library using one UUID idempotency key. The existing worker materializes groups of at most 10; the browser never submits a loop of child batches. Plans and standalone batches share the global 1000-item reservation and source/storage budgets. Cancelled reservations still count; the bounded 2000-entry control history is not silently evicted.

Open Saved plans after reload or sign-in to read existing work. Progress reports eight disjoint phases, without estimated percentages. Historical acquisition is separate from current download availability. Pause/resume/cancel fence in-flight leases; explicit retry applies only to the next eligible child group below its attempt ceiling. Source cooldown and revision conflicts require a current read before another deliberate action. Child lifecycle controls belong to their parent plan. Open a child batch for original Save, XLSX, CSV and ZIP. Saved plans also offer one whole-plan originals ZIP and matching metadata JSON; every membership and unresolved outcome remains represented. The 100-member limit is separate from the 32 MiB unique-original / 37 MiB ZIP bounds. Oversized plans retain metadata and child/individual Save alternatives; export never starts acquisition. See `docs/adr/0017-plan-original-export.md`.

For an existing schema 1 database, stop the service and take a paired database/config/runtime backup, then run `./server migrate-plans` with protected configuration. Startup refuses the wrong schema. `./server rollback-empty-plans` permits downgrade only while every plan structure and child reference is empty. Once a plan exists, retain schema 2 with a compatible qualified runtime or disable plan processing; never discard user work to run an old binary. Restore and compare a disposable backup first. See `docs/native-plan-api-006.md` and `docs/adr/0014-native-durable-plans.md`.


### Reviewed shared trial identity transition

With the service stopped, an operator may run `./server transition-shared-trial` after confirming that the selected existing account contains only data suitable for a shared demonstration. Set the explicit account UUID in `LITRADOCK_OPERATOR_ACCOUNT`, target login/password in the existing protected operator environment, and `LITRADOCK_OPERATOR_SHARED_TRIAL=transition-reviewed-shared-trial`. Never supply secret values in argv or shell history.

This narrowly scoped exception permits 4–256 Unicode code points for the shared trial password; normal provisioning still requires 12–256. The standard PBKDF2 hasher is unchanged. The transaction takes the exclusive request-admission lock and account row lock, renames the existing login, rotates its password, and revokes every session for that account. It preserves enabled state, account UUID and all domain data; conflicting login or unknown account fails without mutation. It accepts native schema 1 or 2 because it changes only the unchanged account/session tables. It does not migrate schema or start a different application binary. Retain a protected pre-transition database and account mapping backup; do not restore that database over later user activity.

## Original PDF acquisition

`PDFEnabled` defaults to false. With schema 3 and acquisition enabled, `format:"pdf"` on a batch or plan requests exact source PDFs, preserving omitted-format XML behavior. Use `./server migrate-pdf` after a stopped-service paired backup of schema 2. `./server rollback-empty-pdf` allows return to schema 2 only before any PDF work or evidence exists; afterward preserve schema 3 with a compatible binary and disable PDF acquisition if needed. No old binary may write newer data.

A bounded official PMC deposit listing, exact identifiers, supported published version, reviewed JATS grant and advertised object checksums are required. Source failures and missing PDFs retain reasons and links. PDF ZIP contains only actual available originals plus a complete per-item manifest; it does not create or rename XML into PDFs. Original bytes remain archival snapshots and may not reflect current NLM data. See `docs/adr/0015-native-original-pdf.md` for precise rights/parser/resource limits.

## Structured saved-research exports

Saved runs and batches support versioned UTF-8 JSON and JSONL alongside CSV/XLSX. Whole-plan JSON shares the same typed records, separate textual identifiers, actual query contexts, missing values and historical original descriptors, with a versioned plan manifest. Metadata-only availability is not revalidated; a plan ZIP validates each selected original against current rights and bytes, deduplicates exact files and retains every record-to-file association. No abstract or full text is fabricated, and no external LLM/provider is called by export. See `docs/adr/0016-structured-research-export.md` and `docs/adr/0017-plan-original-export.md`.

## Combine explicit saved searches

The saved-record basket combines explicitly checked records across saved searches in one library. It retains first-added record order, merges duplicate Search IDs and records only the chosen real run associations. Adding records does not acquire anything. One explicit action admits a durable plan of 1–100 unique records and at most 1,000 record/run associations; existing worker, source and archive limits remain unchanged. The draft clears on reload or library/account change; confirmed plans reopen through GET without another acquisition. Downloads display received bytes, and percentages only when Content-Length describes those same bytes.

Enable this additive scope only after a stopped-service paired backup and disposable restore qualification. Run `./server migrate-multirun` with protected `LITRADOCK_GO_CONFIG` to migrate schema 3 to 4, then explicitly set `SavedSetEnabled=true`. Schema 3 forces effective admission off. `./server rollback-empty-multirun` permits return to schema 3 only when no saved-set work or source associations exist. Once saved sets exist, retain schema 4 and a compatible runtime; `SavedSetEnabled=false` disables new admission while preserving existing replay, controls and exports. Never restore an older backup over newer research merely to run an older binary.

The existing library plan endpoint accepts `{requestID,scopeKind:"saved_set",members:[{searchID,runIDs}],format:"pdf"|"xml"}`. This is mutually exclusive with the single-run form. Identical intent and request UUID replay the original receipt; changed membership, record order or format conflict. Plan admission alone accepts up to 128 KiB of JSON. Saved-set summaries have `scopeKind:"saved_set"`, an empty `runID`, and real `sourceRunIDs`; item `runIDs` preserve selected associations. Plan metadata/ZIP use that frozen membership with individual query contexts, never an invented combined run or summed provider total. See `docs/adr/0018-explicit-multirun-saved-sets.md`.


## Durable search continuation

After a paired backup and with the service stopped, migrate schema 4 using `./server migrate-search-continuation`. A schema 3 installation first uses `migrate-multirun`. Enable `SearchContinuationEnabled` only after local deployment qualification. New runs capture a maximum of 1,000 PMIDs once in provider order; the initial query limit (1–100) becomes the metadata page size. Continue explicitly to retrieve one additional page. Provider totals, frozen identities, processed positions, saved unique records, visible rows and selected records are different counts. The provider can report more than 10,000 matches; this application does not fetch them all or equate them with eligible PDFs.

Saved membership survives restart and does not rely on temporary provider History tokens. Metadata itself can change or disappear after capture. Cancellation discards late page results, retry reuses the same saved PMID slice, and each page has a three-attempt ceiling. No automatic next-page or failed-page loop. A query interrupted before membership persistence requires a new explicit run. Existing runs have no retroactive continuation. Reload and exports never make provider calls. Missing metadata PMIDs remain listed with the saved window; their source page is `https://pubmed.ncbi.nlm.nih.gov/{PMID}/`.

Run pages omit raw metadata/full-text XML from transport while preserving durable source data and export contracts. Pages over 8 MiB fail explicitly and can be requested at a smaller page size; a page that would exceed the run's 32 MiB stored metadata bound is rejected atomically. Original-file, acquisition, 100-member plan, 32 MiB unique-original and shared source budgets remain unchanged. Selecting a saved subset never selects unfetched provider matches or widens an existing plan.

`rollback-empty-search-continuation` is allowed only while every continuation window is empty. Once used, retain schema 5 and a compatible binary with new continuation admission disabled. Never run an older binary against populated schema 5 or restore an old backup over later research. See [the API and lifecycle decision](docs/adr/0019-durable-search-continuation.md). Physical-device, full provider-window, archive-partition and formal-release qualification remain separate.


## Prepared original bundles (schema 6)

Explicit POST `/api/libraries/{library}/plans/{plan}/bundles` with a UUID
`requestID` freezes all 1–100 saved plan members, unavailable reasons and actual
search/run provenance. Same intent replays its receipt; another plan conflicts.
GET list/detail/parts never acquires originals. `BundleDeliveryEnabled` gates new
preparation only; retained receipts remain subject to authorization and rights.

The `litradock.bundle` version 1 JSON contains typed research and ordered part
lengths/SHA256/file associations. Unique originals are greedily assigned in member
order, never splitting a file; every record alias is independently revalidated.
Limits: 128 MiB originals per snapshot; 8 MiB originals/17 MiB ZIP per part;
4 MiB raw metadata read budget/8 MiB saved document. Existing whole-plan limits
remain. Preparation/parts share one archive slot. Capacity errors never truncate
archives. Parts regenerate from exact originals, with no archive/temp storage.

GET `/{snapshotID}/parts/{number}` accepts one inclusive `Range: bytes=start-end`
with exact quoted SHA256 `If-Match`: 206/Content-Range on success, 416/412 on
invalid range/validator, 409 on changed rights/originals, 410 after expiry.
The UI checks complete length/SHA256 before browser handoff, shows actual bytes,
and retains one partial part in this tab for explicit Retry. Scope changes or
reopening discard tentative bytes. Browser handoff does not prove disk persistence;
multiple downloads may require browser permission. No automatic source requests.

Stop the application before `migrate-bundles` (schema 5 to 6) and take a verified
paired database/configuration/source backup. `rollback-empty-bundles` refuses any
receipt. On populated schema 6 retain a compatible binary and disable preparation;
never run a schema-5-only binary over schema 6. `prune-bundle-snapshots` removes
expired payloads but retains UUID tombstones to prevent accidental resubmission.
Snapshots expire in 24 hours. Metadata quotas: 16 MiB/library, 64 MiB globally,
20 active snapshots/plan, 4096 global receipts. Tombstone removal requires a
separately qualified retention decision; exhaustion needs operator action.
