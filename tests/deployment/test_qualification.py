"""Safe isolated qualification controls; optional explicitly disposable PostgreSQL."""
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("qualification", ROOT / "deployment/qualification/verify_deployment.py")
q = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(q)


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.files = {name: ("Synthetic package only: " + name).encode() for name in q.REQUIRED_FILES}
        self.rows = {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items()}
        self.manifest = self.root / "hashes.txt"
        self.manifest.write_text("".join(f"{value}  .litradock/demo-package/{name}\n" for name, value in self.rows.items()))
        self.archive = self.make_archive()

    def make_archive(self, entries=None, name="package.tar.gz"):
        path = self.root / name
        with tarfile.open(path, "w:gz") as archive:
            for entry, data in (entries or list(self.files.items())):
                info = tarfile.TarInfo(entry)
                if data is None:
                    info.type, info.linkname = tarfile.SYMTYPE, "../../outside"
                    archive.addfile(info)
                else:
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
        return path

    def test_qp01_trusted_package_and_installed_positive(self):
        rows = q.read_manifest(self.manifest, q.digest(self.manifest))
        result = q.verify_archive(self.archive, q.digest(self.archive), rows)
        self.assertEqual(result["files"], len(self.files))
        installed = self.root / "installed"
        for name, data in self.files.items():
            path = installed / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.assertEqual(q.verify_installed(installed, rows)["assemblySha256"], rows["LitraDock.Hosted.dll"])
        (installed / "LitraDock.Hosted.dll").write_bytes(b"tampered assembly")
        with self.assertRaises(q.Rejected):
            q.verify_installed(installed, rows)

    def test_qp02_digest_anchors_required(self):
        with self.assertRaises(q.Rejected):
            q.read_manifest(self.manifest, "0" * 64)
        with self.assertRaises(q.Rejected):
            q.verify_archive(self.archive, "0" * 64, self.rows)

    def test_qp03_archive_adversarial_members(self):
        controls = [
            ("../escape", b"no"), ("/absolute", b"no"), ("C:/absolute", b"no"),
            ("nested\\escape", b"no"), ("link", None), ("private/paper.xml", b"no"),
            ("Fixture.dll", b"no"), ("extra.txt", b"no"), ("LitraDock.Hosted.dll", b"changed"),
        ]
        for name, data in controls:
            with self.subTest(control=name):
                archive = self.make_archive(list(self.files.items()) + [(name, data)])
                with self.assertRaises(q.Rejected):
                    q.verify_archive(archive, q.digest(archive), self.rows)
        missing = self.make_archive(list(self.files.items())[1:])
        with self.assertRaises(q.Rejected):
            q.verify_archive(missing, q.digest(missing), self.rows)

    def test_qp04_manifest_duplicates_and_traversal(self):
        original = self.manifest.read_text()
        for extra in (original.splitlines()[0], f"{'a'*64}  .litradock/demo-package/../outside"):
            self.manifest.write_text(original + extra + "\n")
            with self.assertRaises(q.Rejected):
                q.read_manifest(self.manifest, q.digest(self.manifest))

    def test_qp05_expansion_bound(self):
        with patch.object(q, "MAX_TOTAL", 1):
            with self.assertRaises(q.Rejected):
                q.verify_archive(self.archive, q.digest(self.archive), self.rows)

    def test_qp06_linked_archive_and_installed(self):
        if os.name == "nt":
            self.skipTest("Symlink creation privilege is not assumed on Windows; Linux CI exercises this.")
        linked = self.root / "linked"
        linked.symlink_to(self.archive)
        with self.assertRaises(q.Rejected):
            q.verify_archive(linked, q.digest(self.archive), self.rows)
        installed = self.root / "installed"
        installed.mkdir()
        (installed / "LitraDock.Hosted.dll").symlink_to(self.archive)
        with self.assertRaises(q.Rejected):
            q.verify_installed(installed, self.rows)

    def settings(self):
        return {"LITRADOCK_DEMO": "true", "LITRADOCK_LOCAL_TEST": "false",
                "LITRADOCK_SOURCE_REVISION": "a" * 40, "LITRADOCK_DEMO_OPERATOR": "Isolated operator control",
                "LITRADOCK_DEMO_CONTACT": "Operator console support", "LITRADOCK_DEMO_RETENTION": "Operator removes dedicated data on expiry",
                "LITRADOCK_DEMO_EXPIRES": "2099-01-01T00:00:00+08:00", "LITRADOCK_ORIGIN": "https://literature.control.org",
                "LITRADOCK_PROXY_IP": "127.0.0.1", "LITRADOCK_OBJECTS": str(self.root.absolute())}

    def test_qp07_explicit_configuration_positive(self):
        evidence = q.validate_environment(self.settings(), "a" * 40)
        self.assertTrue(evidence["explicitExpiryValid"])
        self.assertFalse(evidence["operatorPromisesVerified"])

    def test_qp08_configuration_negatives(self):
        for key, value in [("LITRADOCK_DEMO_CONTACT", "REQUIRED_ACTUAL_CONTACT"),
                           ("LITRADOCK_DEMO_RETENTION", "Synthetic CI teardown"),
                           ("LITRADOCK_DEMO_OPERATOR", ""), ("LITRADOCK_SOURCE_REVISION", "b" * 40),
                           ("LITRADOCK_DEMO_EXPIRES", "2099-01-01"),
                           ("LITRADOCK_DEMO_EXPIRES", "2000-01-01T00:00:00Z"),
                           ("LITRADOCK_ORIGIN", "http://literature.control.org"),
                           ("LITRADOCK_ORIGIN", "https://user:secret@literature.control.org"),
                           ("LITRADOCK_LOCAL_TEST", "true"), ("LITRADOCK_OBJECTS", "relative"),
                           ("LITRADOCK_INITIAL_PASSWORD", "SYNTHETIC_SECRET_CANARY")]:
            with self.subTest(field=key):
                data = self.settings()
                data[key] = value
                with self.assertRaises(q.Rejected):
                    q.validate_environment(data, "a" * 40)

    def test_qp09_literal_config_no_evaluation(self):
        path = self.root / "config"
        path.write_text("VALUE=$(never-run)\nQUOTED='literal value'\n")
        self.assertEqual(q.read_environment(path)["VALUE"], "$(never-run)")
        path.write_text("VALUE=one\nVALUE=two\n")
        with self.assertRaises(q.Rejected):
            q.read_environment(path)

    def test_qp10_posix_private_mode_and_path_negatives(self):
        if os.name == "nt":
            self.skipTest("POSIX ownership/mode qualification requires Linux.")
        # Use private HOME subtree so world-writable /tmp is not a false positive.
        with tempfile.TemporaryDirectory(dir=Path.home()) as temporary:
            root = Path(temporary)
            config = root / "config"
            config.write_text("SECRET=SYNTHETIC_SECRET_CANARY")
            config.chmod(0o600)
            self.assertEqual(q.protected_file(config, os.getuid()), config)
            config.chmod(0o644)
            with self.assertRaises(q.Rejected):
                q.protected_file(config, os.getuid())
            objects, recovery, installed = [root / name for name in ("objects", "recovery", "installed")]
            for path in (objects, recovery, installed):
                path.mkdir(mode=0o700)
            self.assertTrue(q.private_paths(config, objects, recovery, installed, os.getuid())["separatePrivateDirectories"])
            with self.assertRaises(q.Rejected):
                q.private_paths(config, objects, objects, installed, os.getuid())
            objects.chmod(0o777)
            with self.assertRaises(q.Rejected):
                q.private_paths(config, objects, recovery, installed, os.getuid())

    def database_result(self):
        return {"schema": 4, "readOnly": True, "superuser": False, "databaseOwner": True,
                "guard": False, "manual": 0, "conversions": 0, "libraries": 0, "records": 0,
                "accounts": 0, "sessions": 0, "jobs": 0, "files": 0, "sourceRequests": 0, "foreignTables": 0, "postgres": "180006"}

    def test_qp11_database_validation_negatives(self):
        self.assertTrue(q.validate_database(self.database_result(), True)["initialEmptyChecked"])
        for key, value in [("schema", 3), ("readOnly", False), ("superuser", True),
                           ("databaseOwner", False), ("guard", True), ("manual", 1),
                           ("conversions", 1), ("foreignTables", 1), ("postgres", "170000"),
                           ("libraries", 1), ("accounts", 1), ("sourceRequests", 1)]:
            with self.subTest(field=key):
                data = self.database_result()
                data[key] = value
                with self.assertRaises(q.Rejected):
                    q.validate_database(data, True)

    def test_qp12_database_secret_environment_and_error_redaction(self):
        secret = "SYNTHETIC_SECRET_CANARY"
        values = {"LITRADOCK_POSTGRES": f"Host=127.0.0.1;Database=litradock_ci_control;Username=service;Password={secret};SSL Mode=Disable"}
        def child(argv, **kwargs):
            self.assertNotIn(secret, repr(argv))
            self.assertEqual(kwargs["env"]["PGPASSWORD"], secret)
            self.assertNotIn("PGSERVICE", kwargs["env"])
            self.assertIn("READ ONLY", argv[-1])
            return subprocess.CompletedProcess(argv, 1, "", secret)
        report = {"checks": []}
        with patch.object(q.subprocess, "run", child), patch.dict(os.environ, {"PGSERVICE": "unrelated"}):
            q.add_check(report, "database", lambda: q.probe_database(values, True))
        self.assertNotIn(secret, json.dumps(report))
        for value in ["Host=external.control.org;Database=x;Username=y;Password=z;SSL Mode=Disable",
                      "Host=127.0.0.1;Database=postgres;Username=x;Password=z;SSL Mode=Disable",
                      "Host=127.0.0.1;Password='ambiguous;quoted'"]:
            with self.assertRaises(q.Rejected):
                q.database_settings(value)

    def test_qp13_schema_inventory_matches_frozen_migrations(self):
        found = set()
        for path in (ROOT / "src/LitraDock.Hosted/migrations").glob("*.sql"):
            found.update(re.findall(r"CREATE TABLE (ld_\w+)", path.read_text(encoding="utf-8")))
        self.assertEqual(found, set(q.SCHEMA_TABLES))

    def test_qp14_cli_missing_host_never_becomes_pass(self):
        output = self.root / "host.json"
        args = ["host", "--manifest", str(self.manifest), "--manifest-sha256", q.digest(self.manifest),
                "--output", str(output), "--scope", "actual-host"]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(q.main(args), 2)
        result = json.loads(output.read_text())
        self.assertEqual(result["automatedChecks"], "BLOCKED")
        self.assertEqual(result["deploymentAcceptance"], "UNVERIFIED")
        before = output.read_bytes()
        with self.assertRaises(FileExistsError), contextlib.redirect_stdout(io.StringIO()):
            q.main(args)
        self.assertEqual(output.read_bytes(), before)

    def test_qp15_package_cli_does_not_claim_deployment(self):
        output = self.root / "package.json"
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(q.main(["package", "--manifest", str(self.manifest), "--manifest-sha256", q.digest(self.manifest),
                                    "--archive", str(self.archive), "--archive-sha256", q.digest(self.archive), "--output", str(output)]), 0)
        self.assertEqual(json.loads(output.read_text())["deploymentAcceptance"], "UNVERIFIED")


@unittest.skipUnless(os.environ.get("QUALIFICATION_TEST_POSTGRES"), "No disposable PostgreSQL supplied; never launch one implicitly.")
class ActualPostgresTests(unittest.TestCase):
    def test_qp16_actual_read_only_database_and_foreign_table(self):
        value = os.environ["QUALIFICATION_TEST_POSTGRES"]
        settings = q.database_settings(value)
        self.assertEqual(os.environ.get("LITRADOCK_ALLOW_EPHEMERAL_TEST"), "yes")
        self.assertTrue(settings["PGDATABASE"].startswith("litradock_ci_"))
        values = {"LITRADOCK_POSTGRES": value}
        self.assertTrue(q.probe_database(values, True)["readOnly"])
        def sql(command):
            result = subprocess.run(["psql", "-X", "-q", "-A", "-t", "--no-password", "-v", "ON_ERROR_STOP=1", "-c", command],
                                    env={**os.environ, **settings}, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, "Disposable database control failed.")
        sql("CREATE TABLE public.ld_unrelated_qualification(value integer)")
        try:
            with self.assertRaises(q.Rejected):
                q.probe_database(values, True)
        finally:
            sql("DROP TABLE public.ld_unrelated_qualification")
        sql("INSERT INTO public.ld_source_usage VALUES('synthetic-control','2000-01-01',1)")
        try:
            with self.assertRaises(q.Rejected):
                q.probe_database(values, True)
        finally:
            sql("DELETE FROM public.ld_source_usage WHERE provider='synthetic-control'")
        self.assertTrue(q.probe_database(values, True)["initialEmptyChecked"])


if __name__ == "__main__":
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if output:
        output.write_text(json.dumps({"scope": "Isolated synthetic controls; not a deployed host or real biomedical request",
                                      "python": sys.version, "platform": sys.platform, "tests": result.testsRun,
                                      "failures": len(result.failures), "errors": len(result.errors),
                                      "skipped": [{"test": str(test), "reason": reason} for test, reason in result.skipped],
                                      "successful": result.wasSuccessful()}, indent=2) + "\n", encoding="utf-8")
    sys.exit(0 if result.wasSuccessful() else 1)
