"""Offline archive negatives and optional actual retained release/NuGet checks."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("inventory", ROOT / "deployment/inventory/inventory.py")
inv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inv)


class ArchiveControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.files = {"LitraDock.Hosted.dll": b"synthetic-code", "wwwroot/hosted.js": b"synthetic-web"}
        self.rows = {n: inv.sha(d) for n, d in self.files.items()}

    def archive(self, files, special=None):
        path = self.root / "control.tar.gz"
        with tarfile.open(path, "w:gz") as t:
            for name, data in files:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))
            if special:
                t.addfile(special)
        return path

    def verify(self, files, special=None):
        path = self.archive(files, special)
        # A newly computed archive digest cannot excuse missing/extra/changed members
        # relative to the independently supplied expected member map.
        return inv.q.verify_archive(path, inv.q.digest(path), self.rows)

    def test_ri01_positive(self):
        self.assertEqual(self.verify(self.files.items())["files"], 2)

    def test_ri02_missing(self):
        with self.assertRaises(inv.q.Rejected):
            self.verify(list(self.files.items())[:1])

    def test_ri03_unexpected(self):
        with self.assertRaises(inv.q.Rejected):
            self.verify([*self.files.items(), ("extra.dll", b"unexpected")])

    def test_ri04_modified(self):
        with self.assertRaises(inv.q.Rejected):
            self.verify([(name, b"modified" if name.endswith(".dll") else data) for name, data in self.files.items()])

    def test_ri05_duplicate_traversal_link(self):
        for extra in [("LitraDock.Hosted.dll", b"synthetic-code"), ("../escape", b"bad")]:
            with self.assertRaises(inv.q.Rejected):
                self.verify([*self.files.items(), extra])
        link = tarfile.TarInfo("link")
        link.type = tarfile.SYMTYPE
        link.linkname = "LitraDock.Hosted.dll"
        with self.assertRaises(inv.q.Rejected):
            self.verify(self.files.items(), link)

    def test_ri06_manifest_anchor_and_prefix(self):
        p = self.root / "manifest"
        p.write_text("\n".join(h + "  .litradock/demo-package/" + name for name, h in self.rows.items()))
        anchor = {"manifestSha256": inv.q.digest(p), "prefix": ".litradock/demo-package/"}
        self.assertEqual(inv.manifest_rows(p, anchor), self.rows)
        with self.assertRaises(inv.q.Rejected):
            inv.manifest_rows(p, {**anchor, "manifestSha256": "0" * 64})
        with self.assertRaises(inv.q.Rejected):
            inv.manifest_rows(p, {**anchor, "prefix": ".litradock/credential-package/"})
        p.write_text(p.read_text() + "\n" + p.read_text().splitlines()[0])
        with self.assertRaises(inv.q.Rejected):
            inv.manifest_rows(p, {**anchor, "manifestSha256": inv.q.digest(p)})


@unittest.skipUnless(os.environ.get("INVENTORY_INPUTS"), "Actual retained packages, exact Git source and cached NuGet inputs were not supplied.")
class RetainedControls(unittest.TestCase):
    def setUp(self):
        self.inputs = Path(os.environ["INVENTORY_INPUTS"])
        self.repository = Path(os.environ["INVENTORY_SOURCE"])
        self.cache = Path(os.environ["INVENTORY_NUGET_CACHE"])
        self.helper = Path(os.environ["INVENTORY_HELPER"])
        self.output = Path(os.environ["INVENTORY_OUTPUT"])
        self.output.mkdir(parents=True, exist_ok=True)

    def test_ri07_actual_releases_deterministic_and_complete(self):
        for release in inv.RELEASES:
            args = [release, "--artifact-dir", str(self.inputs / release), "--source-repository", str(self.repository),
                    "--nuget-cache", str(self.cache), "--helper", str(self.helper)]
            one, two = self.output / (release + ".json"), self.output / (release + "-repeat.json")
            with contextlib.redirect_stdout(io.StringIO()):
                inv.main([*args, "--output", str(one)])
                inv.main([*args, "--output", str(two)])
            self.assertEqual(one.read_bytes(), two.read_bytes())
            result = json.loads(one.read_bytes())
            self.assertEqual(len(result["files"]), 55)
            self.assertEqual(sum(f["kind"] == "nuget" for f in result["files"]), 34)
            self.assertEqual(len(result["nugetComponents"]), 8)
            self.assertTrue(all(c["integrity"]["signedContentIntegrityChecked"] for c in result["nugetComponents"]))
            with self.assertRaises(FileExistsError), contextlib.redirect_stdout(io.StringIO()):
                inv.main([*args, "--output", str(one)])
            self.assertEqual(one.read_bytes(), two.read_bytes())

    def test_ri08_signed_nuget_mutation_and_wrong_lock(self):
        source = inv.source_reader(self.repository, inv.RELEASES["demo"]["source"])
        locked = json.loads(source("src/LitraDock.Hosted/packages.lock.json"))["dependencies"]["net10.0"]["Npgsql"]
        archive = self.cache / "npgsql/10.0.3/npgsql.10.0.3.nupkg"
        with tempfile.TemporaryDirectory() as temporary:
            bad = Path(temporary) / "changed.nupkg"
            with zipfile.ZipFile(archive) as before, zipfile.ZipFile(bad, "w") as after:
                for item in before.infolist():
                    data = before.read(item.filename)
                    after.writestr(item, data + b"changed" if item.filename == "lib/net10.0/Npgsql.dll" else data)
            for path, expected in [(bad, locked["contentHash"]), (archive, "0" * 88)]:
                result = subprocess.run(["dotnet", str(self.helper), str(path), expected], capture_output=True, timeout=30,
                                        **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"Offline content verification failed", result.stderr)

    def test_ri09_invalid_brotli_and_wrong_source(self):
        with self.assertRaises(inv.q.Rejected):
            inv.child(["dotnet", str(self.helper), "brotli"], b"!!!invalid-base64!!!")
        with self.assertRaises(inv.q.Rejected):
            inv.source_reader(self.repository, "0" * 40)


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__]))
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(json.dumps({"scope": "Offline code archives, cached dependencies and exact Git blobs; no app or provider execution",
            "tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
            "skipped": [str(test) for test, _ in result.skipped], "successful": result.wasSuccessful()}, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)
