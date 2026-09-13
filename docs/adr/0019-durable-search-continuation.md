# ADR-0019: bounded, locally frozen PubMed membership

Status: PROPOSED_DEFAULT implementation contract, native011; public activation requires qualification.

## Decision and source evidence

Use one ESearch response, sorted by relevance, to freeze at most 1,000 unique PMIDs in provider order. Persist that list before any EFetch call. Continue by explicit ID slices of at most the original requested page size (1–100); never rerun the query under the same run identity. This is a membership snapshot, not a frozen version of PubMed metadata. Record initial query translation/time and each page's retrieval time. Missing metadata is an explicit missing identity, never a saved record.

The [NCBI parameter reference](https://www.ncbi.nlm.nih.gov/books/NBK25499/) (updated March 4, 2026; read September 13, 2026) limits PubMed ESearch to the first 10,000 matches and documents explicit-ID EFetch. The 1,000 window is our smaller operational limit, not a provider limit. Larger totals remain visible and require a separate refined query/run; totals are never added across runs. [NLM History documentation](https://www.nlm.nih.gov/dataguide/eutilities/history.html) describes temporary server-side UID sets. We do not retain WebEnv/query-key tokens or rely on a token lifetime; local IDs do not expire with provider History. Metadata can change or disappear after capture. No current API-token lifetime guarantee was established from that page, and historical web-History timeout descriptions are not treated as one.

The [NCBI usage guidance](https://www.ncbi.nlm.nih.gov/books/NBK25497/) sets three requests/second without a key and advises off-peak large work. Existing shared advisory source fence, minimum 400 ms pacing, tighter cooldowns, finite global/day budgets and single worker remain. No new source or original-file permissions. No automatic page loop or automatic error retry.

## Frozen frontend API

Existing search POST body `{query,limit}` remains; when continuation is enabled it may additionally carry `requestID` UUID. Repeating the same UUID/query/limit returns the same `{id}`; changed intent returns 409. New frontend must retain uncertain UUID/body and never replace it automatically.

Existing run GET gains optional `continuation` (absent/null for old runs):

```json
{"runID":"RUN-...","revision":1,"state":"ready","windowLimit":1000,"windowCount":1000,"processedCount":100,"savedCount":100,"missingCount":0,"providerTotal":25000,"pageSize":100,"attempts":0,"canContinue":true,"canRetry":false,"canCancel":false,"reason":"","snapshotAt":"2026-09-13T00:00:00Z"}
```

States: `queued`, `running`, `ready`, `exhausted`, `window_limited`, `cancelled`, `failed`, `rate_wait`, `expired`, `unavailable`. `expired` means an initial search was interrupted before its membership could be frozen, or the saved membership is invalid; starting a new run is explicit. Old runs are never backfilled by rerunning a query.

`POST /api/libraries/{library}/runs/{run}/continuation` body `{requestID,revision,action}` with action `continue`, `retry`, or `cancel`. UUID replay precedes current revision checks; different intent conflicts. A success receipt is `{runID,revision,state}` with positive integer revision and known state. GET gives authoritative progress. `continue` admits one next page from ready/cancelled; `retry` retries the same failed/rate-wait page, maximum three attempts per page; `cancel` invalidates queued/running work. A cancelled in-flight response cannot commit. Reopen/poll/export are GET/read-only and never admit source work.

UI: provider matches, saved records, processed membership, visible page and checked count are distinct. Newly fetched rows must not silently widen an existing checked selection, basket or plan. Select all means an explicit bounded saved-record selection (maximum 100), not all provider matches; larger saved runs require choosing a page/subset. Preserve intentional deselections. Present 390/1280 readable layout, keyboard controls, waiting/error/retry/new-run recovery, and old-run limitation. Existing PDF/plan/export controls and byte progress remain. API run records omit bulky raw XML fields only in transport; durable metadata/export provenance remains intact.

## Persistence, limits and recovery

Add schema 5 tables for the immutable window, per-page outcomes and idempotent action receipts; existing domain rows and plans remain. One existing search job is reused under job-row/lease and shared capacity locks. All window commits, result associations, counts and page outcomes commit atomically. Provider returns must be a unique subset of requested PMIDs; reordered responses are restored to frozen order. Missing IDs consume a position and remain explicit. No provider call begins before durable admission; a crash before initial membership persistence cannot silently rerun that query.

Admission uses existing active-job budgets; at most three page attempts including interrupted attempts. Individual source response bounds remain, with a 32 MiB saved metadata budget per run; exceeding it rejects the whole page with an actionable error, not truncation. All old plan selections and source associations remain immutable. Saved record updates retain established full-text fields.

Stopped-service `migrate-search-continuation` upgrades 4 to 5. `rollback-empty-search-continuation` is allowed only before any new windows exist. Once populated, retain schema 5 and the compatible binary with new admission disabled; never run native010 against schema 5. Paired backup/restore and actual populated compatible recovery must be tested before public activation. Existing schema 3/4 operation remains supported with continuation disabled.

## Qualification still required

Actual PostgreSQL atomicity, leases/cancel/restart, idempotency/conflict, ownership and bounded storage; synthetic 0/1/page/1000/10000/>10000/error/429 cases; compiled browser and immutable review; modest separately reserved genuine query window; exact public package/CI/rollback. This decision does not establish implementation or full release completion.
