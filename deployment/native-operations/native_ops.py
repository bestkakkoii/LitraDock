#!/usr/bin/env python3
"""Root-operated native recovery pairs. No HTTP/provider client or live restore path."""
import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import signal
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import uuid

MIB = 1024 * 1024
NAME = re.compile(r"backup-\d{8}T\d{6}Z-[0-9a-f]{32}\Z")
MEMBERS = {"database.dump", "runtime.tar", "runtime-manifest.json", "application.json", "snapshot.json"}


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for b in iter(lambda: stream.read(MIB), b""):
            h.update(b)
    return {"bytes": Path(path).stat().st_size, "sha256": h.hexdigest()}


def regular(path, limit):
    path = Path(path)
    require(not path.is_symlink() and stat.S_ISREG(path.stat().st_mode), "regular file required")
    require(path.stat().st_size <= limit, "file size limit")
    return path


def private_root(path):
    path = Path(path)
    require(path.is_absolute() and path != Path(path.anchor), "dedicated absolute root required")
    require(all(not p.is_symlink() for p in [path, *path.parents]), "symlink root refused")
    require(path.is_dir(), "operator must create dedicated root")
    s = path.stat()
    require(s.st_uid == 0 and not s.st_mode & 0o077, "root must be root-owned mode0700")
    return path


def protected(path):
    path = regular(path, MIB)
    s = path.stat()
    require(s.st_uid == 0 and not s.st_mode & 0o027, "protected root-owned file required")
    return path


def read_json(path):
    return json.loads(regular(path, MIB).read_text(encoding="utf-8"))


def utc(value):
    date = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(date.tzinfo is not None, "timezone required")
    return date.astimezone(dt.timezone.utc)


def write_json(path, value):
    with open(path, "x", encoding="utf-8") as f:
        json.dump(value, f, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())


def remaining(deadline, ceiling=60):
    result = min(ceiling, deadline - time.monotonic())
    require(result > 0, "operation deadline")
    return result


def sql(database, query, deadline):
    require(re.fullmatch(r"[a-z][a-z0-9_]{0,62}", database), "database name")
    r = subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-d", database],
                       input=query.encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=remaining(deadline, 10))
    require(r.returncode == 0 and len(r.stdout) < MIB, "database query failed")
    return r.stdout.decode().strip()


@contextlib.contextmanager
def fences(database, deadline):
    p = subprocess.Popen(["runuser", "-u", "postgres", "--", "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-d", database],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector()
    selector.register(p.stdout, selectors.EVENT_READ)
    try:
        for key in (724913010, 724913011, 724913003):
            p.stdin.write(("SELECT pg_try_advisory_lock(" + str(key) + ");\n").encode())
            p.stdin.flush()
            require(selector.select(remaining(deadline, 5)), "fence deadline")
            require(p.stdout.readline().strip() == b"t", "admission/source/capacity busy")
        yield
        require(p.poll() is None, "fence connection lost")
    finally:
        selector.close()
        p.stdin.close()
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait(timeout=3)


@contextlib.contextmanager
def operation_lock(root):
    import fcntl
    path = root / ".operations.lock"
    require(not path.is_symlink(), "lock symlink")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise Refused("another operation is active") from e
        yield
    finally:
        os.close(fd)


def usage(root):
    total = 0
    count = 0
    for base, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            p = Path(base) / name
            require(not p.is_symlink(), "unexpected symlink in recovery root")
            count += 1
            require(count <= 10000, "recovery entry limit")
        for name in files:
            total += regular(Path(base) / name, 512 * MIB).stat().st_size
    return total


def capacity(root, reserve=256 * MIB):
    # Reserve room for both staged members and final archive; no deletion to make space.
    require(usage(root) + reserve <= 512 * MIB, "recovery quota; inspect retained pairs/partials")
    require(shutil.disk_usage(root).free >= 512 * MIB + reserve, "insufficient free recovery space")


def verify_runtime(c, manifest):
    root = Path(c["runtime_directory"]).resolve(strict=True)
    require(manifest["source_revision"] == c["expected_source"], "runtime source mismatch")
    for name, want in manifest["files"].items():
        require(not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts, "runtime member path")
        path = regular(root / name, 64 * MIB)
        require(path.resolve().is_relative_to(root) and digest(path)["sha256"] == want, "installed runtime changed")
    archive = regular(c["runtime_archive"], 64 * MIB)
    require(digest(archive)["sha256"] == c["runtime_sha256"], "runtime archive changed")
    with tarfile.open(archive, "r:") as t:
        members = t.getmembers()
        require(len(members) == len(manifest["files"]) + 1 and len({m.name for m in members}) == len(members), "runtime member set")
        require({m.name for m in members} == set(manifest["files"]) | {"manifest.json"}, "runtime member mismatch")
        for m in members:
            require(m.isfile() and m.size <= 64 * MIB, "runtime member type/size")
            f = t.extractfile(m)
            if m.name == "manifest.json":
                require(m.size <= MIB and json.load(f) == manifest, "runtime manifest mismatch")
            else:
                h = hashlib.sha256()
                for b in iter(lambda: f.read(MIB), b""):
                    h.update(b)
                require(h.hexdigest() == manifest["files"][m.name], "runtime archive member changed")
    return archive


def dump(database, target, deadline):
    def limits():
        import resource
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * MIB, 64 * MIB))
    with open(target, "xb") as f:
        p = subprocess.Popen(["runuser", "-u", "postgres", "--", "pg_dump", "-Fc", database],
                             stdout=f, stderr=subprocess.DEVNULL, preexec_fn=limits, start_new_session=True)
        try:
            require(p.wait(timeout=remaining(deadline, 60)) == 0, "bounded database dump failed")
        finally:
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait(timeout=3)
        f.flush()
        os.fsync(f.fileno())
    require(regular(target, 64 * MIB).stat().st_size > 0, "empty dump")


def _verify_pair_contents(directory):
    directory = Path(directory)
    require(not directory.is_symlink() and directory.is_dir(), "pair directory")
    require({p.name for p in directory.iterdir()} == {"pair.tar", "complete.json"}, "incomplete or foreign pair members")
    receipt = read_json(directory / "complete.json")
    require(receipt["schema"] == 1 and receipt["state"] == "complete" and set(receipt["members"]) == MEMBERS, "pair receipt")
    utc(receipt["created_at"])
    archive = regular(directory / "pair.tar", 128 * MIB)
    require(digest(archive) == receipt["archive"], "pair checksum")
    with tarfile.open(archive, "r:") as t:
        members = t.getmembers()
        require(len(members) == len(MEMBERS) and {m.name for m in members} == MEMBERS, "pair archive members")
        for m in members:
            expected = receipt["members"][m.name]
            require(m.isfile() and m.size == expected["bytes"] and m.size <= 64 * MIB, "pair member size/type")
            with t.extractfile(m) as f:
                h = hashlib.sha256()
                for b in iter(lambda: f.read(MIB), b""):
                    h.update(b)
            require(h.hexdigest() == expected["sha256"], "pair member checksum")
    return receipt


def verify_pair(directory):
    directory = Path(directory)
    require(NAME.fullmatch(directory.name), "published pair name required")
    receipt = _verify_pair_contents(directory)
    require(directory.name[7:23] == utc(receipt["created_at"]).strftime("%Y%m%dT%H%M%SZ"),
            "backup name/date mismatch")
    return receipt


def prune(root, now):
    pairs = []
    for p in root.iterdir():
        if p.name.startswith("backup-"):
            require(NAME.fullmatch(p.name), "foreign backup name")
            r = verify_pair(p)
            created = utc(r["created_at"])
            require(created <= now, "future backup timestamp")
            require(p.name[7:23] == created.strftime("%Y%m%dT%H%M%SZ"), "backup name/date mismatch")
            pairs.append((created, p))
    pairs.sort(reverse=True)
    removed = 0
    for created, p in pairs[2:]:
        if now - created >= dt.timedelta(days=7):
            verify_pair(p)  # Recheck immediately before deletion; only exact two files.
            (p / "pair.tar").unlink()
            (p / "complete.json").unlink()
            p.rmdir()
            removed += 1
    return removed


def backup(c):
    os.umask(0o077)
    root = private_root(c["backup_root"])
    deadline = time.monotonic() + 150
    db = c["database"]
    require(re.fullmatch(r"[a-z][a-z0-9_]{0,62}", db), "database name")
    with operation_lock(root):
        config_path = protected(c["application_config"])
        app = read_json(config_path)
        fields = dict(x.split("=", 1) for x in shlex.split(app["Database"]))
        require(fields.get("dbname") == db and app["Revision"] == c["expected_application_revision"], "application database/revision mismatch")
        runtime = Path(c["runtime_directory"]).resolve(strict=True)
        manifest_path = regular(runtime / "manifest.json", MIB)
        manifest = read_json(manifest_path)
        archive = verify_runtime(c, manifest)
        capacity(root, 2 * (64 * MIB + archive.stat().st_size + 2 * MIB))
        stage = root / (".partial-" + uuid.uuid4().hex)
        stage.mkdir(mode=0o700)
        (stage / "INCOMPLETE").touch(mode=0o600)
        with fences(db, deadline):
            require(sql(db, "SELECT max(version) FROM native_schema", deadline) == str(c["expected_schema"]), "schema mismatch")
            require(sql(db, "SELECT required FROM ld_recovery_guard WHERE singleton=true", deadline) == "f", "recovery guard active")
            require(sql(db, "SELECT count(*) FROM ld_jobs WHERE state IN ('queued','running','scheduled')", deadline) == "0", "active jobs")
            require(sql(db, "SELECT count(*) FROM native_items WHERE state IN ('queued','running')", deadline) == "0", "active items")
            before = sql(db, "SELECT coalesce(sum(requests),0) FROM ld_source_usage", deadline)
            shutil.copyfile(config_path, stage / "application.json")
            shutil.copyfile(manifest_path, stage / "runtime-manifest.json")
            shutil.copyfile(archive, stage / "runtime.tar")
            dump(db, stage / "database.dump", deadline)
            require(before == sql(db, "SELECT coalesce(sum(requests),0) FROM ld_source_usage", deadline), "source counter changed")
            require(read_json(config_path) == app and Path(c["runtime_directory"]).resolve() == runtime, "deployment changed during capture")
            require(digest(stage / "runtime.tar")["sha256"] == c["runtime_sha256"], "copied runtime changed")
            write_json(stage / "snapshot.json", {"schema": c["expected_schema"], "source": c["expected_source"], "source_counter": before,
                                                "scope": "all native database data including original bytes and sessions; isolated restore must purge sessions and fence workers before use"})
        member_hashes = {n: digest(stage / n) for n in sorted(MEMBERS)}
        require(sum(v["bytes"] for v in member_hashes.values()) + 65536 <= 128 * MIB, "archive byte budget")
        with tarfile.open(stage / "pair.tar", "x:") as t:
            for n in sorted(MEMBERS):
                remaining(deadline)
                t.add(stage / n, arcname=n, recursive=False)
        with open(stage / "pair.tar", "rb") as f:
            os.fsync(f.fileno())
        now = dt.datetime.now(dt.timezone.utc)
        write_json(stage / "complete.json", {"schema": 1, "state": "complete", "created_at": now.isoformat(),
                                           "members": member_hashes, "archive": digest(stage / "pair.tar")})
        for n in MEMBERS | {"INCOMPLETE"}:
            (stage / n).unlink()
        _verify_pair_contents(stage)
        fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        remaining(deadline)
        destination = root / ("backup-" + now.strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex)
        os.rename(stage, destination)
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        removed = prune(root, now)
        return {"state": "complete", "pair": destination.name, "archive": digest(destination / "pair.tar"), "removed_expired_pairs": removed, "source_requests": 0}


def expiry(c, now=None, runner=subprocess.run):
    app = read_json(protected(c["application_config"]))
    now = now or dt.datetime.now(dt.timezone.utc)
    due = utc(app["Expires"])
    if now < due:
        return {"state": "not_due", "expires": due.isoformat(), "mutated": False}
    command = c["expiry_command"]
    require(isinstance(command, list) and len(command) == 2 and all(isinstance(x, str) and Path(x).is_absolute() for x in command), "pinned expiry command required")
    for path in command:
        s = regular(path, 64 * MIB).stat()
        require(s.st_uid == 0 and not s.st_mode & 0o022, "expiry executable/script permissions")
    r = runner(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
    require(r.returncode == 0, "native manager expiry failed")
    return {"state": "due_manager_called", "expires": due.isoformat(), "mutated": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["backup", "expiry", "verify"])
    parser.add_argument("--config")
    parser.add_argument("--pair")
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, "root-operated private tool")
        if args.action == "verify":
            result = verify_pair(Path(args.pair))
        else:
            c = read_json(protected(args.config))
            result = backup(c) if args.action == "backup" else expiry(c)
        print(json.dumps(result))
        return 0
    except Exception as e:
        # Do not echo config, SQL, environment, child stderr or credential-bearing errors.
        reason = str(e) if isinstance(e, Refused) else type(e).__name__
        print(json.dumps({"state": "refused", "reason": reason}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
