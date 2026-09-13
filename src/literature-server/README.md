# Native literature server candidate

Go net/http and pgx implement account/session admission, tenant-scoped libraries, genuine PubMed search, durable selected batches and processing plans, permitted PMC OAI XML originals, per-item reasons, typed XLSX, UTF-8 CSV and original ZIP export. React/TypeScript/Vite compiles to static files served directly by Go. Neither .NET nor Node is required at runtime. This bounded invited-demo implementation does not establish complete research/import/export parity or a formal production release.

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

With the service stopped, run `./server bootstrap` once against a fresh empty dedicated database. The transaction creates native schema 2 and rejects a nonempty database. Set `LITRADOCK_OPERATOR_LOGIN` and `LITRADOCK_OPERATOR_PASSWORD` through a protected secret environment supplied by the operator, then run `./server provision`. Do not type a literal password into a shell command/history. Passwords require12–256 Unicode code points; standard-library PBKDF2-SHA256 uses600000 iterations and random salt. Provision creates a new explicit account and refuses to overwrite an existing one. It is not existing-account recovery or automatic enabling. Clear the operator environment after the process exits. Both verbs have bounded transactions and non-secret output.

Normal `./server` requires valid native schema 2, truthful operator/contact/retention, a future expiry, an exact origin and a127.0.0.1 listener. `LocalTest=true` only permits HTTP loopback and a separate test cookie. Nonlocal mode requires HTTPS and Secure cookies; actual proxy/TLS qualification remains a separate gate. Write Origin, Host and CSRF are checked. Session admission revalidates account/session lifecycle. A legacy migration database reader remains an explicit separate mode, not an import tool or compatibility service.

## Product and source limits

Search accepts up to2000 code points and a retrieval limit1–100; provider total and retrieved count remain distinct. Each batch selects1–10 stable saved Search IDs and uses a UUID idempotency key. Pause/cancel preserve original bytes; lease recovery and up to3 attempts retain truthful partial/retry states. Selected PMC OAI XML requires matching separate identifiers and one reviewed complete article grant template; a nonempty rights URI alone is insufficient. Redirects, unsafe targets, ambiguous rights, unsupported versions, source login/challenge and unavailable PDFs never become fabricated originals. Current policy is rechecked for downloads and exports.

Original XML is bounded to8MiB each/256MiB aggregate and stored atomically in PostgreSQL with SHA256, rights/source URI, repository stamp and separate identifiers. CSV permits at most1000 saved rows/4MiB; ZIP permits32MiB original bytes plus bounded metadata. Limits reject explicitly, without silent truncation. CSV is not XLSX. Browser Save is separate from server acquisition.

Provider access defaults off. Coordinate a unique bounded window before enabling search/acquisition, including any other application using the same egress. The database stores400ms pacing, Retry-After and candidate allowances; another database is not automatically serialized by these locks. Product sign-in does not create an upstream account or API license. Official references: https://www.ncbi.nlm.nih.gov/books/NBK25497/ and https://pmc.ncbi.nlm.nih.gov/tools/oai/ .

## Qualification and operation boundary

`SOURCE-MANIFEST.json` is generated archive evidence, not a tracked source input. Regenerate it with `scripts/create-native-source.py --revision <exact-40-hex-commit> --output <new-archive.tar>`. Its revision names the input commit; it cannot name a future commit containing itself. A public source checkout contains the allowlisted code paths; the source archive additionally contains this generated manifest. When publishing extracted deterministic archives, force content staging or refresh file timestamps and verify Git blobs, because identical archive timestamps and file sizes can hide changed contents from stat-based index checks.

For destructive isolated native engine tests, read `native_test.go`, use a disposable dedicated database and set `LITRADOCK_NATIVE_TEST=yes` plus its protected configuration path. `go test -count=1 -v ./...` runs actual PostgreSQL assertions when enabled. `LITRADOCK_NATIVE_ORIGINAL_REPLAY` optionally points to a private captured-envelope index; replay is not a new provider call. Synthetic fixtures are labelled and never admitted into the user candidate. The inherited `LITRADOCK_GO_INTEGRATION`/metadata replay gates belong to the earlier copied-schema migration checks and may skip independently.

One supervisor owns the process. Privileged supervisor PID/log/script parents must not be writable by the application; verify target UID before a privileged stop. Enforce measured cgroup CPU/memory/PID bounds, and qualify GUI start/stop/restart/logs on the actual installation. Vendor-manager updates require renewed boundary checks. Actual site scripts, credentials, paths and receipts are private and excluded from this source distribution.

Stop before paired backup; schema 2 keeps metadata and original bytea in one PostgreSQL snapshot. Restore first into an isolated database and compare identities, hashes and paused work. Before exposing any restored account state, revoke restored sessions; a supported native restore/session-revocation operator command is still pending. Keep code/config/DB backup identities together, and never run an older schema writer against a newer schema without explicit compatibility qualification. Deployment-specific TLS, source integration and rollback evidence must be verified for the exact package. Native import/research recovery, practical bulk, broader source coverage, off-host backup/alerts, physical devices and spreadsheet applications, clean install, signing and current vulnerability clearance remain separate release gates.

XLSX exports preserve identifiers as text, including leading zeros, and attach explicit usable source hyperlinks. Export a saved run for metadata or a saved batch for current reasons and original provenance; CSV and ZIP remain available. Selection persists across pages of the same saved run (5/25/50/100 rows per page) and clears when its run, library or account changes. Ordinary batches retain a maximum of 10 selected items. When processing plans are explicitly enabled, select up to 100 saved records from one run; retrieval remains bounded to 100 records. See `docs/adr/0013-native-xlsx-and-saved-selection.md` in the source tree.

## Durable processing plans

`PlanEnabled` defaults to false. With schema 2 and the operator policy enabled, one plan admits 1–100 explicit saved Search IDs from one run/library using one UUID idempotency key. The existing worker materializes groups of at most 10; the browser never submits a loop of child batches. Plans and standalone batches share the global 1000-item reservation and source/storage budgets. Cancelled reservations still count; the bounded 2000-entry control history is not silently evicted.

Open Saved plans after reload or sign-in to read existing work. Progress reports eight disjoint phases, without estimated percentages. Historical acquisition is separate from current download availability. Pause/resume/cancel fence in-flight leases; explicit retry applies only to the next eligible child group below its attempt ceiling. Source cooldown and revision conflicts require a current read before another deliberate action. Child lifecycle controls belong to their parent plan. Open a child batch for XML Save, XLSX, CSV and ZIP; plan-wide export is not implemented.

For an existing schema 1 database, stop the service and take a paired database/config/runtime backup, then run `./server migrate-plans` with protected configuration. Startup refuses the wrong schema. `./server rollback-empty-plans` permits downgrade only while every plan structure and child reference is empty. Once a plan exists, retain schema 2 with a compatible qualified runtime or disable plan processing; never discard user work to run an old binary. Restore and compare a disposable backup first. See `docs/native-plan-api-006.md` and `docs/adr/0014-native-durable-plans.md`.


### Reviewed shared trial identity transition

With the service stopped, an operator may run `./server transition-shared-trial` after confirming that the selected existing account contains only data suitable for a shared demonstration. Set the explicit account UUID in `LITRADOCK_OPERATOR_ACCOUNT`, target login/password in the existing protected operator environment, and `LITRADOCK_OPERATOR_SHARED_TRIAL=transition-reviewed-shared-trial`. Never supply secret values in argv or shell history.

This narrowly scoped exception permits 4–256 Unicode code points for the shared trial password; normal provisioning still requires 12–256. The standard PBKDF2 hasher is unchanged. The transaction takes the exclusive request-admission lock and account row lock, renames the existing login, rotates its password, and revokes every session for that account. It preserves enabled state, account UUID and all domain data; conflicting login or unknown account fails without mutation. It accepts native schema 1 or 2 because it changes only the unchanged account/session tables. It does not migrate schema or start a different application binary. Retain a protected pre-transition database and account mapping backup; do not restore that database over later user activity.
