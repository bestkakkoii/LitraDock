"""Independent standard-library verification of SYNTHETIC browser receipts only."""
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

root = Path(sys.argv[1]).resolve(strict=True)
result = json.loads((root / "result.json").read_text(encoding="utf-8"))
assert result["outcome"] == "passed"
files = []
for receipt in result["downloads"]:
    target = (root / receipt["filename"]).resolve(strict=True)
    assert target.parent == root
    data = target.read_bytes()
    assert len(data) == receipt["bytes"]
    assert hashlib.sha256(data).hexdigest() == receipt["sha256"]
    if receipt["kind"] == "json":
        document = json.loads(data.decode("utf-8", errors="strict"))
        assert document["schema"] == "litradock.bundle"
        manifest = document["manifest"]
        assert manifest["counts"]["members"] == 3
        assert len(set(item["searchId"] for item in manifest["items"])) == 3
        assert "中文" in manifest["research"]["records"][0]["publication"]["title"]
        assert "\n" in manifest["research"]["records"][0]["publication"]["title"]
        assert manifest["research"]["records"][0]["identifiers"]["doi"] == "10.123/α"
        if not document["parts"]:
            assert manifest["counts"]["unresolvedRecords"] == 3
            assert all(item["file"] is None for item in manifest["items"])
    else:
        with zipfile.ZipFile(target) as archive:
            assert archive.testzip() is None, "CRC mismatch"
            assert len(archive.namelist()) == len(set(archive.namelist())) == 2
            manifest = json.loads(archive.read("manifest.json").decode("utf-8", errors="strict"))
            assert manifest["schema"] == "litradock.bundle-part"
            assert manifest["partNumber"] == receipt["part"]
            assert manifest["snapshotID"] == "BND-" + "a" * 32
            assert len(manifest["files"]) == len(manifest["members"]) == 1
            descriptor = manifest["files"][0]
            assert sorted(archive.namelist()) == sorted(["manifest.json", descriptor["file"]])
            original = archive.read(descriptor["file"])
            assert len(original) == descriptor["bytes"]
            assert hashlib.sha256(original).hexdigest() == descriptor["sha256"]
            assert descriptor["searchIDs"] == ["SYNTHETIC-S" + str(receipt["part"] - 1)]
            assert manifest["members"][0]["searchId"] == descriptor["searchIDs"][0]
            assert ET.fromstring(original).attrib["synthetic"] == "true"
            assert "SYNTHETIC-S2" not in descriptor["searchIDs"]
    files.append({"file": receipt["filename"], "bytes": len(data), "sha256": receipt["sha256"]})
evidence = {"scope": "SYNTHETIC captured device files; independent Python ZIP CRC/JSON/XML/SHA256", "python": sys.version,
            "outcome": "passed", "files": files, "result_sha256": hashlib.sha256((root / "result.json").read_bytes()).hexdigest()}
(root / "independent-files.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
print(json.dumps({"outcome": "passed", "files": len(files), "result_sha256": evidence["result_sha256"]}))
