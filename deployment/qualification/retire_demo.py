"""Dated, stopped-service retirement of one explicitly registered disposable pilot.

Root-only Linux operation. Never delete from an inferred name or an expired
environment value alone. Registration binds the original database OID and fixed
dedicated storage root; state permits safe retry after partial retirement.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

spec = importlib.util.spec_from_file_location("qualification", Path(__file__).with_name("verify_deployment.py"))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)
DATA_ROOT = Path("/srv/literature-demo")
SERVICE = "literature-demo.service"


def validate(policy, now):
    q.require(re.fullmatch(r"deployment[0-9]{3}-[0-9]{8}", policy.get("id", "")) is not None,
              "Registered deployment identity required.")
    q.require(re.fullmatch(r"literature_demo_[0-9]{8}", policy.get("database", "")) is not None
              and policy.get("role") == "literature_demo", "Dedicated pilot database identity required.")
    q.require(type(policy.get("databaseOid")) is int and policy["databaseOid"] > 0,
              "Original database OID required.")
    q.require(policy.get("dataRoot") == str(DATA_ROOT), "Dedicated storage root differs.")
    dates = [datetime.fromisoformat(policy[name]) for name in ("createdAt", "expiresAt", "deleteAfter")]
    q.require(all(x.tzinfo is not None for x in dates), "Explicit timezone required.")
    q.require(dates[0] < dates[1] < dates[2] and dates[2] - dates[0] <= timedelta(days=30),
              "Bounded ordered pilot dates required.")
    q.require(now >= dates[2], "Retirement is not due.")
    return hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest()


def inspect_storage():
    import pwd
    root = q.no_links(DATA_ROOT)
    q.require(root.is_dir(), "Dedicated storage root is missing.")
    uid = pwd.getpwnam("literature").pw_uid
    q.require(root.stat().st_uid == uid and not root.stat().st_mode & 0o077,
              "Private service-owned storage root required.")
    for parent in root.parents:
        info = parent.stat()
        q.require(info.st_uid == 0 and not info.st_mode & 0o022, "Untrusted storage ancestor.")
    q.require(set(x.name for x in root.iterdir()) <= {"objects", "recovery"}, "Unexpected dedicated-root content.")
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            item = q.no_links(Path(parent) / name)
            s = item.stat()
            q.require(stat.S_ISDIR(s.st_mode) or (stat.S_ISREG(s.st_mode) and s.st_nlink == 1),
                      "Linked or special retirement content rejected.")


def command(args, data=None):
    r = subprocess.run(args, input=data, capture_output=True, text=True, timeout=90,
                       env={"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C.UTF-8"})
    q.require(r.returncode == 0, "Retirement operation failed; no raw child output disclosed.")
    return r.stdout.strip()


def sql(statement):
    return command(["/usr/sbin/runuser", "-u", "postgres", "--", "/usr/lib/postgresql/18/bin/psql",
                    "-X", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement])


def service_processes(output, uid):
    # Numeric IDs avoid ps truncating long login names (for example literature).
    rows = [line.split() for line in output.splitlines() if line.strip()]
    q.require(all(len(row) == 2 and all(value.isascii() and value.isdigit() for value in row) for row in rows),
              "Process identity output is invalid.")
    return any(int(row[0]) == uid for row in rows)


def retire(config, apply=False):
    q.require(os.name == "posix" and os.geteuid() == 0, "Linux administrator required.")
    config = q.protected_file(config, 0)
    policy = json.loads(config.read_text())
    binding = validate(policy, datetime.now(timezone.utc))
    inspect_storage()
    if not apply:
        return {"status": "DUE", "mutation": False, "databaseAndProcessChecks": "NOT_PERFORMED"}
    import fcntl
    lock = q.no_links(config.parent / "retirement.lock")
    with os.fdopen(os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "w") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = q.no_links(config.parent / "retirement-state.json")
        state = {"binding": binding, "phase": "registered"}
        if state_path.exists():
            q.protected_file(state_path, 0)
            state = json.loads(state_path.read_text())
            q.require(state.get("binding") == binding, "Retirement registration changed.")
        def save(phase):
            state["phase"] = phase
            temp = config.parent / "retirement-state.next"
            if temp.exists():
                q.protected_file(temp, 0)
                q.require(json.loads(temp.read_text()).get("binding") == binding,
                          "Interrupted state belongs to another registration.")
                temp.unlink()
            q.save_report(temp, state)
            os.replace(temp, state_path)
        if state["phase"] == "complete":
            q.require(not any((DATA_ROOT / name).exists() for name in ("objects", "recovery"))
                      and not any((config.parent / name).exists() for name in ("service.env", "invitations.json"))
                      and sql("SELECT oid FROM pg_database WHERE datname='" + policy["database"] + "'") == "",
                      "Retired target has new state; separate registration required.")
            return {"status": "RETIRED", "repeated": True}
        command(["systemctl", "stop", SERVICE])
        # A stopped systemd unit does not establish absence of external operator children.
        import pwd
        active = command(["ps", "-eo", "uid=,pid="])
        q.require(not service_processes(active, pwd.getpwnam("literature").pw_uid),
                  "Service-user processes remain; retirement refused.")
        inspect_storage()
        db = policy["database"]  # strictly validated ASCII identifier, never a credential
        actual = sql("SELECT oid::text || '|' || pg_get_userbyid(datdba) FROM pg_database WHERE datname='" + db + "'")
        q.require(actual == str(policy["databaseOid"]) + "|literature_demo"
                  or (actual == "" and state["phase"] in {"deleting", "database-removed"}),
                  "Database was replaced or is unexpectedly absent.")
        save("deleting")
        if actual:
            sql("ALTER DATABASE " + db + " ALLOW_CONNECTIONS false")
            sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='" + db + "'")
            sql("DROP DATABASE " + db)
        save("database-removed")
        for name in ("objects", "recovery"):
            target = q.no_links(DATA_ROOT / name)
            if target.exists():
                shutil.rmtree(target)
        for name in ("service.env", "invitations.json"):
            target = config.parent / name
            if target.exists():
                q.protected_file(target, 0).unlink()
        save("complete")
        return {"status": "RETIRED", "databaseRemoved": True, "serverObjectsAndRecoveryRemoved": True}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()
    try:
        print(json.dumps(retire(args.config, args.apply), sort_keys=True))
    except Exception:
        print(json.dumps({"status": "BLOCKED", "reason": "Retirement guard or operation failed; inspect private state."}))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
