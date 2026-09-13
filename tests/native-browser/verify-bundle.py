"""Independent UTF-8/ZIP reader for frozen bundles; no application/provider calls."""
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import pathlib
import re
import sys
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("plan_reader", pathlib.Path(__file__).with_name("verify-plan-export.py"))
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate(document, archives):
    d = document
    assert set(d) == {"schema", "schemaVersion", "snapshotID", "createdAt", "expiresAt", "planID", "manifest", "parts"}
    assert d["schema"] == "litradock.bundle" and type(d["schemaVersion"]) is int and d["schemaVersion"] == 1
    assert re.fullmatch(r"BND-[0-9a-f]{32}", d["snapshotID"])
    assert d["planID"] == d["manifest"]["plan"]["planID"]
    assert set(archives) == {p["filename"] for p in d["parts"]}
    all_files = {}
    aliases = {}
    for number, part in enumerate(d["parts"], 1):
        assert set(part) == {"number", "filename", "bytes", "sha256", "originalBytes", "files"}
        assert type(part["number"]) is int and part["number"] == number
        assert part["filename"] == f"litradock-originals-part-{number:03}.zip"
        data = archives[part["filename"]]
        assert type(part["bytes"]) is int and len(data) == part["bytes"] <= 17 * 1024 * 1024
        assert sha(data) == part["sha256"]
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            assert len(names) == len(set(names)) <= 101
            assert all(not n.startswith("/") and ".." not in n.split("/") and "\\" not in n for n in names)
            assert sum(f.file_size for f in archive.infolist()) <= 17 * 1024 * 1024
            members = {n: archive.read(n) for n in names}
        assert set(members) == {"manifest.json", *(f["file"] for f in part["files"])}
        local = plan.decode(members["manifest.json"])
        assert set(local) == {"schema", "schemaVersion", "snapshotID", "partNumber", "files", "members"}
        assert local["schema"] == "litradock.bundle-part" and local["schemaVersion"] == 1
        assert local["snapshotID"] == d["snapshotID"] and local["partNumber"] == number
        assert local["files"] == part["files"]
        part_ids = []
        original_bytes = 0
        for file in part["files"]:
            assert set(file) == {"file", "sha256", "format", "bytes", "searchIDs"}
            assert file["format"] in {"PDF", "XML"}
            assert file["file"] == f"originals/{file['sha256']}.{file['format'].lower()}"
            assert re.fullmatch(r"[0-9a-f]{64}", file["sha256"])
            body = members[file["file"]]
            assert type(file["bytes"]) is int and len(body) == file["bytes"] <= 8 * 1024 * 1024
            assert len(body) > 0 and sha(body) == file["sha256"]
            assert file["file"] not in all_files
            assert file["searchIDs"] and len(file["searchIDs"]) == len(set(file["searchIDs"]))
            expected = [i["searchId"] for i in d["manifest"]["items"] if i["file"] == file["file"]]
            assert file["searchIDs"] == expected
            aliases[file["file"]] = expected
            part_ids.extend(expected)
            all_files[file["file"]] = body
            original_bytes += len(body)
        assert type(part["originalBytes"]) is int and part["originalBytes"] == original_bytes <= 8 * 1024 * 1024
        assert local["members"] == [i for i in d["manifest"]["items"] if i["searchId"] in part_ids]
    assert len(all_files) == d["manifest"]["counts"]["uniqueOriginals"]
    combined = dict(all_files)
    combined["manifest.json"] = json.dumps(d["manifest"]).encode()
    combined["records.json"] = json.dumps(d["manifest"]["research"]).encode()
    plan.validate(d["manifest"], combined, original_limit=128 * 1024 * 1024)
    return all_files


def negatives(d, archives):
    mutations = []
    x = copy.deepcopy(d); x["manifest"]["items"].pop(); mutations.append((x, archives))
    x = copy.deepcopy(d); x["manifest"]["research"]["records"][0]["password"] = "private"; mutations.append((x, archives))
    if d["parts"]:
        x = copy.deepcopy(d); x["parts"][0]["sha256"] = "0" * 64; mutations.append((x, archives))
        x = copy.deepcopy(d); x["parts"][0]["files"][0]["searchIDs"] = []; mutations.append((x, archives))
        x = copy.deepcopy(d); x["parts"].append(copy.deepcopy(x["parts"][0])); mutations.append((x, archives))
        changed = dict(archives); del changed[d["parts"][0]["filename"]]; mutations.append((d, changed))
        changed = dict(archives); name = d["parts"][0]["filename"]; changed[name] = changed[name][:-1]; mutations.append((d, changed))
    for doc, blobs in mutations:
        try:
            validate(doc, blobs)
        except (AssertionError, KeyError, TypeError, zipfile.BadZipFile):
            continue
        raise AssertionError("Consequential bundle mutation was accepted")
    return len(mutations)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=pathlib.Path)
    parser.add_argument("parts", nargs="*", type=pathlib.Path)
    parser.add_argument("--negative-controls", action="store_true")
    parser.add_argument("--synthetic", action="store_true")
    parser.add_argument("--pdf", action="store_true")
    args = parser.parse_args()
    d = plan.decode(args.manifest.read_bytes())
    archives = {p.name: p.read_bytes() for p in args.parts}
    assert len(archives) == len(args.parts)
    files = validate(d, archives)
    media = []
    if args.pdf:
        from pypdf import PdfReader
        for name, data in files.items():
            if name.endswith(".pdf"):
                pdf = PdfReader(io.BytesIO(data), strict=True)
                assert not pdf.is_encrypted and len(pdf.pages) > 0
                media.append({"file": name, "sha256": sha(data), "bytes": len(data), "pages": len(pdf.pages)})
    print(json.dumps({"pass": True, "synthetic": args.synthetic, "sourceCalls": 0,
                      "parts": len(d["parts"]), "members": len(d["manifest"]["items"]),
                      "uniqueOriginals": len(files), "originalBytes": sum(map(len, files.values())),
                      "manifestSHA256": sha(args.manifest.read_bytes()), "pdf": media,
                      "negativeControls": negatives(d, archives) if args.negative_controls else 0}, indent=2))
