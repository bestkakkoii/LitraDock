# Operator qualification of the restricted demo

TASK-G4-DEPLOYMENT-PREP-002 adds an operator tool and evidence procedure. It does not change, rebuild or deploy the accepted demo. Python 3.11+ and PostgreSQL 18 client tools are operator prerequisites; ordinary invited users need neither. The verifier uses only the Python standard library, reads package/configuration/filesystem state and optionally performs bounded read-only loopback PostgreSQL queries. It never starts a server, creates accounts, installs packages, acquires papers, changes a database, restores data or executes configuration text.

The accepted demo is public source `cfd36dfa54acf5f1a0b870d467ebcfcb7136563a`, tag `demo-source-cfd36df`, [CI34691326605](https://github.com/bestkakkoii/LitraDock/actions/runs/34691326605). The operator-tool revision is separate. The frozen package still requires the original [DEMO.md](https://github.com/bestkakkoii/LitraDock/blob/cfd36dfa54acf5f1a0b870d467ebcfcb7136563a/DEMO.md) deployment conditions and [RECOVERY.md](https://github.com/bestkakkoii/LitraDock/blob/cfd36dfa54acf5f1a0b870d467ebcfcb7136563a/RECOVERY.md) recovery semantics. In the technical checkout those two files are under `deployment/private-candidate/`. Final review003 accepts the code/package within the two-identity clean-demo scope, not a public URL or full G4.

## 1. Retain a trusted code-only artifact

Obtain the accepted run's `hosted-verification-34691326605` artifact through the project-scoped GitHub account, before its retention expires, or use the already verified retained copy. Do not run a new biomedical workflow merely to refresh an artifact. Keep the package, complete file manifest, exact CI/source receipt and this procedure together. These SHA256 inputs must come from the accepted independent receipt, not from the candidate being checked:

| Artifact | SHA256 |
| --- | --- |
| `demo-candidate-linux-framework-dependent.tar.gz` | `1e385385217310681a86efe65f901b1a69cd9fb8b7a138d62ea270047da16d33` |
| `demo-package-hashes.txt` | `6cb0ea98300fe3369482636a331acb161f897090032bd8d463a46ccc90ec7d1e` |
| packaged `LitraDock.Hosted.dll` | `e16b7a28196c6b4fbfe77c19c9789800dbbc66c507371d57c242f4b8df2e0c97` |

```sh
python3 deployment/qualification/verify_deployment.py package \
  --archive /protected/reviewed/demo-candidate-linux-framework-dependent.tar.gz \
  --archive-sha256 1e385385217310681a86efe65f901b1a69cd9fb8b7a138d62ea270047da16d33 \
  --manifest /protected/reviewed/demo-package-hashes.txt \
  --manifest-sha256 6cb0ea98300fe3369482636a331acb161f897090032bd8d463a46ccc90ec7d1e \
  --output /protected/evidence/package-preflight.json
```

`/protected/...` denotes operator-selected existing private directories, not commands already executed or usable default host paths. Each output is a new file: overwrite is refused. The verifier streams the archive without extraction, bounds entries/expanded bytes, rejects special/link/traversal/duplicate/extra/missing files and verifies every hash, including the assembly. Digest equality proves correspondence to the trusted input, not publisher authenticity or a new signature. The artifact's 55 files do not include fixture hosts, private data or original papers.

After verified extraction/install under the stopped-service procedure, repeat package mode with `--installed /opt/literature/current` in place of `--archive` and `--archive-sha256`; this checks the exact installed file set. Do not modify packaged JavaScript or insert configuration/logs into its web content. Freeze updates and filesystem writers while checking; this is a point-in-time read, not protection from subsequent root changes. No source republication or package rebuild is needed for qualification tooling alone.

## 2. Establish a genuinely dedicated initial target

Before migration/invitation, the operator records a new database and protected object-root creation receipt, the actual host identity, service UID, intended database role, storage mounts and ownership. Keep host identifiers and private receipts off Git. Verify that the chosen database and directories are not a researcher library or another project. Use a dedicated role with no superuser/createdb/createrole/replication/bypass-RLS privileges or inherited role memberships, owning this database only; schema migration uses the existing frozen `--migrate` command. First change working directory to the installed package directory, then invoke `dotnet LitraDock.Hosted.dll --migrate`; use that working directory for all operator commands. Do not depend on appending `--contentRoot` after a valueless operator switch: the frozen command-line configuration can retain the caller content root, and private-path separation must still reject overlapping trees. A valid schema or a startup `VerifyDemo` result does not establish absence of inherited data.

Follow DEMO.md for separate real nonsymlink application, object and recovery directories, an unprivileged service account, protected configuration and loopback database. The application directory and its ancestors must be owned by a trusted operator/root, not the service, and not writable by group/other. Private object/recovery directories belong to the service with mode0700/0750 and trusted non-writable ancestors. Configuration is regular, single-link, root/service-owned mode0600 or stricter. Check extended ACLs, bind mounts, container volume mappings and unrelated web roots separately; POSIX bits alone cannot prove those boundaries. Do not stage a production deployment under world-writable `/tmp`.

Populate `service.env` with the actual operator, reachable support contact, retention/cleanup procedure and date, explicit-offset future expiry, HTTPS origin, `LITRADOCK_LOCAL_TEST=false`, `LITRADOCK_DEMO=true`, `LITRADOCK_PROXY_IP=127.0.0.1` and the frozen source SHA. Syntax/placeholder rejection is not proof these promises are true. The tool deliberately does not print config contents or their hash. Never include initial-login/password fields in persistent service configuration.

Run after migration but **before creating invited accounts or any saved work**:

```sh
python3 deployment/qualification/verify_deployment.py host \
  --manifest /protected/reviewed/demo-package-hashes.txt \
  --manifest-sha256 6cb0ea98300fe3369482636a331acb161f897090032bd8d463a46ccc90ec7d1e \
  --installed /opt/literature/current --config /etc/literature/service.env \
  --recovery /srv/literature-demo/recovery --service-uid ACTUAL_NUMERIC_SERVICE_UID \
  --source cfd36dfa54acf5f1a0b870d467ebcfcb7136563a \
  --database --initial --scope actual-host --output /protected/evidence/initial-host.json
```

Replace the UID with the verified numeric identity; the parser refuses the literal text. This optional DB probe uses the exact application's protected connection settings, only permits the reviewed loopback topology, excludes inherited PostgreSQL environment overrides, uses `psql -X --no-password`, sends the password only in the child environment and runs a read-only transaction with connection/statement/lock/process timeouts. No SQL data, credentials or raw failure output enters the report. Supported connection syntax is simple semicolon-separated Host/Port/Database/Username/Password/SSL Mode; quoted/escaped values or extra options produce BLOCKED instead of an unsafe guessed parse. Do not weaken an existing secret merely to fit this parser: record the unsupported syntax and use a separately reviewed protected probe.

The initial check requires schema4, a clear recovery guard, nonadministrative DB ownership, the exact known public table inventory, no unsupported manual/conversion work, no account/session/library/record/job/file/source-request history and an empty object directory. Repeat normal host mode without `--initial` after controlled invitations/workload; it preserves all data and explicitly does not prove initial cleanliness. Retain the initial creation/preflight receipt with subsequent service lifetime evidence. Arbitrary inherited database reuse is outside this procedure; validate every inherited identity/hash/grant/job before supporting such migration.

Exit0 means the requested automated checks passed **within the recorded scope**; `deploymentAcceptance` always remains `UNVERIFIED`. Exit2 means missing input, rejected state, inaccessible checks or report failure. Missing host arguments, Windows-only inspection, CI or isolated execution never grants target acceptance. Report categories QP01–07 state what was observed; QP08 retains the manual/actual target requirements below. Do not turn a static disk-free snapshot into a capacity pass.

## 3. Target HTTPS, proxy and account isolation procedure

Perform only after exact installed/configuration checks and an operator-controlled initial start. Record actual URL, timestamp, package/source/tool revisions, proxy/runtime/PG/browser versions and named test accounts as anonymous labels A/B. Use two newly invited nonpersonal acceptance accounts. Credentials stay in protected process input or browser password controls, never command arguments, screenshots, HAR exports, Git or a shared report. Do not use `curl -v`, dump environment or capture cookie-bearing raw logs.

| ID | Actual action and required evidence | Pass boundary |
| --- | --- | --- |
| QT01 | Run trusted `nginx -t`; inspect installed virtual host, certificate chain/hostname/expiry and an external HTTPS request with normal certificate verification. Verify loopback-only Kestrel/PG bindings and firewall/default virtual host. | Correct hostname/chain, no TLS bypass, no public backend/DB or wrong-host private response. Record safe summaries, not entire proxy configurations/private paths. |
| QT02 | Compare live `/service-info` and rendered source/privacy panel with protected actual operator/contact/retention/expiry and the accepted source. Test the contact channel and document the cleanup owner/date. | Exact deployed facts, no CI/operator placeholder, software source link correct; a valid JSON field is not proof of a working contact or cleanup. |
| QT03 | Login A and B in separate browser profiles; inspect only cookie attributes. Submit a harmless protected request with missing/wrong CSRF and a foreign Origin through an operator test client. | `__Host-LitraDock`, Secure, HttpOnly, Path=/, SameSite=Strict, no Domain; normal A works; wrong Origin/CSRF rejected without queuing jobs. A browser-generated SameSite omission alone is insufficient to test the server check. |
| QT04 | Obtain A's controlled original through the UI; make the identical protected file request without cookies and with B's own session. Logout A and repeat with its former session. Use stopped-service `--account-control revoke-sessions` for a further controlled A session, then retry. | A positive byte/hash matches; anonymous/revoked denied401, foreign denied404; B remains usable. No private response/body/token is copied to the report. Existing identity CI is baseline, not target proof. |
| QT05 | From two distinct controlled client IPs, make bounded failed logins against a nonexistent acceptance login: reach the first IP's10/minute window, then one request from B; repeat A with forged X-Forwarded-For. | A remains limited, B retains its own window, spoofed client header does not bypass it; proxy overwrites forwarding. Coordinate timing so an old window cannot explain a false pass. Never run this on real user credentials or a third-party login service. |
| QT06 | In one coordinated low-rate source session, use the original three-identifier query and two reviewed originals plus unavailable control; Save/open both XMLs and CSV ZIP. Record source request counters before/after. | Real IDs, hashes, CC BY4.0 grant/provenance, truthful XML/unavailable state, no fixture results. No concurrent biomedical tests or automatic reruns from missing evidence. |
| QT07 | On named actual Windows, macOS and mobile browsers/devices, operate search/selection/progress/Save/open/export and article-dialog Close/error controls, including narrow/high-DPI/keyboard use. | Each device is independently VERIFIED or UNVERIFIED; desktop viewport emulation and a syntactic download event do not prove device file opening/usability. |

There is no new automated HTTPS/account probe in this tool. Preserve the existing actual CI/browser test implementations as the baseline and use this bounded target procedure; inventing unavailable credentials, a live URL or a successful target request would defeat qualification.

## 4. Recovery, rollback, lifetime and capacity

Reuse the frozen app's `--operator-backup`, `--operator-restore` and guarded recovery from RECOVERY.md. Do not implement a second dump/restore path. `tests/recovery/pg_dump.sh` and `pg_restore.sh` are **CI Docker adapters**, not production backup commands. Invoke trusted PostgreSQL18 client executables under protected process configuration; secrets remain in child environment. Stop writers, take a new private database/object pair, verify completion/no INCOMPLETE marker, and restore only to another empty dedicated target. Never overwrite the running database/root. Keep the pair and earlier package until actual restore acceptance.

| ID | Required retained evidence | Missing evidence means |
| --- | --- | --- |
| QR01 | Actual paired backup/restore command exit, pair/dump/object hashes, guarded restore completion; compare controlled record/review/ID/original hashes and paused/cancelled jobs; copied sessions denied. | UNVERIFIED target disaster recovery, even if historical recovery109 passed. No private dump, paper bytes or password-bearing logs in public evidence. |
| QR02 | Stopped-service restart retains accepted IDs/hashes and pending states; deliberate pause remains paused; installed binary hash/source still match. | UNVERIFIED target persistence. |
| QR03 | Retained previous tested package and paired pre-upgrade state; rehearse rollback in a separate target, with ingress disabled if old code lacks current demo/privacy restrictions. | BLOCKED rollback readiness if no usable package/pair; no destructive down-migration claim. |
| QR04 | Actual cleanup owner/date, logs/backups retention, invitation lifetime, expiry denial and stopped ingress/service at end; retained-data handling follows the disclosed promise. | UNVERIFIED lifecycle/retention. Expiry does not delete data. |
| QC01 | Record filesystem mount/quota, `df` free bytes and private DB/object/recovery sizes before/after the named two-user workload; preserve low-disk failure behavior without filling a production disk. | A QP06 free-byte snapshot is only a dated measurement, not quota enforcement or capacity acceptance. |
| QC02 | Reuse `tests/recovery/measure.py` for a bounded target observation while two named acceptance users run the agreed workload; record interval, elapsed time, workload, category RSS, service/cgroup memory/CPU/PID limits and OOM/restart events. | No actual-host fit claim from CI category totals or the unmeasured approximately962MiB VPS specification. |

For example, on the actual Linux host, `python3 tests/recovery/measure.py /protected/evidence/target-rss.json -- sleep 300` observes the existing named workload for five minutes; it does not generate traffic. The sampler reads process comm/statm, not argv/env, and aggregates host-visible categories. Keep the workload separately recorded and exclude unrelated jobs or clearly disclose them. Category RSS can double-count shared pages, excludes kernel/cache/between-sample peaks and cannot isolate one app instance; inspect the actual systemd cgroup/current/peak counters and host available memory alongside it. The proposed768MiB app cap plus PostgreSQL/OS must fit actual headroom; measure or resize rather than treating configured limits as tested capacity. Do not launch the original live CI script against a target: it creates disposable accounts/DB and uses loopback fixture assumptions.

## 5. Evidence closure

Keep operator evidence in a private directory with mode0700; preflight JSON files are created0600 and never overwritten. Use stable QT/QR/QC IDs with outcome `VERIFIED`, `UNVERIFIED` or `BLOCKED`, UTC start/end, actual target/scope, exact source/package/tool revisions, command or interaction, observed result and safe evidence file SHA256. Retain raw confidential evidence privately; commit only reviewed sanitized summaries. Do not promote an imported report, CI sample, placeholder receipt or fixture data into a target pass. The tool does not accept external pass receipts as authority.

Agent2 integrates actual target results; Agent1 accepts the bounded invitation decision. Until host access/HTTPS, actual configuration, isolation, recovery/capacity and required device scope are established, deliver the verified code/package and this procedure with explicit blockers. Full G4, broad acquisition permissions, publisher-PDF fidelity and future commercial rights are separate requirements.
