"""Independent Python standard-library reader; synthetic controls are not live papers."""
import argparse, copy, datetime, json, pathlib, re
from urllib.parse import quote


def pairs(items):
    result = {}
    for key, value in items:
        assert key not in result, "duplicate JSON key"
        result[key] = value
    return result


def load(path, require_source_outcomes=False):
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
    validate(document, require_source_outcomes)
    return document


def source_outcome(r, scope, originals_revalidated):
    o = r["sourceOutcome"]
    assert set(o) == {"status", "label", "detail", "nextAction", "requestedFormat", "evidence", "observedAt", "retryEligible", "batchId", "sourceLinks"}
    assert o["status"] in {"not_checked", "stored", "stored_versions", "ready", "restricted", "retryable", "queued", "running", "paused", "cancelled", "waiting", "held", "no_deposit", "version_ambiguous", "listing_incomplete", "manuscript_tdm", "manuscript", "tdm", "no_pdf", "unsupported_source"}
    assert o["evidence"] in {"no_saved_outcome", "saved_item_outcome", "retained_source_metadata", "stored_original_descriptors", "current_original_validation"}
    # Only a containing ZIP reader that also validates every original byte may
    # admit current validation. Standalone metadata never proves readiness.
    if o["evidence"] == "current_original_validation":
        assert originals_revalidated and o["status"] in {"ready", "restricted"} and r["acquisition"]["state"] == "acquired"
    if o["status"] == "ready":
        assert o["evidence"] == "current_original_validation"
    assert all(isinstance(o[k], str) and 0 < len(o[k]) <= 2048 for k in ("label", "detail", "nextAction"))
    assert o["requestedFormat"] in {"pdf", "xml"}
    assert type(o["retryEligible"]) is bool
    assert o["batchId"] is None or isinstance(o["batchId"], str) and o["batchId"]
    if o["evidence"] == "no_saved_outcome":
        assert o["status"] == "not_checked" and not o["retryEligible"]
    if o["retryEligible"]:
        assert o["status"] == "retryable" and scope["kind"] == "run" and o["batchId"]
        assert o["evidence"] == "saved_item_outcome"
    if o["evidence"] == "retained_source_metadata":
        assert o["observedAt"] is not None and not o["retryEligible"]
    if o["observedAt"] is not None:
        # A stored-version summary or current file validation can retain the
        # earlier observation timestamp; that timestamp never grants a retry.
        assert o["evidence"] in {"retained_source_metadata", "stored_original_descriptors", "current_original_validation"}
        assert isinstance(o["observedAt"], str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})", o["observedAt"])
        assert datetime.datetime.fromisoformat(o["observedAt"].replace("Z", "+00:00")).tzinfo
        assert not o["retryEligible"]
    assert (o["status"] == "stored_versions") == (o["evidence"] == "stored_original_descriptors")
    if scope["kind"] == "run":
        # Search history is separate from acquisition.state (which is null).
        # Only descriptors of the requested format supersede a historical
        # attempt; an XML descriptor does not establish a stored PDF.
        matching = sum(original["format"].lower() == o["requestedFormat"] for original in r["originals"])
        if matching:
            assert o["status"] == ("stored" if matching == 1 else "stored_versions")
        else:
            assert o["status"] != "stored_versions"
    else:
        assert o["requestedFormat"] == r["acquisition"]["requestedFormat"]
        state = r["acquisition"]["state"]
        if state == "acquired":
            allowed = {"ready", "restricted"} if originals_revalidated else {"stored"}
        elif state in {"failed", "transient", "rate_wait"}:
            allowed = {"retryable"}
        elif state in {"queued", "running", "paused", "cancelled", "waiting"}:
            allowed = {state}
        elif state in {"unavailable", "unsupported", "held"}:
            allowed = {"held", "no_deposit", "version_ambiguous", "listing_incomplete", "manuscript_tdm", "manuscript", "tdm", "no_pdf", "unsupported_source", "restricted"}
        else:
            assert state in {None, ""}
            allowed = {"not_checked"}
        assert o["status"] in allowed
    # Recompute canonical landing links from separate identifiers. Matching two
    # equally corrupted copies is insufficient; raw or credential URLs must fail.
    ids = r["identifiers"]
    expected = {"pubmed": None, "pmc": None, "doi": None, "doiLinkState": None}
    for name, key, base in (("pubmed", "pmid", "https://pubmed.ncbi.nlm.nih.gov/"), ("pmc", "pmcid", "https://pmc.ncbi.nlm.nih.gov/articles/"), ("doi", "doi", "https://doi.org/")):
        identifier = ids[key]
        if identifier:
            if name == "doi":
                expected["doiLinkState"] = "available"
                if any(segment in {".", ".."} for segment in identifier.split("/")):
                    expected["doiLinkState"] = "unsupported_path_segments"
                    continue
            expected[name] = base + quote(identifier, safe="/") + ("" if name == "doi" else "/")
    assert o["sourceLinks"] == r["sourceLinks"] == expected


def validate(d, require_source_outcomes=False, originals_revalidated=False):
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
        assert set(r) in (allowed, allowed | {"sourceOutcome"}) and isinstance(r["searchId"], str) and r["searchId"]
        assert not require_source_outcomes or "sourceOutcome" in r
        assert isinstance(r["runIds"], list) and all(isinstance(x, str) for x in r["runIds"])
        assert set(r["identifiers"]) == {"pmid", "pmcid", "doi"}
        assert set(r["publication"]) == publication
        for value in [*r["identifiers"].values(), *r["publication"].values()]:
            assert value is None or isinstance(value, str)
        assert set(r["sourceLinks"]) == {"pubmed", "pmc", "doi", "doiLinkState"}
        assert set(r["acquisition"]) == {"state", "reason", "requestedFormat"}
        if "sourceOutcome" in r:
            source_outcome(r, d["scope"], originals_revalidated)
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


def negatives(d, require_source_outcomes=False):
    mutations = []
    x=copy.deepcopy(d); x["records"].pop(); mutations.append(x)
    x=copy.deepcopy(d); x["records"][0]["identifiers"]["pmid"]=123; mutations.append(x)
    x=copy.deepcopy(d); x["records"][1]=copy.deepcopy(x["records"][0]); mutations.append(x)
    x=copy.deepcopy(d); x["records"][0]["password"]="forbidden"; mutations.append(x)
    x=copy.deepcopy(d); x["records"][0]["publication"].pop("abstract"); mutations.append(x)
    x=copy.deepcopy(d); x["queryContexts"][0]["retrievalComplete"]=not x["queryContexts"][0]["retrievalComplete"]; mutations.append(x)
    if "sourceOutcome" in d["records"][0]:
        legacy = copy.deepcopy(d)
        for record in legacy["records"]: record.pop("sourceOutcome", None)
        validate(legacy)  # Previously frozen records remain readable without rewriting.
        if require_source_outcomes: mutations.append(legacy)
        for key, value in (("password", "forbidden"), ("status", "ready"), ("status", "invented_success"), ("evidence", "current_original_validation"), ("requestedFormat", "html"), ("retryEligible", 1), ("retryEligible", True), ("observedAt", "2026-01-01T00:00:00Z"), ("nextAction", "")):
            x=copy.deepcopy(d); x["records"][0]["sourceOutcome"][key]=value; mutations.append(x)
        x=copy.deepcopy(d); x["records"][0]["sourceOutcome"]["sourceLinks"]["doi"]="https://user:secret@doi.org/private?token=forbidden"; mutations.append(x)
        x=copy.deepcopy(d)
        for links in (x["records"][0]["sourceLinks"], x["records"][0]["sourceOutcome"]["sourceLinks"]): links["pmc"]="https://pmc.ncbi.nlm.nih.gov/articles/PMC999999999/"
        mutations.append(x)
        x=copy.deepcopy(d); x["records"][0]["sourceOutcome"].update(evidence="retained_source_metadata", observedAt="not-a-date"); mutations.append(x)
        for status, retry in (("stored", False), ("retryable", True)):
            x=copy.deepcopy(d); x["records"][0]["sourceOutcome"].update(status=status, evidence="no_saved_outcome", observedAt=None, retryEligible=retry, batchId="BAT-SYNTHETIC-NO-EVIDENCE"); mutations.append(x)
        if d["scope"]["kind"] == "run":
            # Positive controls preserve null run acquisition and distinguish
            # historical attempts, stored PDF descriptors and unrelated XML.
            history = copy.deepcopy(d)
            r = history["records"][0]
            r["acquisition"] = {"state": None, "reason": None, "requestedFormat": None}
            r["originals"] = []
            r["sourceOutcome"].update(status="retryable", evidence="saved_item_outcome", observedAt=None, retryEligible=True, batchId="BAT-SYNTHETIC-HISTORY", requestedFormat="pdf")
            validate(history, require_source_outcomes)
            original = {"kind": "source_original", "format": "XML", "mediaType": "application/xml", "depositVersion": "1", "version": "synthetic", "sha256": "0"*64, "bytes": 1, "sourceUri": None, "rightsUri": None, "repositoryStamp": None, "acquiredAt": "2026-01-01T00:00:00Z", "availability": "not_revalidated"}
            r["originals"] = [original]
            validate(history, require_source_outcomes)  # XML cannot suppress a PDF retry.
            r["originals"][0].update(format="PDF", mediaType="application/pdf")
            mutations.append(copy.deepcopy(history))  # Stored PDF must suppress the retry.
            r["sourceOutcome"].update(status="stored", retryEligible=False, batchId=None)
            validate(history, require_source_outcomes)  # Descriptor without a saved batch.
            r["originals"].append(dict(original, sha256="1"*64, depositVersion="2"))
            mutations.append(copy.deepcopy(history))  # Do not collapse distinct versions.
            r["sourceOutcome"].update(status="stored_versions", evidence="stored_original_descriptors", observedAt="2026-01-01T00:00:00Z")
            validate(history, require_source_outcomes)  # Preserve a retained observation.
            r["originals"] = []
            r["sourceOutcome"].update(status="stored", evidence="saved_item_outcome", observedAt=None, batchId="BAT-SYNTHETIC-HISTORY")
            validate(history, require_source_outcomes)  # History alone still needs validation.
    for x in mutations:
        try: validate(x, require_source_outcomes)
        except (AssertionError, KeyError, TypeError, ValueError): continue
        raise AssertionError("consequential malformed export accepted")
    return len(mutations)


if __name__ == "__main__":
    ap=argparse.ArgumentParser(); ap.add_argument("files", nargs="+"); ap.add_argument("--synthetic", action="store_true"); ap.add_argument("--negative-controls", action="store_true"); ap.add_argument("--require-source-outcomes", action="store_true")
    args=ap.parse_args(); docs=[load(p, args.require_source_outcomes) for p in args.files]
    for d in docs:
        if args.synthetic: synthetic(d)
    controls=sum(negatives(d, args.require_source_outcomes) for d in docs) if args.negative_controls else 0
    if len(docs)==2:
        assert docs[0]["records"] == docs[1]["records"] and docs[0]["counts"] == docs[1]["counts"]
    print(json.dumps({"reader":"Python standard json UTF-8", "files":len(docs), "records":[len(d["records"]) for d in docs], "synthetic":args.synthetic, "require_source_outcomes":args.require_source_outcomes, "rejected_mutations":controls}))
