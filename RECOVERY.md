# Private library transfer and service recovery

This preview implements schema3 recovery. Consult the exact synthetic PostgreSQL/Chromium CI results for the source revision you use. These tests do not authorize a production cutover, prove institutional access, or establish clean installation and browser/OS support.

## Ordinary library users

Select your library, then **Check next file-health page** to inspect bounded hash checks. Missing, corrupt, unreadable and unreferenced bytes are reported; originals and scientific records are retained. The background service rotates through libraries every30 seconds with a persisted cursor. Each pass checks at most50 entries/128MiB; a large library requires several passes. A health result is dated evidence, not a guarantee that files remain intact afterward.

**Download private library bundle** downloads the complete selected library's metadata, histories, original versions and needed unfinished manual inputs. It contains sensitive raw metadata and paper bytes, is unencrypted, and must be stored privately. Missing originals are declared in the manifest and prevent restoration; corrupt originals stop export. This is separate from the scoped shareable Excel/CSV report. There is no partial-library backup projection or account export.

To restore or relocate, sign in to the destination service, choose the downloaded bundle with the restore file control and submit it. The destination creates a **new library owned by you**. Select that library to inspect records and download originals; links are generated for the current service. Canonical Search IDs, Run/Scope/Batch/Item/Job IDs and histories survive; the library UUID and internal database ordering allocation change. Existing libraries are never merged or replaced. Unfinished imported work is paused: review it before explicitly resuming. Cancelled work stays cancelled. **Transfer history** exposes completed/interrupted outcomes (most recent100); incomplete retained bytes need operator inspection, not repeated blind uploads.

Typical transfer requires one bundle download, selecting one file and one restore submission, then choosing the new library. A resumed provider cooldown requires zero user actions while the worker service is running. Browser closure does not stop a job; stopping the backend does. Four automatic continuations for transient/interrupted work, eight for provider cooldowns, and a72-hour lineage budget prevent indefinite retries. Backoff is15/60/240/900 seconds, with shared provider cooldowns as a lower bound. The UI reports timestamps, attempts and actual states; it does not predict completion time. Deliberate pause/cancel survives service restart. Expired account sessions require signing in again; publisher/institution sessions are a separate unsupported capability.

## Format and resource boundaries

Version1 ZIP contains manifest.json, metadata.json and safe relative original/staging entries. Schema3 is the only supported bundle schema. Fixed table/field allowlists exclude accounts, sessions, ownership grants, provider budgets and leases. All file paths, SHA256 values, byte lengths, actual XML/PDF kinds and canonical associations must agree. DOI/PMID/PMCID indexes must match metadata. Duplicate JSON properties/entries, links, traversal, incompatible schemas and unsupported executable entries are rejected. PDF validation is bounded parsing plus retained user identity attestation where applicable; it is not a malware sandbox or rendered fidelity proof.

Limits:256MiB compressed/expanded bundle,32MiB metadata,10000 rows per included table,32MiB per original,20002 archive entries and100:1 maximum ratio for entries above1MiB. Export reserves space conservatively and rejects instead of silently truncating. Import has a2-minute validation budget with15-second database commands; individual parser work can extend a boundary by its bounded operation. The private file tree has1GiB/library,8GiB/root and20000-entry inventory limits, with64MiB disk headroom. Retained failed inputs/stages and generated transfers count toward physical usage; unknown bytes are not automatically deleted. These bounds are not database/history quotas, a production memory sandbox or service-level capacity guarantees.

One heavyweight operation across application processes holds a PostgreSQL advisory admission lock; competing requests receive429/Retry-After2. Browser restore requires both the application not-started admission header and admission_not_started code, displays this pre-handler wait and retries admission at most3 times, without another click or duplicate submission button. It never automatically repeats ambiguous network/409/503 failures; the persistent recovery panel directs the user to transfer history before another upload. Metadata and pause/cancel remain usable. All API/worker instances must use the same database/storage and obey the admission boundary. Unrelated external SQL/filesystem writers are outside it. Loss of a live lock connection and physical power loss are not fully qualified by the current process-kill tests.

## Operator disaster recovery

A user bundle is not service disaster recovery. Operator recovery uses a **trusted private pg_dump plus object pair**, including account hashes and other service state. Never accept an untrusted SQL dump, commit the pair, upload it as public CI evidence or copy production credentials into test environments.

With protected process configuration already supplying LITRADOCK_POSTGRES and LITRADOCK_OBJECTS outside public content, perform these bounded commands using the compiled application:

```sh
dotnet build src/LitraDock.Hosted -c Release --no-restore
dotnet build/LitraDock.Hosted/Release/net10.0/LitraDock.Hosted.dll --operator-backup
# In a separately configured empty target database and new object directory:
dotnet build/LitraDock.Hosted/Release/net10.0/LitraDock.Hosted.dll --operator-restore
```

Set LITRADOCK_RECOVERY_PATH to a new private destination for backup, or the completed pair directory for restore. LITRADOCK_PG_DUMP and LITRADOCK_PG_RESTORE optionally select trusted executable paths; default commands are pg_dump/pg_restore. Use PostgreSQL18 tools matching the tested engine and an appropriate protected operator role. Do not put passwords in arguments or logs. The implementation passes a password only through the child environment. TLS and storage encryption/access controls are deployment responsibilities.

Before backup, stop out-of-band writers and schedule maintenance. The exclusive application barrier refuses an active API/worker operation; retry when it has drained. A successful pair has pair.json and no INCOMPLETE marker. The dump includes a startup recovery guard. Restore refuses existing targets, verifies pair hashes, restores the database in one transaction, stages/moves objects, revokes copied sessions and pauses unfinished jobs before clearing the guard. Restart the service and independently check library/record counts, expected versions, original hashes and deliberate pause. Keep the source pair and old service intact until that drill is accepted.

Failed backups/restores retain an incomplete destination, guard or transfer journal for investigation; never treat directory existence as success. If backup failed after setting a guard on the original database, `--operator-clear-guard` takes maintenance admission and verifies up to10000 stored original hashes before clearing it. This command cannot repair missing bytes. A partially restored target needs operator verification/recovery from its preserved pair; automatic destructive cleanup, in-place overwrite and PITR are not implemented.

## Migration and rollback

Stop old service processes and preserve a consistent schema2 database/object pair before explicit `--migrate`. Schema1→2→3 is additive; old migration files and native SQLite baseline are retained. The actual CI drill compares populated schema1 rows through migration and restores a schema3 pair in another database/directory. It does not cover every historical schema2 dataset, interrupted storage device or production topology. Old applications must not write a schema3 database. Rollback means restore the earlier matching pair into a separate target, then verify it; there is no destructive down-migration or automatic conversion of newer writes.

The manual CI workflow runs only disposable synthetic libraries, including process interruptions, negative bundles, tenant isolation and actual container pg_dump/pg_restore. The PostgreSQL engine, browser and relevant process RSS results are distinct evidence; fixture scale is not a production capacity claim. No paper downloads or cloud deployment occur in that workflow.
