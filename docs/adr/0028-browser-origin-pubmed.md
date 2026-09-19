# ADR-0028: Browser-origin PubMed requests

Status: PROPOSED_DEFAULT implementation; independent review and deployed acceptance pending.

The shared server's PubMed identity must not make every researcher's search depend
on that identity's availability. Supported browsers issue fixed-origin ESearch and
EFetch form POSTs directly to NCBI. The application server admits bounded work,
parses authenticated uploads, and persists research. It does not attest that an
uploaded response was issued by NCBI.

The initial capability observation was Windows Chromium 153, ESearch GET/form
POST and EFetch form POST, readable XML with wildcard CORS and no preflight.
Production uses form POST only, no cookies, referrer, application headers,
redirect following, alternate route or automatic credential change. CSP grants
`connect-src 'self' https://eutils.ncbi.nlm.nih.gov` only while the browser feature
is enabled. A capability observation does not qualify every browser or key.

Optional user-owned keys stay in tab memory and in the NCBI POST body. No key or
key hash is sent to the application, saved in storage or exported. Removal,
logout or session invalidation retires in-flight work; reload requires re-entry.
A key-required run cannot silently become unkeyed. Invalid/revoked key responses
produce the same explicit request-rejected outcome; the browser cannot infer the
reason for every NCBI refusal. Server input decoding rejects unknown key fields.

The provider's [usage policy](https://www.ncbi.nlm.nih.gov/books/NBK25497/)
and [E-utilities reference](https://www.ncbi.nlm.nih.gov/books/NBK25499/)
remain controlling. Both credential modes use at least 1.2 seconds between actual
source starts in this origin/profile. Web Locks serialize tabs; storage contains
timing only. Server pacing/cooldown is per authenticated session, including
separate users of the trial account. A 429 retains a conservative cooldown and
requires an explicit new search or metadata retry. Readable Retry-After applies
to both credential modes; a timing-only profile cooldown conservatively covers
other tabs without retaining a key identity. Unlocked capability checks use a
separate disposable storage probe and cannot overwrite request timing. There is no request loop.
Neither mechanism coordinates separate profiles, devices, other applications or
institutional NAT. A browser network/CORS error does not establish an outage.

## Durable work and trust

Schema 10 introduces `browser_search` jobs, browser-owned runs, attempt receipts
and per-session pacing. Existing workers select only `search`, so they cannot
claim browser work. UUID admission is idempotent; a replayed claim is never fresh.
Attempt leases are 120 seconds, response bodies at most 8 MiB, retained response
and in-flight reservations at most 128 MiB, and attempts at most 20,000. Original
200 runs/1,000 jobs/20 active, 1,000 captured IDs, 1–100 metadata per page,
three page attempts, 10 PDF batch and 100 plan limits remain.

Queued browser admissions also have a 120-second deadline, renewed when explicit
continuation or saved initial membership queues the next step. The existing
worker and new admission transactions retire at most 20 expired browser jobs
at a time, releasing active/storage reservations without any provider request.
This also covers a closed tab that never claimed its queued work. Valid leases,
completed receipts and saved research are retained. After expiry, unknown initial
membership requires a new search; frozen metadata requires an explicit retry.

Initial membership is committed before metadata. Unknown initial responses are
expired and require a separate explicit search. Frozen metadata pages can be
explicitly retried after reconciliation. Lost uploads replay only the identical
application request/body; no provider request is replayed. Reload loses an
unsaved in-memory response; saved leases/receipts and existing records survive.
Cancellation fences late uploads. No all-background execution is claimed.

Query normalization, filters embedded in the query, relevance sort, provider
translation, PMID rank, stable Search ID/Run ID, exact identifiers and durable
selection are retained. The body hash, received time, browser execution and
`client_submitted_parsed` verification label accompany membership/metadata.
CSV/XLSX and JSON/JSONL retain appropriate record and query provenance. Existing
records are never overwritten or augmented by client identifiers; a conflicting
page is rolled back and its response retained for review.

Browser metadata cannot authorize originals. The unchanged fixed PMC cloud
listing/version JSON/JATS identity checks, article-level reviewed rights,
checksums and PDF validation independently govern uncached originals. A client
URL or license is never a source or grant. Repository proof authorizes that
original; it does not promote the submitted title, query or metadata to verified.

## Operation and rollback

With service stopped, preserve a paired database/config/runtime backup, restore
and compare it in isolation, then run `server migrate-user-route` from schema 9.
Startup requires schema 10 and continuation support when `UserRouteEnabled=true`.
`PubMedDeveloperEmail` is optional operator-owned public tool contact; do not
invent one or borrow a user's personal address.

`rollback-empty-user-route` is transactional and refuses any browser-owned run.
After use, retain schema 10 and the qualified compatible runtime; turn off
`UserRouteEnabled`, `SearchEnabled` and `SearchContinuationEnabled` together to
contain new source admission while retaining reads, receipts and exports. Never
restore an older database over later research or run the old schema-9 writer.
Disabling the feature is not permission to return to server-origin PubMed.

HTTPS (loopback HTTP only for isolated tests), Web Locks, streaming Fetch,
AbortSignal.any, UUID generation and available origin storage are required.
Unsupported browsers retain saved research and receive an explicit limitation.
Physical mobile devices, Safari/Firefox, background suspension and real personal
keys remain unqualified until separately tested. Narrow desktop emulation is not
physical-device support. No new local adapter, extension, dependency or billing
is introduced.
