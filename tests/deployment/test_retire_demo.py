"""Registration negatives plus opt-in actual root/PG18 disposable retirement.

The actual-host script supplies a separate private control root/database and
service; this module never infers permission to invoke production retirement.
"""
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import json
import os
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("retire", ROOT / "deployment/qualification/retire_demo.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Registration(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 12, tzinfo=timezone.utc)
        self.policy = dict(id="deployment003-20260912", database="literature_demo_20260912", role="literature_demo",
                           dataRoot=str(m.DATA_ROOT), databaseOid=16385,
                           createdAt=(self.now-timedelta(days=14)).isoformat(),
                           expiresAt=(self.now-timedelta(days=7)).isoformat(), deleteAfter=self.now.isoformat())

    def test_due_registration(self):
        self.assertEqual(64, len(m.validate(self.policy, self.now)))

    def test_numeric_process_identity(self):
        self.assertTrue(m.service_processes("0 1\n 997 60705\n", 997))
        self.assertFalse(m.service_processes("0 1\n998 123\n", 997))
        for text in ("literat+ 60705", "997", "997 60705 extra", "NaN 1"):
            with self.subTest(text=text), self.assertRaises(m.q.Rejected):
                m.service_processes(text, 997)

    @unittest.skipUnless(os.name == "posix", "POSIX lock control; separate target receipt covers actual root")
    def test_completed_replay_rejects_restored_invitation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "deployment.json"
            config.write_text(json.dumps(self.policy))
            (root / "retirement-state.json").write_text(json.dumps({"binding": "control", "phase": "complete"}))
            with patch.object(m.os, "geteuid", return_value=0), patch.object(m.q, "protected_file", side_effect=lambda p, _: p), \
                 patch.object(m, "validate", return_value="control"), patch.object(m, "inspect_storage"), \
                 patch.object(m, "DATA_ROOT", root / "objects-root"), patch.object(m, "sql", return_value=""):
                self.assertTrue(m.retire(config, True)["repeated"])
                (root / "invitations.json").write_text("synthetic-restored-invitation")
                with self.assertRaises(m.q.Rejected):
                    m.retire(config, True)
                self.assertEqual("synthetic-restored-invitation", (root / "invitations.json").read_text())

    def test_early_never_mutates(self):
        with self.assertRaises(m.q.Rejected):
            m.validate(self.policy, self.now-timedelta(seconds=1))

    def test_identity_and_path_negatives(self):
        for key, value in [("id", "other"), ("database", "postgres"), ("database", "literature_demo_20260912;DROP DATABASE postgres"),
                           ("role", "postgres"), ("databaseOid", 0), ("databaseOid", True), ("dataRoot", "/srv"),
                           ("dataRoot", "/srv/literature-demo/../other")]:
            with self.subTest(key=key, value=value), self.assertRaises(m.q.Rejected):
                m.validate({**self.policy, key: value}, self.now)

    def test_dates_need_timezone_and_order(self):
        for key, value in [("deleteAfter", self.now.replace(tzinfo=None).isoformat()),
                           ("expiresAt", self.policy["createdAt"]),
                           ("createdAt", (self.now-timedelta(days=30, seconds=1)).isoformat()),
                           ("createdAt", (self.now-timedelta(days=60)).isoformat())]:
            with self.subTest(key=key), self.assertRaises(m.q.Rejected):
                m.validate({**self.policy, key: value}, self.now)


if __name__ == "__main__":
    unittest.main(verbosity=2)
