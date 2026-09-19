# ADR-0029 — deliberate PubMed capture stages

Status: PROPOSED_DEFAULT; implementation and independent qualification pending.
Input: accepted native023a plus CHG-0059, `b29b728a2182d52af7d81d79be2046b93a06dcd1`.

PubMed ESearch returns at most the first 10,000 matches. Increasing `retstart`
cannot establish complete PubMed membership beyond that boundary. The retained
1,000-ID initial browser route remains useful for first results, but refinement
advice alone does not fulfil the continued saved-query requirement.

Choose an explicit, durable Create Date partition plan. Each researcher action
authorizes one browser-owned ESearch with a frozen segment, `retstart=0`,
`retmax=10000`, and the existing relevance sort. A root query retains the exact
normalized submitted query. Oversized root coverage becomes a date range from
1800-01-01 through the plan's UTC day plus its Boolean complement. Oversized date
ranges split into adjacent day intervals, newer first. The complement retains
undated and outside-range matches. An oversized single day or complement is an
explicit unsupported leaf; no guessed pagination, remote snapshot, exactly-once
effect or global ranking is asserted.

Schema 11 adds plans, accepted stage provenance and ordered unique membership.
Existing IDs retain their order and canonical Search IDs, initial query snapshot,
records and durable selection. Complete leaves append only new IDs in their
observed order. A leaf that would exceed 20,000 captured IDs is retained as
unresolved and appends no partial prefix. At most 256 capture attempts are admitted;
each source stage retains the existing three-attempt ceiling. Captured union may
exceed initial or later provider counts because observations occur at different
times. A completed partition plan describes observed coverage, not an upstream
transactional snapshot. [NLM ESearch](https://www.ncbi.nlm.nih.gov/books/NBK25499/#chapter4.ESearch),
[Create Date](https://pubmed.ncbi.nlm.nih.gov/help/#crdt) and
[usage policy](https://www.ncbi.nlm.nih.gov/books/NBK25497/) were revalidated on
2026-09-20 Asia/Taipei without calling Eutils.

Metadata advances separately in pages of 1–100 with the existing 32 MiB saved-run,
8 MiB browser body and 128 MiB browser-response storage bounds. A failed or
cancelled capture must not strand previously captured metadata when its attempt
ceiling is reached. Session/library/run authorization, job/window locks, revision
fences and request-identity replay remain in force. Local receipts do not promise
remote exactly-once execution.

Schema 11 durable selections support 20,000 saved records, with exact IDs and at
most 100 detailed records. PDF execution remains batch 10 / plan 100. Large
metadata exports use a single Repeatable Read archive snapshot with parts of at
most 1,000 saved rows and one manifest, rather than requiring hundreds of manual
downloads. Selected exports contain exactly selected saved metadata. An ID
manifest separately preserves captured saved/missing/pending identities and
unresolved links. Each part fences selection and capture revisions. CSV/XLSX
reuse the existing formula and link protections; format/text limits fail before
headers without truncation. Archives are bounded at 64 MiB and individual parts
at 8 MiB. The archive endpoint has a 60-second context deadline; supported workload
measurements must be recorded before acceptance.

Migration preserves existing rows. Empty schema-11 rollback is allowed only when
none of the new capture tables is used. Once capture data exists, contain new
admission with a compatible schema-11 reader; old binaries must refuse schema 11.
Release helpers, ordinary-role permissions, backup conservation and this rollback
path require independent review before production effects.

Alternatives: EDirect would move source execution to another runtime and require
new reviewed transport/accounting. Arbitrary ESearch pagination is unsupported.
Rewriting the query or discarding partial membership changes the researcher’s
request. None is used in this bounded goal. G5 writing/citations and native024 PDF
capacity remain separate.
