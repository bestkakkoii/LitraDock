"""Read-only operator qualification; never deploy, restore, fetch papers, or print secrets.

Python 3.11+ standard library. Trusted package digests are an operator input, not
a signature or authorization claim. See PROCEDURE.md for remaining live gates.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile

MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
HASH = re.compile(r"[0-9a-f]{64}")
REQUIRED_FILES = {"LitraDock.Hosted.dll", "wwwroot/hosted.js", "LICENSE", "DEMO.md"}


class Rejected(Exception):
    """Only fixed, non-sensitive messages are passed to this exception."""


def require(condition, message):
    if not condition:
        raise Rejected(message)


def digest(path, limit=MAX_TOTAL):
    require(path.stat().st_size <= limit, "File exceeds verification byte bound.")
    with path.open("rb") as stream:
        return stream_digest(stream, limit)[0]


def stream_digest(stream, limit):
    result, size = hashlib.sha256(), 0
    while block := stream.read(1024 * 1024):
        size += len(block)
        require(size <= limit, "Stream exceeds verification byte bound.")
        result.update(block)
    return result.hexdigest(), size


def no_links(path):
    path = Path(os.path.abspath(path))
    for entry in [*reversed(path.parents), path]:
        require(not entry.is_symlink() and not getattr(entry, "is_junction", lambda: False)(),
                "Linked paths are not eligible for qualification.")
    return path


def safe_name(name):
    require(bool(name) and "\\" not in name and not name.startswith("/")
            and all(part not in {"", ".", ".."} for part in name.split("/"))
            and ":" not in name, "Unsafe package member name.")
    require(not any(word in name.lower() for word in
                    ("fixture", "browserhost", "verification", "private/", ".env", "saved-original")),
            "Fixture or private-content package path rejected.")
    return name


def read_manifest(path, expected_hash):
    path = no_links(path)
    require(HASH.fullmatch(expected_hash) is not None, "Expected manifest digest is required.")
    require(digest(path, 1024 * 1024) == expected_hash, "Manifest digest does not match trusted input.")
    rows = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split("  ", 1)
        require(len(parts) == 2 and HASH.fullmatch(parts[0]), "Invalid package hash manifest.")
        require(parts[1].startswith(".litradock/demo-package/"), "Unexpected package manifest root.")
        name = safe_name(parts[1].removeprefix(".litradock/demo-package/"))
        require(name not in rows, "Duplicate package manifest member.")
        rows[name] = parts[0]
    require(REQUIRED_FILES <= rows.keys() and len(rows) <= 512, "Required production package files missing or count exceeded.")
    return rows


def verify_archive(path, expected_hash, rows):
    path = no_links(path)
    require(HASH.fullmatch(expected_hash) is not None and digest(path) == expected_hash,
            "Archive digest does not match trusted input.")
    seen, total = set(), 0
    # 僅串流檢查，不將封存內容解壓至任何目標目錄。
    with tarfile.open(path, "r|gz") as archive:
        for index, member in enumerate(archive):
            require(index < 1024, "Archive entry count exceeded.")
            if member.name in {".", "./"} and member.isdir():
                continue
            name = safe_name(member.name.removeprefix("./").rstrip("/") if member.isdir()
                             else member.name.removeprefix("./"))
            require(member.isfile() or member.isdir(), "Links and special archive entries rejected.")
            if member.isdir():
                require(any(item.startswith(name + "/") for item in rows), "Unexpected archive directory.")
                continue
            require(name in rows and name not in seen, "Extra or duplicate package member.")
            require(0 <= member.size <= MAX_FILE, "Package member byte bound exceeded.")
            total += member.size
            require(total <= MAX_TOTAL, "Expanded package byte bound exceeded.")
            actual, size = stream_digest(archive.extractfile(member), MAX_FILE)
            require(size == member.size and actual == rows[name], "Package file hash mismatch.")
            seen.add(name)
    require(seen == rows.keys(), "Package file set is incomplete.")
    return {"files": len(seen), "bytes": total, "assemblySha256": rows["LitraDock.Hosted.dll"]}


def verify_installed(directory, rows, service_uid=None):
    directory = no_links(directory)
    require(directory.is_dir(), "Installed application directory is missing.")
    found = set()
    for parent, directories, files in os.walk(directory, followlinks=False):
        for name in directories + files:
            item = no_links(Path(parent) / name)
            info = item.stat()
            require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), "Special installed entry rejected.")
            require(not stat.S_ISREG(info.st_mode) or info.st_nlink == 1, "Hard-linked installed file rejected.")
            if service_uid is not None:
                require(info.st_uid != service_uid and not info.st_mode & 0o022,
                        "Installed code must not be owned by service or writable by group/other.")
        for name in files:
            path = Path(parent) / name
            relative = safe_name(path.relative_to(directory).as_posix())
            require(relative in rows and digest(path, MAX_FILE) == rows[relative], "Installed file set or hash mismatch.")
            found.add(relative)
    require(found == rows.keys(), "Installed application file set is incomplete.")
    if service_uid is not None:
        # 上層可寫入亦可能替換整個部署目錄；驗證時要求停止更新且檔案系統無其他寫入者。
        for path in [directory, *directory.parents]:
            info = path.stat()
            require(info.st_uid != service_uid and not info.st_mode & 0o022,
                    "Application ancestor allows replacement by service or group/other.")
    return {"files": len(found), "assemblySha256": rows["LitraDock.Hosted.dll"]}


def protected_file(path, service_uid):
    path = no_links(path)
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid in {0, service_uid}
            and not info.st_mode & 0o077, "Protected configuration must be regular, owned by root/service and mode0600 or stricter.")
    for parent in path.parents:
        parent_info = parent.stat()
        require(parent_info.st_uid in {0, service_uid} and not parent_info.st_mode & 0o022,
                "Configuration ancestor permits untrusted replacement.")
    require(info.st_size <= 65536, "Protected configuration size exceeded.")
    return path


def read_environment(path):
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition("=")
        require(separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key) and key not in values,
                "Invalid or duplicate environment field.")
        # 明確支援單行 literal 值，不 eval、展開變數或執行 shell。
        if value[:1] in {"'", '"'}:
            require(len(value) >= 2 and value[-1] == value[0], "Unsupported environment quoting.")
            value = value[1:-1]
        require("\x00" not in value and "\\" not in value and "\n" not in value,
                "Unsupported environment escaping.")
        values[key] = value
    return values


def validate_environment(values, revision, now=None):
    require(re.fullmatch(r"[0-9a-f]{40}", revision) is not None, "Exact reviewed source revision required.")
    for key in ("LITRADOCK_DEMO_OPERATOR", "LITRADOCK_DEMO_CONTACT", "LITRADOCK_DEMO_RETENTION"):
        value = values.get(key, "")
        require(bool(value.strip()) and len(value) <= 500 and not re.search(
            r"required|placeholder|synthetic|example\.|test\.invalid|disposable ci", value, re.I),
            "Operator/contact/retention contains missing or placeholder content.")
    require(values.get("LITRADOCK_DEMO") == "true" and values.get("LITRADOCK_LOCAL_TEST") == "false"
            and values.get("LITRADOCK_SOURCE_REVISION") == revision, "Demo mode, production mode or source revision mismatch.")
    require(not any(key in values for key in ("LITRADOCK_INITIAL_LOGIN", "LITRADOCK_INITIAL_PASSWORD")),
            "Remove initial-account credentials from persistent service configuration.")
    expiry = values.get("LITRADOCK_DEMO_EXPIRES", "")
    require(re.fullmatch(r"\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})", expiry), "Explicit-offset expiry required.")
    try:
        instant = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
    except ValueError:
        raise Rejected("Invalid expiry timestamp.") from None
    require(instant > (now or datetime.now(timezone.utc)), "Demo expiry has passed.")
    origin = values.get("LITRADOCK_ORIGIN", "")
    require(re.fullmatch(r"https://[a-zA-Z0-9.-]+(?::443)?", origin) and "." in origin
            and not re.search(r"required|example\.|localhost|127\.0\.0\.1|\.invalid", origin, re.I),
            "Actual project HTTPS origin required.")
    require(values.get("LITRADOCK_PROXY_IP") == "127.0.0.1", "Reviewed same-host proxy address required.")
    require(Path(values.get("LITRADOCK_OBJECTS", "")).is_absolute(), "Absolute dedicated object directory required.")
    return {"explicitExpiryValid": True, "sourceRevisionMatches": True,
            "operatorValuesPresent": True, "operatorPromisesVerified": False}


def private_paths(config, objects, recovery, installed, service_uid):
    paths = [no_links(item) for item in (objects, recovery, installed)]
    for index, first in enumerate(paths):
        require(first.is_dir(), "A required dedicated directory is missing.")
        for second in paths[index + 1:]:
            require(first != second and first not in second.parents and second not in first.parents,
                    "Application, object and recovery directories must not overlap.")
    require(not any(paths[2] == p or paths[2] in p.parents for p in [no_links(config), *paths[:2]]),
            "Private configuration/storage cannot be in installed content.")
    for path in paths[:2]:
        info = path.stat()
        require(info.st_uid == service_uid and not info.st_mode & 0o027,
                "Private directories must belong to the service and exclude group-write/other access.")
        for parent in path.parents:
            parent_info = parent.stat()
            require(parent_info.st_uid in {0, service_uid} and not parent_info.st_mode & 0o022,
                    "Private directory ancestor permits untrusted replacement.")
    return {"separatePrivateDirectories": True, "posixModesChecked": True,
            "aclAndMountIsolationVerified": False}


def database_settings(connection):
    require(not any(c in connection for c in "'\"\n\r\\"), "Complex database connection syntax requires separate operator review.")
    fields = {}
    for entry in connection.split(";"):
        if not entry:
            continue
        key, separator, value = entry.partition("=")
        key = key.strip().lower()
        require(separator and key not in fields, "Invalid database connection field.")
        fields[key] = value.strip()
    require(set(fields) <= {"host", "port", "database", "username", "password", "ssl mode", "maximum pool size"},
            "Unsupported database connection options require operator review.")
    if "maximum pool size" in fields:
        pool = fields["maximum pool size"]
        require(pool.isascii() and pool.isdecimal() and 1 <= int(pool) <= 20,
                "Reviewed application pool size must be an integer from1 through20.")
    require(fields.get("host") in {"127.0.0.1", "::1", "localhost"}, "Only the reviewed loopback database is probed.")
    require(fields.get("ssl mode", "prefer").lower() == "disable", "This probe is limited to explicit loopback database configuration.")
    require(all(fields.get(key) for key in ("database", "username", "password")), "Database identity/credential fields missing.")
    require(not any(word in fields["database"].lower() for word in ("required", "template"))
            and fields["database"] != "postgres", "Dedicated application database required.")
    port = fields.get("port", "5432")
    require(port.isdecimal() and 0 < int(port) < 65536, "Invalid database port.")
    return {"PGHOST": fields["host"], "PGPORT": port, "PGDATABASE": fields["database"],
            "PGUSER": fields["username"], "PGPASSWORD": fields["password"], "PGSSLMODE": "disable"}


SCHEMA_TABLES = ('ld_accounts', 'ld_article_files', 'ld_batches', 'ld_citations', 'ld_conversion_events', 'ld_conversions', 'ld_derivations', 'ld_events', 'ld_files', 'ld_health', 'ld_health_scans', 'ld_identifiers', 'ld_items', 'ld_jobs', 'ld_legacy_rows', 'ld_libraries', 'ld_manual_inputs', 'ld_members', 'ld_object_provenance', 'ld_projects', 'ld_publications', 'ld_records', 'ld_recovery_guard', 'ld_results', 'ld_retry', 'ld_review_events', 'ld_reviews', 'ld_runs', 'ld_schema', 'ld_scopes', 'ld_sessions', 'ld_source_budget', 'ld_source_usage', 'ld_transfer_attempts', 'ld_transfers')

DB_SQL = """BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object(
'schema',(SELECT max(version) FROM public.ld_schema),
'readOnly',current_setting('transaction_read_only')='on',
'superuser',(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid)
 FROM pg_roles WHERE rolname=current_user),
'databaseOwner',(SELECT pg_get_userbyid(datdba)=current_user FROM pg_database WHERE datname=current_database()),
'guard',(SELECT bool_or(required) FROM public.ld_recovery_guard),
'manual',(SELECT count(*) FROM public.ld_manual_inputs),
'conversions',(SELECT count(*) FROM public.ld_conversions),
'accounts',(SELECT count(*) FROM public.ld_accounts),
'sessions',(SELECT count(*) FROM public.ld_sessions),
'libraries',(SELECT count(*) FROM public.ld_libraries),
'records',(SELECT count(*) FROM public.ld_records),
'jobs',(SELECT count(*) FROM public.ld_jobs),
'files',(SELECT count(*) FROM public.ld_files),
'sourceRequests',(SELECT coalesce(sum(requests),0) FROM public.ld_source_usage),
'relations',(SELECT coalesce(json_agg(json_build_array(n.nspname,c.relname,c.relkind) ORDER BY n.nspname,c.relname),'[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname <> 'information_schema' AND left(n.nspname,3) <> 'pg_' AND c.relkind IN ('r','p','v','m','f')),
'postgres',current_setting('server_version_num'));
ROLLBACK;"""


def validate_database(data, initial):
    require(data.get("schema") == 4 and data.get("readOnly") is True and data.get("guard") is False,
            "Database schema, read-only probe or recovery guard check failed.")
    require(data.get("superuser") is False and data.get("databaseOwner") is True,
            "Dedicated database owner must have no cluster administration privileges.")
    require(data.get("manual") == 0 and data.get("conversions") == 0,
            "Database contains unsupported demo work.")
    require(data.get("relations") == [["public", name, "r"] for name in sorted(SCHEMA_TABLES)],
            "Database relation inventory differs from the reviewed schema.")
    require(str(data.get("postgres", "")).startswith("18"), "Reviewed PostgreSQL major version required.")
    if initial:
        require(all(data.get(key) == 0 for key in ("accounts", "sessions", "libraries", "records", "jobs", "files", "sourceRequests")),
                "Initial demo qualification requires an empty application database.")
    return {"schema": 4, "readOnly": True, "initialEmptyChecked": initial,
            "dedicationHistoryVerified": False, "postgresVersionNumber": data["postgres"]}


def probe_database(values, initial, executable="psql"):
    settings = database_settings(values.get("LITRADOCK_POSTGRES", ""))
    environment = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR", "LANG") if key in os.environ}
    environment.update(settings)
    environment.update(PGCONNECT_TIMEOUT="5", PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000")
    # 密碼只傳至受信任子程序的環境，不進 argv、stdout 或錯誤報告。
    result = subprocess.run([executable, "-X", "-q", "-A", "-t", "--no-password", "-v", "ON_ERROR_STOP=1", "-c", DB_SQL],
                            env=environment, capture_output=True, text=True, timeout=15,
                            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
    require(result.returncode == 0 and len(result.stdout) <= 8192, "Read-only database probe failed; inspect protected operator diagnostics separately.")
    return validate_database(json.loads(result.stdout), initial)


def add_check(report, identifier, action):
    try:
        evidence = action()
        report["checks"].append({"id": identifier, "status": "VERIFIED", "evidence": evidence})
    except Rejected as error:
        report["checks"].append({"id": identifier, "status": "BLOCKED", "reason": str(error)})
    except Exception as error:
        report["checks"].append({"id": identifier, "status": "BLOCKED", "reason": "Inspection failed: " + type(error).__name__})


def save_report(path, report):
    path = no_links(path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags, 0o600), "w", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("package", "host"))
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--archive-sha256")
    parser.add_argument("--installed", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--recovery", type=Path)
    parser.add_argument("--service-uid", type=int)
    parser.add_argument("--source")
    parser.add_argument("--database", action="store_true", help="Opt in to bounded read-only loopback PostgreSQL queries.")
    parser.add_argument("--initial", action="store_true")
    parser.add_argument("--scope", choices=("isolated", "actual-host"), default="isolated")
    args = parser.parse_args(argv)
    report = {"format": "literature.deployment.preflight.v1", "observedAtUtc": datetime.now(timezone.utc).isoformat(),
              "mode": args.mode, "scope": "isolated-ci" if os.environ.get("CI") else args.scope, "platform": sys.platform, "toolSha256": digest(Path(__file__)), "checks": [],
              "deploymentAcceptance": "UNVERIFIED", "limitations": [
                  "No imported receipt or CI sample can establish target-host acceptance.",
                  "TLS/proxy/origin/account isolation, actual device Save, backup/restore/rollback, ACL/mount isolation and sustained RSS/disk require PROCEDURE.md target evidence."]}
    rows = {}
    def manifest_check():
        rows.update(read_manifest(args.manifest, args.manifest_sha256))
        return {"files": len(rows), "manifestSha256": args.manifest_sha256}
    add_check(report, "QP01-trusted-manifest", manifest_check)
    if rows:
        if args.archive:
            add_check(report, "QP02-archive", lambda: verify_archive(args.archive, args.archive_sha256 or "", rows))
        if args.installed:
            add_check(report, "QP03-installed", lambda: verify_installed(args.installed, rows,
                      args.service_uid if args.mode == "host" and sys.platform == "linux" else None))
    if args.mode == "package":
        if not args.archive and not args.installed:
            report["checks"].append({"id": "QP02-package-input", "status": "BLOCKED", "reason": "Archive or installed directory required."})
    else:
        if sys.platform != "linux" or not all([args.config, args.installed, args.recovery, args.source]) or args.service_uid is None or args.service_uid <= 0:
            report["checks"].append({"id": "QP04-host-inputs", "status": "BLOCKED", "reason": "Linux, protected config, installed/recovery paths, unprivileged UID and exact source are required."})
        else:
            values = {}
            def configuration():
                path = protected_file(args.config, args.service_uid)
                candidate = read_environment(path)
                result = validate_environment(candidate, args.source)
                values.update(candidate)
                return result
            add_check(report, "QP04-configuration", configuration)
            if values:
                objects = Path(values.get("LITRADOCK_OBJECTS", ""))
                add_check(report, "QP05-private-paths", lambda: private_paths(args.config, objects, args.recovery, args.installed, args.service_uid))
                if args.initial:
                    def empty_objects():
                        require(not any(objects.iterdir()), "Initial deployment requires a new empty object directory.")
                        return {"initialObjectsEmpty": True}
                    add_check(report, "QP05-initial-objects", empty_objects)
                add_check(report, "QP06-disk-snapshot", lambda: {"objectsFreeBytes": shutil.disk_usage(objects).free,
                          "recoveryFreeBytes": shutil.disk_usage(args.recovery).free, "capacityAccepted": False})
                if args.database:
                    add_check(report, "QP07-read-only-database", lambda: probe_database(values, args.initial))
        if not args.database:
            report["checks"].append({"id": "QP07-read-only-database", "status": "BLOCKED", "reason": "Database probe not requested; no database qualification inferred."})
        report["checks"].append({"id": "QP08-target-acceptance", "status": "UNVERIFIED", "reason":
            "Isolated/CI execution is not an actual target." if args.scope != "actual-host" or os.environ.get("CI") else
            "Read-only checks do not verify actual operator promises, isolation, restore, workload capacity or devices."})
    blocked = any(item["status"] == "BLOCKED" for item in report["checks"])
    report["automatedChecks"] = "BLOCKED" if blocked else "VERIFIED"
    save_report(args.output, report)
    print(json.dumps({"automatedChecks": report["automatedChecks"], "deploymentAcceptance": "UNVERIFIED", "checks": len(report["checks"])}))
    return 2 if blocked else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"automatedChecks": "BLOCKED", "reason": "Report/input failure: " + type(error).__name__}), file=sys.stderr)
        sys.exit(2)
