# LitraDock — hosted literature workflow preview

The [restricted invited-user demo](DEMO.md) provides a concrete same-origin deployment path with bounded real PubMed search and reviewed XML acquisition. Read its exact scope, server limits, source/privacy notices and unresolved hosting/device qualification before inviting participants.

This snapshot contains application code and synthetic tests for review. It has no original development/commissioning history, private libraries or acquired papers. Project source is provided under GNU AGPL-3.0-only; see LICENSE. This does not grant rights to scholarly articles, trademarks or external services. Third-party components retain their own notices.

The service uses ASP.NET Core10, PostgreSQL and private immutable originals outside the web root. It supports PubMed search, permitted PMC/Europe PMC XML acquisition, durable mixed-outcome batches, same-record manual originals and complete scoped Excel/CSV reports. See [source workflow and limits](SOURCES.md) and [private library transfer and operator recovery](RECOVERY.md). It is not a production release; actual deployment/security/backup gates remain. Operator-created accounts have revocable sessions; self-registration/reset/email flows are not implemented.

```sh
dotnet restore tests/LitraDock.HostedVerification --locked-mode
dotnet run --project tests/LitraDock.HostedVerification -c Release --no-restore -- --static .litradock/checks
```

The manual-only candidate workflow separates offline checks from PostgreSQL integration. It performs no source harvest, release or deployment. The manual workflow uses disposable synthetic data and performs no live source requests. A missing PostgreSQL connection is a failure to execute that test, not a pass. Runtime configuration: LITRADOCK_POSTGRES, LITRADOCK_OBJECTS (outside public content), exact HTTPS LITRADOCK_ORIGIN, loopback backend LITRADOCK_PORT and explicit trusted LITRADOCK_PROXY_IP when terminating TLS at a reverse proxy. Source HTTPS behavior uses the supported NCBI adapter; access rights are not transferred from browser to server.

Run migration explicitly with `--migrate` using a migration role. Runtime role needs only the application table/sequence privileges. Create an account using `--create-account` with LITRADOCK_INITIAL_LOGIN and LITRADOCK_INITIAL_PASSWORD supplied through protected process configuration, never committed. Import a stopped SQLite copy with `--import`, LITRADOCK_IMPORT_COPY, LITRADOCK_IMPORT_OWNER and LITRADOCK_IMPORT_NAME; retain the source copy and original rollback baseline. Import failure does not activate the destination and may leave an isolated object directory for inspection.

No PostgreSQL service is started by the offline tests. GitHub Actions verifies disposable synthetic data; it is not the runtime host. GitHub Pages cannot run this persistent API/worker/database. No production endpoint is provisioned by this repository.

Research collections, exact-version notes, labelled reading PDFs, offline CSL citations and selected private transfer are described in [RESEARCH.md](RESEARCH.md). Use the exact revision CI receipt; source availability and production/platform acceptance remain separately scoped.

Account lifecycle control: stop the API and workers, retain protected database/object settings, then run `dotnet LitraDock.Hosted.dll --account-control` with `LITRADOCK_ACCOUNT_ID` set to the explicit canonical account UUID and `LITRADOCK_ACCOUNT_ACTION` set to `disable`, `enable`, or `revoke-sessions`. All three actions delete that account's current sessions atomically; enable requires a new login. Libraries, originals and durable jobs are preserved. Previously authorized background work is not cancelled by account disabling. JSON output reports a non-secret result and revoked count; failure exits nonzero. Busy means nothing started: drain the active operation before a new attempt. Account row waits are bounded to three seconds, independently of connection and command timeouts. This stopped-service procedure is not qualified as a zero-downtime administrative control. Password changes/recovery, invitations, OIDC and retention/deletion remain future identity scope.

On the next authenticated response with status401, the browser revokes its prepared citation URL, discards private page state and returns to sign-in. This cannot retract bytes already downloaded/copied or detect revocation in an idle/offline tab. The `--identity` verification mode and browser suite exercise synthetic PostgreSQL transactions, forced lock order, process termination, request admission and privacy; consult the exact CI revision/results for execution status.
