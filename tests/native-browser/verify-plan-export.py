"""Independent standard JSON/ZIP reader; optional pypdf verifies device media.

Synthetic controls are explicitly isolated and are never source qualification.
"""
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import pathlib
import sys
import zipfile

spec = importlib.util.spec_from_file_location("structured_reader", pathlib.Path(__file__).with_name("verify-structured.py"))
structured = importlib.util.module_from_spec(spec)
previous_bytecode = sys.dont_write_bytecode
try:
    sys.dont_write_bytecode = True
    spec.loader.exec_module(structured)
finally:
    sys.dont_write_bytecode = previous_bytecode


def decode(raw):
    assert len(raw) <= 8 * 1024 * 1024 and not raw.startswith(b"\xef\xbb\xbf")
    return json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=structured.pairs)


def validate(d, members=None):
    assert set(d) == {"schema", "schemaVersion", "type", "generatedAt", "plan", "research", "items", "originalsRevalidated", "counts"}
    assert d["schema"] == "litradock.plan-export" and type(d["schemaVersion"]) is int and d["schemaVersion"] == 1
    assert d["type"] == "document" and type(d["originalsRevalidated"]) is bool
    structured.validate(d["research"])
    scope = d["research"]["scope"]
    assert scope == {"planId": d["plan"]["planID"], "kind": "plan", "runId": None, "batchId": None, "selection": "all_saved_scope"}
    records, items = d["research"]["records"], d["items"]
    assert 1 <= len(items) <= 100
    assert len(items) == len(records) == d["counts"]["members"] == d["plan"]["selectedCount"]
    phases = {"waiting", "queued", "running", "completed", "held", "retry", "paused", "cancelled"}
    assert set(d["plan"]["counts"]) == phases
    assert sum(d["plan"]["counts"].values()) == len(items)
    assert [i["searchId"] for i in items] == [r["searchId"] for r in records]
    assert [i["rank"] for i in items] == list(range(1, len(items) + 1))
    files = {}
    included = 0
    for phase in phases:
        assert sum(i["phase"] == phase for i in items) == d["plan"]["counts"][phase]
    for item, record in zip(items, records):
        assert set(item) == {"searchId", "rank", "childBatchId", "acquisitionState", "phase", "reason", "originalHash", "availability", "availabilityReason", "file", "original"}
        assert item["phase"] in phases and isinstance(item["reason"], str)
        assert record["acquisition"]["state"] == item["acquisitionState"]
        assert record["acquisition"]["reason"] == (item["reason"] or None)
        if item["availability"] == "included":
            assert d["originalsRevalidated"] and item["acquisitionState"] == "acquired"
            original = item["original"]
            assert original["kind"] == "source_original" and original["availability"] == "included"
            assert original["sha256"] == item["originalHash"]
            assert original["format"] in {"PDF", "XML"}
            assert item["file"] == "originals/" + original["sha256"] + "." + original["format"].lower()
            assert original["sourceUri"] and original["rightsUri"] and item["availabilityReason"] is None
            data = members[item["file"]]
            assert len(data) == original["bytes"] and hashlib.sha256(data).hexdigest() == original["sha256"]
            files[item["file"]] = data
            included += 1
        else:
            assert item["availability"] in ({"unavailable", "not_acquired"} if d["originalsRevalidated"] else {"not_revalidated", "not_acquired"})
            assert item["file"] is None and item["original"] is None and item["availabilityReason"]
    assert set(d["counts"]) == {"members", "includedRecords", "unresolvedRecords", "uniqueOriginals", "originalBytes"}
    if d["originalsRevalidated"]:
        assert members is not None and d["counts"]["includedRecords"] == included
        assert d["counts"]["unresolvedRecords"] == len(items) - included
        assert d["counts"]["uniqueOriginals"] == len(files)
        assert d["counts"]["originalBytes"] == sum(map(len, files.values())) <= 32 * 1024 * 1024
        assert set(members) == {"manifest.json", "records.json", *files}
        assert decode(members["records.json"]) == d["research"]
    else:
        assert all(d["counts"][k] is None for k in ("includedRecords", "unresolvedRecords", "uniqueOriginals", "originalBytes"))
    return files


def load(path):
    raw = pathlib.Path(path).read_bytes()
    if path.endswith(".zip"):
        assert len(raw) <= 37 * 1024 * 1024
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            names = z.namelist()
            assert len(names) == len(set(names)) and len(names) <= 102
            assert all(not n.startswith("/") and ".." not in n.split("/") and "\\" not in n for n in names)
            assert sum(i.file_size for i in z.infolist()) <= 37 * 1024 * 1024
            members = {n: z.read(n) for n in names}  # CRC checked by independent ZIP reader.
        d = decode(members["manifest.json"])
    else:
        d, members = decode(raw), None
    files = validate(d, members)
    return d, members, files


def saved_set(d, expected):
    """Compare against the separately captured admission intent, not export-derived IDs."""
    plan, research = d["plan"], d["research"]
    assert plan["scopeKind"] == "saved_set" and plan["runID"] == ""
    assert 1 <= len(expected) <= 100
    assert len({m["searchID"] for m in expected}) == len(expected)
    assert [r["searchId"] for r in research["records"]] == [m["searchID"] for m in expected]
    sources = set()
    pairs = 0
    for record, member in zip(research["records"], expected):
        runs = member["runIDs"]
        assert runs and len(runs) == len(set(runs))
        assert record["runIds"] == sorted(runs)
        sources.update(runs)
        pairs += len(runs)
    assert pairs <= 1000
    assert plan["sourceRunIDs"] == sorted(sources)
    assert {q["runId"] for q in research["queryContexts"]} == sources
    assert research["counts"]["providerMatches"] is None
    assert research["counts"]["retrievedRecords"] is None


def saved_set_negatives(d, expected):
    mutations = []
    x = copy.deepcopy(d); x["plan"]["runID"] = "invented-combined-run"; mutations.append(x)
    x = copy.deepcopy(d); x["plan"]["sourceRunIDs"] = []; mutations.append(x)
    x = copy.deepcopy(d); x["research"]["records"][0]["runIds"].append("later-unselected-run"); mutations.append(x)
    x = copy.deepcopy(d); x["research"]["records"][0]["runIds"] = []; mutations.append(x)
    x = copy.deepcopy(d); x["research"]["counts"]["providerMatches"] = 99999; mutations.append(x)
    if len(expected) > 1:
        x = copy.deepcopy(d); x["research"]["records"].reverse(); mutations.append(x)
    for x in mutations:
        try:
            saved_set(x, expected)
        except AssertionError:
            continue
        raise AssertionError("Changed saved-set provenance accepted")
    return len(mutations)


def negatives(d, members):
    mutations = []
    x = copy.deepcopy(d); x["items"].pop(); mutations.append((x, members))
    x = copy.deepcopy(d); x["items"][0]["searchId"] = "foreign"; mutations.append((x, members))
    x = copy.deepcopy(d); x["research"]["records"][0]["identifiers"]["pmid"] = 123; mutations.append((x, members))
    x = copy.deepcopy(d); x["research"]["records"][0]["password"] = "forbidden"; mutations.append((x, members))
    x = copy.deepcopy(d); x["plan"]["counts"]["waiting"] += 1; mutations.append((x, members))
    if members is not None:
        x = copy.deepcopy(d); x["counts"]["uniqueOriginals"] += 1; mutations.append((x, members))
        x = copy.deepcopy(members); x["unexpected.txt"] = b"x"; mutations.append((d, x))
        name = next((n for n in members if n.startswith("originals/")), None)
        if name:
            x = copy.deepcopy(members); del x[name]; mutations.append((d, x))
            x = copy.deepcopy(members); x[name] += b"modified"; mutations.append((d, x))
    for value, files in mutations:
        try:
            validate(value, files)
        except (AssertionError, KeyError, TypeError):
            continue
        raise AssertionError("Consequential malformed plan export accepted")
    return len(mutations)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+")
    parser.add_argument("--negative-controls", action="store_true")
    parser.add_argument("--pdf", action="store_true")
    parser.add_argument("--synthetic", action="store_true")
    parser.add_argument("--synthetic-transport", action="store_true", help="Label isolated synthetic data without imposing the legacy 100-record fixture")
    parser.add_argument("--expected-saved-set", type=pathlib.Path)
    args = parser.parse_args()
    result = []
    for path in args.files:
        d, members, originals = load(path)
        saved_controls = 0
        if args.expected_saved_set:
            expected = decode(args.expected_saved_set.read_bytes())
            saved_set(d, expected)
            saved_controls = saved_set_negatives(d, expected)
        pages = []
        if args.pdf:
            from pypdf import PdfReader
            for name, data in originals.items():
                if name.endswith(".pdf"):
                    reader = PdfReader(io.BytesIO(data), strict=False)
                    assert not reader.is_encrypted and len(reader.pages) > 0
                    pages.append({"sha256": hashlib.sha256(data).hexdigest(), "pages": len(reader.pages)})
        if args.synthetic:
            assert len(d["items"]) == 100 and d["research"]["queryContexts"][0]["providerMatches"] == 25001
            assert not d["research"]["queryContexts"][0]["retrievalComplete"]
            assert d["research"]["records"][0]["publication"]["title"] == 'SYNTHETIC 醫學 😀 "quote"\nline'
            assert d["research"]["records"][0]["publication"]["abstract"] == '=SUM(1,2)\n資料'
            if members is not None:
                assert d["counts"]["includedRecords"] == 3 and d["counts"]["uniqueOriginals"] == 2
                assert d["items"][0]["file"] == d["items"][1]["file"] != d["items"][2]["file"]
                assert d["items"][2]["original"]["depositVersion"] == "2"
        result.append({"file": pathlib.Path(path).name, "members": len(d["items"]), "counts": d["counts"], "pdfs": pages, "savedSetNegativeControls": saved_controls, "negativeControls": negatives(d, members) if args.negative_controls else 0})
    print(json.dumps({"pass": True, "synthetic": args.synthetic or args.synthetic_transport, "files": result}))
