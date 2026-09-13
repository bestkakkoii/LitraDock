# ADR-0023: Non-acquiring saved research snapshots

Status: implementation contract; independent review and release qualification pending.

An explicit saved snapshot freezes ordered saved-record membership, the supplied
record/run associations, typed metadata, acquisition observations and existing
original identities. It never schedules acquisition. A processing plan remains a
separate explicit action. Both use the existing authorized plan/export envelope
so original validation, partitioning and transfer fences have one implementation.

## API and frontend ownership contract

`POST /api/libraries/{library}/plans` accepts
`{requestID, scopeKind: "saved_snapshot", format: "pdf", members: [{searchID, runIDs}]}`.
The response retains `{planID, revision, state, selectedCount, affectedCount}`;
state is `saved_snapshot`, revision 1, affectedCount 0. There are 1–100 unique
records and at most 1000 unique record/run pairs. Record order is intentional;
run IDs within a record are canonicalized. The UUID is retained across a lost
response. Identical requests replay; reordered records or changed associations,
format or scope with the same request ID return 409. Foreign or missing pairs
return 404, with no partial admission.

Existing list/detail GET routes reopen the snapshot. Detail `scopeKind` and
`state` are `saved_snapshot`; `allowedActions` is empty, there are no child batch
IDs or waiting admissions. Existing observations use completed/held/retry phases,
with a reason explaining that no new acquisition was requested. Current download
availability is independently revalidated; a historical acquisition is no grant.
Existing whole-plan JSON/ZIP and partition bundle routes apply. Typed metadata
formats are exposed through `POST .../plans/{planID}/metadata` with
`{format: "json"|"jsonl"|"csv"|"xlsx"}`. Export never invokes the worker.

Frontend021 may exclusively edit the plans subtree, related plan API/types/tests,
and basket-scoped styles after a fresh routed assignment. Add a primary explicit
“Save research snapshot” basket action and distinguish saved snapshots from
processing plans. Retain the separate existing acquisition action. Reopening and
polling issue GET only; no acquisition control is shown for snapshots. Reuse
generation/library/download fences and stable request recovery. Agent2 owns all
Go, migration, packaging and technical documentation changes.

## Persistence and version semantics

Schema 8 is reserved for this feature, deliberately skipping the unreleased
importer schema 7. Supported migration is 6 to 8 only. The snapshot is represented
by a terminal native plan header, its existing ordered membership/provenance rows
and a bounded immutable typed document/observation payload. No native batch or
native item is inserted, and the scheduler cannot activate it. Snapshot membership
does not consume acquisition slots; saved-snapshot metadata has a separate bounded
admission budget. Save uses a consistent database transaction and existing account
admission locks. Original bytes are referenced, never copied or modified.

Only already stored originals of the requested format can be pinned. An ambiguous
set of distinct original hashes is held for explicit version selection in a later
increment; no highest-version guess is made. Missing, restricted and corrupted
originals remain in the manifest with actionable source links. Later acquisition
cannot silently widen an older snapshot. Export rechecks each association before
exact-file deduplication. Existing 8 MiB original, 128 MiB partitioned aggregate,
8 MiB part-original and one shared ZIP admission limits remain unchanged.

Rollback to schema 6 is permitted only with no saved snapshots. Once snapshots
exist, retain a compatible schema-8 binary with new snapshot admission disabled;
never erase new research or run the old schema-6 binary against schema 8. Paired
backup and actual isolated restore qualification precede public upgrade.

No provider requests are authorized for this increment. Source counters, jobs,
items and acquisition commands are observed around save/replay/reopen/exports.
Synthetic concurrency/fault cases are separate from the genuine four-record scope.

CSRF evidence clarification: native004's two negative writes both omitted CSRF,
so that run alone does not isolate valid-CSRF wrong-Origin behavior. Native003
separately records missing-CSRF and wrong-Origin 403 results. This is an evidence
scope distinction, not a reported bypass or a claim of new verification.

Wire clarification: service-info `savedSnapshotEnabled` is true for native schema
8 with `SavedSetEnabled`; it is independent of acquisition/plan admission. Raw
metadata responses use attachment filename `litradock-saved-research.<format>`:
JSON `application/json; charset=utf-8`, JSONL `application/x-ndjson; charset=utf-8`,
CSV `text/csv; charset=utf-8`, XLSX the standard OpenXML spreadsheet MIME type.
Metadata is bounded to 8 MiB; existing XLSX 4 MiB total text and cell limits apply.
Errors use the existing non-2xx `{error}` body. Saved snapshot admission is capped
at 100 per library, 1000 globally, and 64 MiB total frozen metadata. Current
snapshot controls return 409; no conversion to acquisition is supported.

Review correction: snapshot CSV/XLSX supplement the existing compact identifier
columns with Abstract, Journal, Publication metadata JSON, Query contexts JSON,
Original provenance JSON and Typed record JSON. Each typed record and every actual
query association remains recoverable; an overlong Excel cell fails explicitly
and JSON/JSONL remains available. No Excel field is silently truncated.

Metadata and whole-plan attachment responses revalidate the authenticated
session, enabled account and library ownership outside the data snapshot after
encoding. Shared row locks remain held through response handoff, ordering that
handoff before a later logout/disable transaction. Existing prepared-part final
session checks remain in force. Already delivered device bytes cannot be revoked.
