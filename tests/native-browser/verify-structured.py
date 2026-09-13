"""Independent Python standard-library reader; synthetic controls are not live papers."""
import argparse, copy, json, pathlib


def pairs(items):
    result = {}
    for key, value in items:
        assert key not in result, "duplicate JSON key"
        result[key] = value
    return result


def load(path):
    raw = pathlib.Path(path).read_bytes()
    assert len(raw) <= 8 * 1024 * 1024 and not raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8", errors="strict")
    if str(path).endswith(".jsonl"):
        lines = text[:-1].split("\n")
        assert text.endswith("\n") and all(lines)
        values = [json.loads(line, object_pairs_hook=pairs) for line in lines]
        document = values[0]
        assert document["type"] == "manifest" and "records" not in document
        assert all(v.get("type") == "record" and set(v) == {"type", "record"} for v in values[1:])
        document["records"] = [v["record"] for v in values[1:]]
    else:
        document = json.loads(text, object_pairs_hook=pairs)
        assert document["type"] == "document"
    validate(document)
    return document


def validate(d):
    assert set(d) == {"schema", "schemaVersion", "type", "generatedAt", "scope", "counts", "queryContexts", "records"}
    assert d["schema"] == "litradock.research-export" and type(d["schemaVersion"]) is int and d["schemaVersion"] == 1
    records = d["records"]
    assert 1 <= len(records) <= 1000
    assert d["counts"]["exportedRecords"] == d["counts"]["scopeRecords"] == len(records)
    assert d["scope"]["selection"] == "all_saved_scope"
    assert len({r["searchId"] for r in records}) == len(records)
    allowed = {"searchId", "runIds", "identifiers", "publication", "sourceLinks", "acquisition", "originals"}
    publication = {"title", "authors", "year", "journal", "publicationDate", "articleNumber", "pages", "abstract", "publicationTypes", "retrievedAt"}
    for r in records:
        assert set(r) == allowed and isinstance(r["searchId"], str) and r["searchId"]
        assert isinstance(r["runIds"], list) and all(isinstance(x, str) for x in r["runIds"])
        assert set(r["identifiers"]) == {"pmid", "pmcid", "doi"}
        assert set(r["publication"]) == publication
        for value in [*r["identifiers"].values(), *r["publication"].values()]:
            assert value is None or isinstance(value, str)
        assert set(r["sourceLinks"]) == {"pubmed", "pmc", "doi", "doiLinkState"}
        assert set(r["acquisition"]) == {"state", "reason", "requestedFormat"}
        for original in r["originals"]:
            assert set(original) == {"kind", "format", "mediaType", "depositVersion", "version", "sha256", "bytes", "sourceUri", "rightsUri", "repositoryStamp", "acquiredAt", "availability"}
            assert original["kind"] == "source_original" and original["availability"] == "not_revalidated"
            assert len(original["sha256"]) == 64 and int(original["sha256"], 16) >= 0
    for q in d["queryContexts"]:
        assert isinstance(q["query"], str) and isinstance(q["runId"], str)
        assert q["retrievalComplete"] == (q["state"] == "complete" and q["retrievedRecords"] == q["providerMatches"])


def synthetic(d):
    assert len(d["records"]) == 1000
    for i, r in enumerate(d["records"]):
        assert r["searchId"] == "0000123456789012345678901234567890-" + "0" * (i % 3) + chr(0x400 + i)
        assert r["identifiers"]["pmid"] == "0000123"
        assert r["publication"]["title"] == 'SYNTHETIC 醫學 😀 العربية "quoted"\nnext line\u0085NEL'
        assert r["publication"]["abstract"] == '=HYPERLINK("not executed")\n' + '資料' * 100
        assert r["publication"]["authors"] is None and r["publication"]["journal"] is None
    assert d["queryContexts"][0]["providerMatches"] == 25001
    assert d["queryContexts"][0]["retrievedRecords"] == 1000
    assert not d["queryContexts"][0]["retrievalComplete"]


def negatives(d):
    mutations = []
    x=copy.deepcopy(d); x["records"].pop(); mutations.append(x)
    x=copy.deepcopy(d); x["records"][0]["identifiers"]["pmid"]=123; mutations.append(x)
    x=copy.deepcopy(d); x["records"][1]=copy.deepcopy(x["records"][0]); mutations.append(x)
    x=copy.deepcopy(d); x["records"][0]["password"]="forbidden"; mutations.append(x)
    x=copy.deepcopy(d); x["records"][0]["publication"].pop("abstract"); mutations.append(x)
    x=copy.deepcopy(d); x["queryContexts"][0]["retrievalComplete"]=True; mutations.append(x)
    for x in mutations:
        try: validate(x)
        except (AssertionError, KeyError): continue
        raise AssertionError("consequential malformed export accepted")
    return len(mutations)


if __name__ == "__main__":
    ap=argparse.ArgumentParser(); ap.add_argument("files", nargs="+"); ap.add_argument("--synthetic", action="store_true"); ap.add_argument("--negative-controls", action="store_true")
    args=ap.parse_args(); docs=[load(p) for p in args.files]
    for d in docs:
        if args.synthetic: synthetic(d)
    controls=sum(negatives(d) for d in docs) if args.negative_controls else 0
    if len(docs)==2:
        assert docs[0]["records"] == docs[1]["records"] and docs[0]["counts"] == docs[1]["counts"]
    print(json.dumps({"reader":"Python standard json UTF-8", "files":len(docs), "records":[len(d["records"]) for d in docs], "synthetic":args.synthetic, "rejected_mutations":controls}))
