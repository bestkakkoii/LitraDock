# Native recovery operations

These Linux operator templates do not change the web application, call sources, restore a live database, or supervise its process. The application's existing manager remains authoritative. Actual deployment configuration and recovery archives contain private data and must never be published.

Provision a dedicated root-owned mode0700 backup directory and a root-owned mode0600 operations configuration based on `config.example.json`. Resolve the actual interpreter to a regular canonical file for `expiry_command`; the example version is illustrative. The manager helper must be root-owned, protected against unprivileged writes, read the same application expiry and disable auto-start/stop only the intended application. Validate that helper separately before enabling expiry. Never point it at a general shell or accept user-supplied arguments.

Pin the current native database name, source revision, schema and SHA256 of the exact runtime tar. Its embedded manifest, installed members and protected application configuration must agree. After a release, update these values under the existing deployment fence; mismatches refuse backup rather than producing an apparently compatible pair. A runtime archive and database dump are limited to64MiB each, a pair to128MiB, and the dedicated root to512MiB including incomplete attempts. Minimum free space is512MiB plus twice the maximum dump plus actual runtime plus2MiB overhead. The service adds a180-second process-tree deadline and96MiB memory cap. Test these limits on the actual host before promising support for larger libraries.

Commands (use actual protected paths):

```
python3 native_ops.py backup --config /etc/litradock-native/operations.json
python3 native_ops.py verify --pair /var/backups/litradock-native-pairs/backup-UTC-UUID
python3 native_ops.py expiry --config /etc/litradock-native/operations.json
python3 test_native_ops.py
```

Backup refuses contention on the local operations lock or any admission/heavy/source fence, active work, recovery-required state, incompatible source/schema/runtime, quota or disk exhaustion. It may briefly make application admission return its existing retry response. The dump and immutable configuration/runtime copies are taken inside the fence; archive assembly follows release. Current source counters must not change during capture. The complete archive contains `database.dump`, `runtime.tar`, `runtime-manifest.json`, `application.json` and `snapshot.json`; originals are in PostgreSQL. Sessions are also included and must be explicitly purged only in the isolated recovery target before starting a recovered application.

An incomplete attempt stays in a private `.partial-*` directory and counts toward quota. It is never a completed pair or eligible for automatic deletion. After a new complete pair, retention validates all completed pairs before deleting only verified pairs at least seven days old, preserving at least two newest. Unknown names, symlinks, additional files, inconsistent timestamps or changed bytes refuse deletion. The operator must inspect incomplete attempts before removing exact owned files; never recursively clean the backup root or an inferred path.

Before timer activation, perform a genuine paired backup, copy it offhost through the protected channel, independently verify every member, restore only into a new disposable PostgreSQL database without workers, compare domain tables/identifiers/originals, then purge clone sessions and set its recovery guard. A successful checksum does not prove a successful restore. Keep the old recovery path until replacement passes. Rollback disables only these new timers/services and restores backed-up unit/config definitions; it never replaces live research with an older dump or runs incompatible code against newer schema.

The expiry timer rechecks current configuration every minute, including after an earlier not-due result. This is operational stop scheduling, not retention or data deletion and not a source-rights/session extension. Qualify not-due with the live configuration and due/failure with an isolated fake manager; do not stop the public demo merely to test expiry. Preserve explicit limitations for unexercised real due-time behavior.

Tests use explicitly synthetic files and fault injection, not product papers or PostgreSQL proof. POSIX cases are skipped on Windows and must run on Linux. No source traffic is needed. Follow quiet internal/headless process execution on Windows; these Linux systemd templates create no Windows GUI or console.
