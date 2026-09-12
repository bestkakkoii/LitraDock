"""Build an explicit, code-only native source archive from immutable Git blobs.

No checkout traversal, remote publication, private receipt or Git history is copied.
The allowlist itself must be present in the selected revision. Run without -O.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile

if not __debug__:
    sys.exit("Verification requires normal Python, not -O")
args = argparse.ArgumentParser()
args.add_argument("--revision", required=True)
args.add_argument("--output", type=Path, required=True)
options = args.parse_args()
if not re.fullmatch(r"[0-9a-f]{40}", options.revision):
    sys.exit("Exact immutable revision required")


def blob(path):
    return subprocess.check_output(["git", "show", options.revision + ":" + path])


def digest(data):
    return hashlib.sha256(data).hexdigest()


allowlist = json.loads(blob("deployment/native-source-allowlist.json"))["files"]
files = {}
for target, source in allowlist.items():
    for name in (target, source):
        p = PurePosixPath(name)
        if p.is_absolute() or ".." in p.parts or "\\" in name:
            sys.exit("Invalid allowlist path")
    mode = subprocess.check_output(["git", "ls-tree", options.revision, "--", source]).split()[0]
    if mode not in (b"100644", b"100755"):
        sys.exit("Only regular tracked source files are allowed")
    files[target] = blob(source)
# The exported tree is its own next input: all source mappings refer to exported roots.
exported_allowlist = {"schema": 1, "files": {name: name for name in sorted(files)}}
files["deployment/native-source-allowlist.json"] = (json.dumps(exported_allowlist, indent=2) + "\n").encode()
assert all(name in files for name in exported_allowlist["files"].values())
manifest = {"schema": 1, "source_revision": options.revision,
            "scope": "Code-only native source; no runtime/private data or Git history",
            "transforms": {"deployment/native-source-allowlist.json": "Self-contained exported path mapping"},
            "files": {p: {"git_path": allowlist[p], "sha256": digest(b)} for p, b in files.items()}}
files["SOURCE-MANIFEST.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()


def pack(members):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(members.items()):
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode, entry.mtime = len(data), 0o644, 0
            archive.addfile(entry, io.BytesIO(data))
    return result.getvalue()


def verify(data):
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        members = archive.getmembers()
        assert len(members) == len(files) and {m.name for m in members} == set(files)
        assert all(m.isfile() for m in members)
        for name, expected in files.items():
            assert archive.extractfile(name).read() == expected


archive = pack(files)
assert archive == pack(files)
verify(archive)
controls = []
for name, changed in (
    ("missing", {k: v for k, v in files.items() if k != "README.md"}),
    ("unexpected", dict(files, **{"private/runtime.json": b"{}"})),
    ("modified", dict(files, **{"README.md": files["README.md"] + b"changed"})),
):
    try:
        verify(pack(changed))
    except AssertionError:
        controls.append(name)
    else:
        sys.exit("Negative control incorrectly accepted")
with options.output.open("xb") as output:
    output.write(archive)
print(json.dumps({"source_revision": options.revision, "sha256": digest(archive),
                  "members": len(files), "bytes": len(archive),
                  "deterministic": True, "rejected_controls": controls}, indent=2))
