"""Registration negatives plus opt-in actual root/PG18 disposable retirement.

The actual-host script supplies a separate private control root/database and
service; this module never infers permission to invoke production retirement.
"""
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest

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
