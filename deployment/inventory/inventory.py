"""Offline inventory of two explicitly anchored releases; never extract or execute package members."""
import argparse
import base64
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tarfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("qualification", ROOT / "deployment/qualification/verify_deployment.py")
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)
RELEASES = {
    "demo": {"source": "cfd36dfa54acf5f1a0b870d467ebcfcb7136563a", "ci": 34691326605,
             "archive": "demo-candidate-linux-framework-dependent.tar.gz", "manifest": "demo-package-hashes.txt",
             "prefix": ".litradock/demo-package/", "archiveSha256": "1e385385217310681a86efe65f901b1a69cd9fb8b7a138d62ea270047da16d33",
             "manifestSha256": "6cb0ea98300fe3369482636a331acb161f897090032bd8d463a46ccc90ec7d1e"},
    "operator": {"source": "f7b7a1d08d151dff1d703d3c251576c8395e026e", "ci": 34694201636,
                 "archive": "credential-rotation-linux-framework-dependent.tar.gz", "manifest": "rotation-package-hashes.txt",
                 "prefix": ".litradock/credential-package/", "archiveSha256": "c0b59dd89453df266095d8cf552454156ee5df6159dc1f66ab0c7965b0d27aed",
                 "manifestSha256": "acd860d123eaeb13c143d2e621dd35bb2b6fc0071ba3d2b2c1ad767fadd67137"},
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def child(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=30,
                            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
    q.require(result.returncode == 0, "Offline helper or exact source read failed.")
    return result.stdout


def manifest_rows(path, anchor):
    q.require(q.digest(path) == anchor["manifestSha256"], "Untrusted manifest digest.")
    rows = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        h, name = line.split("  ", 1)
        q.require(q.HASH.fullmatch(h) and name.startswith(anchor["prefix"]), "Invalid manifest row.")
        name = q.safe_name(name.removeprefix(anchor["prefix"]))
        q.require(name not in rows, "Duplicate manifest member.")
        rows[name] = h
    q.require(0 < len(rows) <= 512, "Invalid manifest count.")
    return rows


def source_reader(repository, revision):
    actual = child(["git", "-C", str(repository), "rev-parse", revision + "^{commit}"]).decode().strip()
    q.require(actual == revision, "Exact source commit required.")
    def read(name):
        q.safe_name(name)
        return child(["git", "-C", str(repository), "show", revision + ":" + name])
    return read


def nuget_component(name, value, cache, helper):
    version = value["resolved"]
    archive = q.no_links(cache / name.lower() / version / (name.lower() + "." + version + ".nupkg"))
    q.require(archive.stat().st_size <= 256 * 1024 * 1024, "NuGet archive exceeds bound.")
    proof = json.loads(child(["dotnet", str(helper), str(archive), value["contentHash"]]))
    q.require(proof["contentHash"] == value["contentHash"], "NuGet lock content hash differs.")
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        q.require(len(entries) <= 4096 and sum(x.file_size for x in entries) <= 512 * 1024 * 1024, "NuGet expansion bound exceeded.")
        names = [x.filename for x in entries]
        q.require(len(names) == len(set(names)), "Duplicate NuGet member.")
        for entry in entries:
            q.safe_name(entry.filename.rstrip("/"))
            q.require(entry.file_size <= q.MAX_FILE, "NuGet member exceeds bound.")
        nuspecs = [n for n in names if n.endswith(".nuspec")]
        q.require(len(nuspecs) == 1, "Ambiguous nuspec.")
        data = z.read(nuspecs[0])
        metadata = ET.fromstring(data).find("{*}metadata")
        q.require(metadata.findtext("{*}id").lower() == name.lower() and metadata.findtext("{*}version") == version, "NuGet identity differs from lock.")
        license_node = metadata.find("{*}license")
        repository_node = metadata.find("{*}repository")
        component = {"id": name, "version": version, "type": value["type"], "lockContentHash": value["contentHash"],
                     "archiveSha256": q.digest(archive), "nuspecSha256": sha(data), "nuspecMember": nuspecs[0],
                     "licenseDeclaration": None if license_node is None else {"type": license_node.get("type"), "value": license_node.text},
                     "repository": {} if repository_node is None else dict(repository_node.attrib),
                     "publicPackageLocator": f"https://api.nuget.org/v3-flatcontainer/{name.lower()}/{version}/{name.lower()}.{version}.nupkg", "integrity": proof,
                     "licenseNoticeMembers": sorted(n for n in names if "license" in n.lower() or "notice" in n.lower()),
                     "licenseClearance": "UNVERIFIED; nuspec declaration is not legal ownership or complete redistribution review"}
        hashes = {n: sha(z.read(n)) for n in names if not n.endswith("/") and (n.endswith((".dll", ".so", ".dylib", ".a")))}
    if name == "SQLitePCLRaw.lib.e_sqlite3":
        component["unresolved"] = ["Native SQLite engine version and exact build/source commit are not specified by this nuspec",
                                   "Apache-2.0 package declaration does not individually establish all native SQLite/component notices"]
    return component, hashes


def generate(release, artifact_dir, repository, cache, helper):
    anchor = RELEASES[release]
    rows = manifest_rows(q.no_links(artifact_dir / anchor["manifest"]), anchor)
    archive = q.no_links(artifact_dir / anchor["archive"])
    package_proof = q.verify_archive(archive, anchor["archiveSha256"], rows)
    read = source_reader(repository, anchor["source"])
    source_evidence = {}
    def source(name):
        data = read(name)
        source_evidence[name] = {"sha256": sha(data), "bytes": len(data)}
        return data
    with tarfile.open(archive, "r|gz") as t:
        shipped = {m.name.removeprefix("./"): t.extractfile(m).read() for m in t if m.isfile()}
    # 第二次讀取也核對受信任清單，避免讀取間修改成另一份內容。
    q.require({n: sha(d) for n, d in shipped.items()} == rows, "Package changed during inventory.")
    deps = json.loads(shipped["LitraDock.Hosted.deps.json"])
    target = deps["targets"][deps["runtimeTarget"]["name"]]
    lock = json.loads(source("src/LitraDock.Hosted/packages.lock.json"))["dependencies"]["net10.0"]
    components, assignments = [], {}
    for name, value in sorted(lock.items()):
        if value["type"] == "Project":
            continue
        key = name + "/" + value["resolved"]
        q.require(key in deps["libraries"] and deps["libraries"][key]["sha512"] == "sha512-" + value["contentHash"], "Shipped dependency graph differs from source lock.")
        component, hashes = nuget_component(name, value, cache, helper)
        components.append(component)
        for category in ("runtime", "native", "runtimeTargets"):
            for member, detail in target[key].get(category, {}).items():
                output = member if category == "runtimeTargets" else Path(member).name
                q.require(output in rows and member in hashes and hashes[member] == rows[output], "Shipped dependency bytes differ from locked NuGet member.")
                q.require(output not in assignments, "Ambiguous dependency assignment.")
                assignments[output] = {"kind": "nuget", "component": key, "member": member, "status": "VERIFIED_BYTES_AND_LOCK",
                                       "rid": detail.get("rid"), "assetType": detail.get("assetType", category)}
    q.require({k for k,v in deps["libraries"].items() if v["type"] == "package"} == {c["id"] + "/" + c["version"] for c in components}, "Unexpected dependency package.")
    for name in ("LICENSE", "THIRD-PARTY-NOTICES.md", "DEMO.md" if release == "demo" else "CREDENTIALS.md"):
        q.require(sha(source(name)) == rows[name], "Shipped document differs from exact source.")
        assignments[name] = {"kind": "source-document", "source": name, "status": "VERIFIED_SOURCE_BYTES", "license": "See document; no third-party ownership claim"}
    for name in ("hosted.js", "hosted.css", "index.html"):
        output = "wwwroot/" + name
        path = "src/LitraDock.Hosted/" + output
        q.require(sha(source(path)) == rows[output], "Web asset differs from exact source.")
        assignments[output] = {"kind": "first-party-source", "source": path, "license": "AGPL-3.0-only", "status": "VERIFIED_SOURCE_BYTES"}
        for suffix in (".gz", ".br"):
            compressed = output + suffix
            if suffix == ".gz":
                # 僅處理已驗證、受信任的封存項目；解壓結果仍有獨立上限。
                import io
                with gzip.GzipFile(fileobj=io.BytesIO(shipped[compressed])) as f:
                    plain = f.read(1024 * 1024 + 1)
                q.require(len(plain) <= 1024 * 1024, "Expanded web asset exceeds bound.")
                decoded_hash = sha(plain)
            else:
                decoded_hash = child(["dotnet", str(helper), "brotli"], base64.b64encode(shipped[compressed])).decode().strip()
            q.require(decoded_hash == rows[output], "Compressed asset content differs from source.")
            assignments[compressed] = {"kind": "generated-compression", "source": path, "license": "AGPL-3.0-only", "status": "VERIFIED_DECOMPRESSED_SOURCE_BYTES"}
    for project in ("LitraDock.Hosted", "LitraDock.Modern"):
        source("src/" + project + "/" + project + ".csproj")
        for suffix in (".dll", ".pdb"):
            assignments[project + suffix] = {"kind": "first-party-build", "project": project, "license": "AGPL-3.0-only",
                                              "status": "CI_ASSOCIATED; independent reproducible binary rebuild not performed"}
    for name in ("LitraDock.Hosted.deps.json", "LitraDock.Hosted.runtimeconfig.json", "LitraDock.Hosted.staticwebassets.endpoints.json", "web.config"):
        assignments[name] = {"kind": "sdk-generated-metadata", "generator": "NET SDK 10.0.400 from exact CI workflow",
                             "status": "CI_ASSOCIATED", "license": "Project metadata; SDK template-specific redistribution assessment remains UNVERIFIED"}
    assignments["LitraDock.Hosted"] = {"kind": "sdk-generated-apphost", "status": "UNVERIFIED_EXACT_HOSTPACK_PROVENANCE",
                                     "generator": "NET SDK 10.0.400", "license": "NET host MIT declaration; exact hostpack/native notice attribution remains unresolved"}
    q.require(assignments.keys() == rows.keys(), "Unclassified or unshipped assignment.")
    source("global.json")
    source("Directory.Build.props")
    source(".github/workflows/hosted-ci.yml" if release == "demo" else ".github/workflows/credential-rotation.yml")
    runtime = json.loads(shipped["LitraDock.Hosted.runtimeconfig.json"])["runtimeOptions"]
    # 研究文件工作程序並未封裝在兩個 app tar 中；將來源鎖定的外部需求分開列出。
    npm = json.loads(source("src/document-worker/package-lock.json"))
    npm_components = [{"path": path, "version": item.get("version"), "integrity": item.get("integrity"),
                       "resolved": item.get("resolved"), "declaredLicense": item.get("license"),
                       "licenseStatus": "DECLARED_IN_LOCK" if item.get("license") else "UNVERIFIED_NO_LICENSE_IN_LOCK"}
                      for path, item in sorted(npm["packages"].items()) if path]
    external_assets = json.loads(source("src/document-worker/assets-manifest.json"))
    for item in external_assets:
        # Font download is external; retained source assets are read only when included in Git.
        if not item["path"].startswith("fonts/"):
            data = source("src/document-worker/" + item["path"])
            q.require(sha(data) == item["sha256"], "External source asset differs from pinned manifest.")
    files = [{"path": name, "bytes": len(shipped[name]), "sha256": rows[name], **assignments[name]} for name in sorted(rows)]
    return {"format": "litradock.release-inventory.v1", "release": release, "anchors": anchor,
            "packageVerification": package_proof, "files": files, "nugetComponents": components,
            "sourceEvidence": dict(sorted(source_evidence.items())),
            "externalRequirements": {"frameworks": runtime["frameworks"], "installedOnTarget": "UNVERIFIED",
                "documentWorker": {"bundled": False, "scope": "General research features; disabled in restricted demo",
                    "npm": npm_components, "assets": external_assets,
                    "licenseCaveat": "citeproc npm AGPL-1.0 conflicts with retained packaged AGPLv3 option; do not inherit metadata as clearance",
                    "other": ["Node runtime", "Pinned Playwright Chromium and its OS libraries", "Noto font download"]},
                "services": ["Dedicated PostgreSQL 18 per reviewed deployment contract", "HTTPS reverse proxy and OS native libraries", "Trusted pg_dump/pg_restore for operator recovery"]},
            "limitations": ["Inventory is not vulnerability clearance, license clearance, legal ownership, signing or installation qualification",
                "Native SQLite engine/build provenance and apphost hostpack attribution remain unresolved",
                "Declared NuGet licenses lack packaged LICENSE/NOTICE files in these eight archives; redistribution notice completion remains open",
                "Package integrity does not verify certificate trust or prove independently reproducible first-party compilation",
                "Multiple native RIDs are bundled; this does not establish supported operating systems",
                "No actual target host, device, service rollback or long-term artifact retention is established"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", choices=RELEASES)
    for name in ("artifact-dir", "source-repository", "nuget-cache", "helper", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args(argv)
    args.output = q.no_links(args.output)
    if args.output.exists():
        raise FileExistsError("Evidence output already exists.")
    result = generate(args.release, args.artifact_dir, args.source_repository, args.nuget_cache, args.helper)
    data = (json.dumps(result, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode()
    with args.output.open("xb") as f:
        f.write(data)
    print(json.dumps({"release": args.release, "files": len(result["files"]), "sha256": sha(data), "deploymentAccepted": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "BLOCKED", "reason": type(error).__name__, "deploymentAccepted": False}))
        raise SystemExit(2)
