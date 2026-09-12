"""Stage one frozen application into a NEW private directory; never activate it.

Uses the inventory's exact release anchors and existing package verifier. Run
with exclusive ownership of the destination parent; unprivileged staging is
not production ownership, configuration, migration or deployment acceptance.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("inventory", ROOT / "deployment/inventory/inventory.py")
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
q = inventory.q


def stage(release, inputs, destination):
    q.require(release in inventory.RELEASES, "Unknown frozen release.")
    anchor = inventory.RELEASES[release]
    destination = q.no_links(destination)
    parent = q.no_links(destination.parent)
    q.require(parent.is_dir() and not destination.exists(), "Destination must be new with an existing parent.")
    if os.name == "posix":
        s = parent.stat()
        q.require(s.st_uid == os.geteuid() and not s.st_mode & 0o077,
                  "Staging parent must be owned by caller and private mode0700.")
    # Copy into our exclusive directory first: verification and extraction use
    # the same private bytes, never an externally mutable source archive.
    work = Path(tempfile.mkdtemp(prefix=".stage-", dir=parent))
    published = None
    try:
        package = work / "package.tar.gz"
        manifest = work / "manifest.txt"
        for src, dst, limit in ((Path(inputs) / anchor["archive"], package, q.MAX_TOTAL),
                                (Path(inputs) / anchor["manifest"], manifest, 1024 * 1024)):
            src = q.no_links(src)
            q.require(src.is_file() and src.stat().st_size <= limit, "Invalid bounded staging input.")
            with src.open("rb") as reader, dst.open("xb") as writer:
                total = 0
                while block := reader.read(1024 * 1024):
                    total += len(block)
                    q.require(total <= limit, "Staging input exceeds bound.")
                    writer.write(block)
        rows = inventory.manifest_rows(manifest, anchor)
        proof = q.verify_archive(package, anchor["archiveSha256"], rows)
        content = work / "content"
        content.mkdir(mode=0o700)
        with tarfile.open(package, "r|gz") as archive:
            for member in archive:
                if member.isdir():
                    continue
                name = q.safe_name(member.name.removeprefix("./"))
                target = content / name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with archive.extractfile(member) as reader, target.open("xb") as writer:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
                target.chmod(0o600)
        q.verify_installed(content, rows)
        # No replacement / resume in place. Exclusive parent ownership is an
        # operational prerequisite, not a claim of safety against the caller.
        q.require(not destination.exists(), "Destination appeared during staging.")
        content.rename(destination)
        published = {"status": "STAGED", "release": release, "source": anchor["source"],
                "archiveSha256": anchor["archiveSha256"], **proof,
                "activation": "NOT_PERFORMED", "deploymentAcceptance": "UNVERIFIED", "cleanup": "COMPLETE"}
        return published
    finally:
        try:
            shutil.rmtree(work)
        except OSError:
            if published is None:
                raise
            published["cleanup"] = "PENDING; validated destination retained; inspect private staging temporary directory"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--release", choices=sorted(inventory.RELEASES), required=True)
    p.add_argument("--inputs", type=Path, required=True)
    p.add_argument("--destination", type=Path, required=True)
    args = p.parse_args()
    try:
        print(json.dumps(stage(args.release, args.inputs, args.destination), sort_keys=True))
    except (q.Rejected, OSError, tarfile.TarError):
        print(json.dumps({"status": "REJECTED", "reason": "Staging input, destination or integrity check failed.",
                          "activation": "NOT_PERFORMED"}))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
