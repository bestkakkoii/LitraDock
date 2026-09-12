"""Offline extraction/activation-boundary controls; synthetic code bytes only."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("stage_release", ROOT / "deployment/qualification/stage_release.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Staging(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.inputs = self.root / "inputs"
        self.inputs.mkdir()
        self.dest = self.root / "new"
        self.rows = {"LitraDock.Hosted.dll": b"synthetic executable-free test bytes", "wwwroot/a.js": b"// test"}
        self.anchor = dict(m.inventory.RELEASES["operator"])
        self.make_package(self.rows)
        self.anchor_patch = patch.dict(m.inventory.RELEASES, {"operator": self.anchor})
        self.anchor_patch.start()

    def tearDown(self):
        self.anchor_patch.stop()
        self.temp.cleanup()

    def make_package(self, rows):
        a = self.inputs / self.anchor["archive"]
        with tarfile.open(a, "w:gz") as t:
            for name, data in rows.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))
        manifest = self.inputs / self.anchor["manifest"]
        manifest.write_text("".join(hashlib.sha256(b).hexdigest() + "  " + self.anchor["prefix"] + n + "\n"
                                    for n, b in self.rows.items()), encoding="utf-8")
        self.anchor["manifestSha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
        self.anchor["archiveSha256"] = hashlib.sha256(a.read_bytes()).hexdigest()

    def reject(self):
        with self.assertRaises((m.q.Rejected, OSError)):
            m.stage("operator", self.inputs, self.dest)
        self.assertFalse(self.dest.exists())
        self.assertEqual([], list(self.root.glob(".stage-*")))

    def test_exact_bytes_and_repeat_refused(self):
        result = m.stage("operator", self.inputs, self.dest)
        self.assertEqual("NOT_PERFORMED", result["activation"])
        for n, b in self.rows.items():
            self.assertEqual(b, (self.dest / n).read_bytes())
        with self.assertRaises(m.q.Rejected):
            m.stage("operator", self.inputs, self.dest)
        self.assertEqual(self.rows["wwwroot/a.js"], (self.dest / "wwwroot/a.js").read_bytes())

    def test_missing_member(self):
        self.make_package({"LitraDock.Hosted.dll": self.rows["LitraDock.Hosted.dll"]})
        self.reject()

    def test_unexpected_member(self):
        self.make_package({**self.rows, "unreviewed.dll": b"extra"})
        self.reject()

    def test_modified_member(self):
        self.make_package({**self.rows, "wwwroot/a.js": b"modified"})
        self.reject()

    def test_traversal(self):
        self.make_package({**self.rows, "../escape": b"extra"})
        self.reject()
        self.assertFalse((self.root / "escape").exists())

    def test_interruption_before_publication(self):
        with patch.object(m.shutil, "copyfileobj", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                m.stage("operator", self.inputs, self.dest)
        self.assertFalse(self.dest.exists())
        self.assertEqual([], list(self.root.glob(".stage-*")))

    def test_failure_after_extraction_before_publication(self):
        with patch.object(m.q, "verify_installed", side_effect=OSError):
            self.reject()

    @unittest.skipUnless(os.name == "posix", "POSIX permission and symlink control")
    def test_parent_permissions_and_symlink(self):
        self.root.chmod(0o755)
        self.reject()
        self.root.chmod(0o700)
        self.dest.symlink_to(self.inputs, target_is_directory=True)
        with self.assertRaises(m.q.Rejected):
            m.stage("operator", self.inputs, self.dest)

    def test_cli_redaction(self):
        marker = "DO-NOT-LOG-private-path-control"
        result = subprocess.run([sys.executable, str(ROOT / "deployment/qualification/stage_release.py"),
                                 "--release", "operator", "--inputs", str(self.root / marker),
                                 "--destination", str(self.dest)], capture_output=True, timeout=20,
                                **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
        self.assertEqual(2, result.returncode)
        self.assertNotIn(marker.encode(), result.stdout + result.stderr)
        self.assertEqual("REJECTED", json.loads(result.stdout)["status"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
