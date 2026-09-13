# ADR0018: explicit saved sets across real search runs

Accepted technical decision: preserve one stable Search ID per saved record while allowing an explicitly selected set to reference multiple real search runs. Do not invent a synthetic combined run or sum overlapping provider totals.

An additive request supplies ordered unique records and their selected real run associations. The existing capacity lock serializes atomic plan/membership/source insertion. Association order is canonicalized; record order remains user intent and participates in idempotency. Composite foreign keys bind every frozen association to the plan member and actual saved result. Later queries can add record associations without changing an existing saved set. Snapshot exports use the frozen associations and current saved query metadata; ordinary single-run plans retain their previous behavior.

Schema4 makes the parent run nullable and adds a relational source-association table. No existing data is rewritten. Explicit stopped-service migration and an empty-saved-set rollback are supported. Once saved sets exist, rollback must retain a schema4-compatible binary and can disable new saved-set admission; the prior schema3 binary deliberately refuses schema4. Backups are point-in-time recovery material, never permission to overwrite newer research.

The scope remains one owned library,1–100 unique records and at most1000 selected associations. Acquisition/source/storage budgets, one worker, ten-record child groups and32MiB originals/37MiB ZIP bounds are unchanged. Per-record rights/identifier/version validation occurs before file dedup. Missing associations, invalid intent or exceeded bounds fail atomically; no implicit search, acquisition retry or truncated export is introduced.

The frontend basket is intentionally library/session-scoped across run navigation. It remains separate from ordinary run-scoped checkboxes. Explicit admission creates one durable request; reopening reads only. Downloads report actual received bytes with honest unknown-length handling and retain session/body/scope fences. Byte arrival is distinct from validation and device Save.

Broader result paging, archive partitioning, offline portability and genuinely large source workloads require separate qualification. This decision does not expand source permission or establish complete release support.
# Request transport

Plan admission alone accepts up to 128 KiB of JSON, covering the maximum explicit membership without increasing other request limits. Semantic record and association limits are checked separately; over-limit requests produce no partial plan.
