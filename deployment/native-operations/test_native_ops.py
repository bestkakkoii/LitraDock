"""Isolated synthetic files/faults. Actual PostgreSQL/restore proof is separate."""
import contextlib
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_ops", Path(__file__).with_name("native_ops.py"))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class Controls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.root.chmod(0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def pair(self, days=0, suffix=None):
        import uuid
        now = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
        d = self.root / ("backup-" + now.strftime("%Y%m%dT%H%M%SZ-") + (suffix or uuid.uuid4().hex))
        d.mkdir()
        members = {}
        for n in ops.MEMBERS:
            f = self.root / ("synthetic-" + n)
            f.write_bytes(("EXPLICIT SYNTHETIC " + n).encode())
            members[n] = ops.digest(f)
        with tarfile.open(d / "pair.tar", "w:") as t:
            for n in sorted(ops.MEMBERS):
                t.add(self.root / ("synthetic-" + n), arcname=n)
        for n in ops.MEMBERS:
            (self.root / ("synthetic-" + n)).unlink()
        ops.write_json(d / "complete.json", {"schema": 1, "state": "complete", "created_at": now.isoformat(), "members": members, "archive": ops.digest(d / "pair.tar")})
        return d

    def test_pair_integrity_and_negative_members(self):
        d = self.pair()
        self.assertEqual(ops.verify_pair(d)["state"], "complete")
        b = (d / "pair.tar").read_bytes()
        (d / "pair.tar").write_bytes(b[:-100])
        with self.assertRaises(ops.Refused): ops.verify_pair(d)
        (d / "pair.tar").write_bytes(b)
        (d / "unexpected").touch()
        with self.assertRaises(ops.Refused): ops.verify_pair(d)
        (d / "unexpected").unlink()
        (d / "complete.json").unlink()
        with self.assertRaises(ops.Refused): ops.verify_pair(d)

    def test_independent_archive_member_hash(self):
        d = self.pair()
        r = ops.read_json(d / "complete.json")
        r["members"]["database.dump"]["sha256"] = "0" * 64
        (d / "complete.json").write_text(json.dumps(r))
        with self.assertRaises(ops.Refused): ops.verify_pair(d)

    def test_unpublished_complete_contents_are_not_a_recovery_pair(self):
        published = self.pair()
        expected = ops.verify_pair(published)
        for name in [".partial-" + "a" * 32, "foreign-evidence"]:
            unpublished = published.with_name(name)
            published.rename(unpublished)
            self.assertEqual(ops._verify_pair_contents(unpublished), expected)
            with self.assertRaises(ops.Refused): ops.verify_pair(unpublished)
            unpublished.rename(published)
        self.assertEqual(ops.verify_pair(published), expected)

    def test_retention_keeps_two_and_refuses_foreign_pair(self):
        old = self.pair(10)
        keep = [self.pair(9), self.pair(8)]
        self.assertEqual(ops.prune(self.root, dt.datetime.now(dt.timezone.utc)), 1)
        self.assertFalse(old.exists())
        self.assertTrue(all(x.exists() for x in keep))
        foreign = self.root / "backup-foreign"
        foreign.mkdir()
        with self.assertRaises(ops.Refused): ops.prune(self.root, dt.datetime.now(dt.timezone.utc))
        self.assertTrue(all(x.exists() for x in keep))

    def test_future_or_mismatched_date_is_not_deleted(self):
        d = self.pair(10)
        self.pair(9); self.pair(8)
        r = ops.read_json(d / "complete.json")
        r["created_at"] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).isoformat()
        (d / "complete.json").write_text(json.dumps(r))
        with self.assertRaises(ops.Refused): ops.prune(self.root, dt.datetime.now(dt.timezone.utc))
        self.assertTrue(d.exists())

    def test_quota_and_disk_fail_without_deletion(self):
        d = self.pair()
        before = ops.digest(d / "pair.tar")
        with patch.object(ops, "usage", return_value=300 * ops.MIB):
            with self.assertRaises(ops.Refused): ops.capacity(self.root)
        with patch.object(ops.shutil, "disk_usage", return_value=shutil._ntuple_diskusage(1, 1, 0)):
            with self.assertRaises(ops.Refused): ops.capacity(self.root)
        self.assertEqual(before, ops.digest(d / "pair.tar"))

    @unittest.skipIf(os.name == "nt", "POSIX lock and symlink control executes on isolated Linux")
    def test_symlink_and_local_lock_contention(self):
        target = self.pair()
        (self.root / "foreign-link").symlink_to(target, target_is_directory=True)
        with self.assertRaises(ops.Refused): ops.usage(self.root)
        (self.root / "foreign-link").unlink()
        with ops.operation_lock(self.root):
            with self.assertRaises(ops.Refused):
                with ops.operation_lock(self.root): pass

    def test_expiry_due_not_due_and_manager_failure(self):
        f = self.root / "app.json"
        f.write_text(json.dumps({"Expires": "2030-01-01T00:00:00Z"}))
        c = {"application_config": str(f), "expiry_command": [str(f), str(f)]}
        calls = []
        def run(*args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0)
        with patch.object(ops, "protected", side_effect=Path):
            result = ops.expiry(c, dt.datetime(2029, 1, 1, tzinfo=dt.timezone.utc), run)
            self.assertFalse(result["mutated"]); self.assertEqual(calls, [])
            # Permissions are separately exercised on Linux; this is an isolated manager.
            f.chmod(0o600)
            with patch.object(ops, "regular") as reg:
                reg.return_value.stat.return_value.st_uid = 0
                reg.return_value.stat.return_value.st_mode = 0o100600
                with patch.object(ops, "read_json", return_value={"Expires": "2030-01-01T00:00:00Z"}):
                    self.assertTrue(ops.expiry(c, dt.datetime(2030, 1, 1, tzinfo=dt.timezone.utc), run)["mutated"])
                    self.assertEqual(len(calls), 1)
                    with self.assertRaises(ops.Refused):
                        ops.expiry(c, dt.datetime(2030, 1, 1, tzinfo=dt.timezone.utc), lambda *a, **k: subprocess.CompletedProcess(a, 1))

    def test_deadline_and_timezone(self):
        with self.assertRaises(ops.Refused): ops.remaining(0)
        with self.assertRaises(ops.Refused): ops.utc("2030-01-01T00:00:00")

    @unittest.skipIf(os.name == "nt", "POSIX atomic publication/fsync executes on isolated Linux")
    def test_atomic_backup_and_interrupted_partial(self):
        runtime = self.root / "runtime"; runtime.mkdir()
        (runtime / "server").write_bytes(b"SYNTHETIC nonexecutable runtime")
        source = "a" * 40
        manifest = {"source_revision": source, "files": {"server": ops.digest(runtime / "server")["sha256"]}}
        (runtime / "manifest.json").write_text(json.dumps(manifest))
        archive = self.root / "runtime.tar"
        with tarfile.open(archive, "w:") as t:
            for n in ["server", "manifest.json"]: t.add(runtime / n, arcname=n)
        app = self.root / "app.json"
        app.write_text(json.dumps({"Database": "dbname=synthetic_only", "Revision": source}))
        app.chmod(0o600)
        target = self.root / "pairs"; target.mkdir(mode=0o700)
        c = {"database": "synthetic_only", "application_config": str(app), "runtime_directory": str(runtime),
             "runtime_archive": str(archive), "runtime_sha256": ops.digest(archive)["sha256"],
             "backup_root": str(target), "expected_source": source, "expected_application_revision": source, "expected_schema": 8}
        def query(db, q, deadline):
            if "max(version)" in q: return "8"
            if "required" in q: return "f"
            return "0"
        with patch.object(ops, "private_root", side_effect=Path), patch.object(ops, "protected", side_effect=Path), patch.object(ops, "sql", side_effect=query), patch.object(ops, "fences", return_value=contextlib.nullcontext()):
            with patch.object(ops, "dump", side_effect=lambda db, p, deadline: p.write_bytes(b"SYNTHETIC dump only")):
                r = ops.backup(c)
            self.assertEqual(ops.verify_pair(target / r["pair"])["state"], "complete")
            before = sorted(x.name for x in target.glob("backup-*"))
            with patch.object(ops, "dump", side_effect=TimeoutError("synthetic timeout")):
                with self.assertRaises(TimeoutError): ops.backup(c)
            self.assertEqual(before, sorted(x.name for x in target.glob("backup-*")))
            partials = list(target.glob(".partial-*")); self.assertEqual(len(partials), 1)
            self.assertTrue((partials[0] / "INCOMPLETE").exists())
            with self.assertRaises(ops.Refused): ops.verify_pair(partials[0])
            # Another attempt can succeed without mistaking the failed partial for a pair.
            with patch.object(ops, "dump", side_effect=lambda db, p, deadline: p.write_bytes(b"SYNTHETIC next dump")):
                r2 = ops.backup(c)
            self.assertNotEqual(r["pair"], r2["pair"])
            self.assertEqual(len(list(target.glob("backup-*"))), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
