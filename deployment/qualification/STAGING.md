# Frozen release staging

`stage_release.py` reuses the accepted inventory anchors and archive verifier. It copies bounded inputs into an exclusive temporary directory, verifies every member before extraction, writes ordinary files only, verifies installed bytes, and renames the completed directory into a previously absent destination. It never starts services, invokes application code, writes configuration, migrates a database or changes account state.

Run from the reviewed code-only source checkout with Python 3.11 or later:

```sh
mkdir -m 700 private-staging
python3 deployment/qualification/stage_release.py --release operator --inputs retained-operator-artifacts --destination private-staging/operator
python3 tests/deployment/test_stage_release.py
```

`--release demo` selects the separate original demo anchor. Inputs are the corresponding archive and hash manifest named in `deployment/inventory/inventory.py`; counts alone never select a release. The caller must exclusively control the parent and stop concurrent writers. Linked ancestors, existing destinations, malformed archives, missing/extra/modified files and fixture/private paths reject. Windows junction ancestors use the same shared guard. On POSIX the parent must be caller-owned mode0700; this private staging ownership is **not** final production ownership.

An ordinary exception or Python interruption removes incomplete temporary content and leaves the destination absent. Abrupt process kill or power loss can leave a private `.stage-*` directory; inspect it after confirming the process ended, then remove only that identified incomplete directory. Do not activate or resume partial content. Rename is a publication boundary, not a power-loss durability guarantee or protection against a malicious same-user concurrent writer. An existing valid destination is deliberately not overwritten on retry.

Production installation is a separate elevated operation: copy the verified content into a new root-owned release directory under trusted, non-writable ancestors; preserve hashes, give the service read access, and run `verify_installed` with the service UID. Do not run the app from a user-owned home staging path. Retain companion `deployment/notices` beside the immutable package and the external runtime's own LICENSE/ThirdPartyNotices. Use `dotnet LitraDock.Hosted.dll`; apphost executable permissions are not needed by this procedure. Keep configuration, objects and recovery roots outside code and web roots.

The full private topology, operator values and command receipts belong only to the owner's ignored private project area. Use the existing [qualification procedure](PROCEDURE.md) for proxy, TLS, session/CSRF/isolation, paired restore, rollback, resource and device evidence. `STAGED` and `activation:NOT_PERFORMED` never mean deployment acceptance. No real-provider request is part of staging tests.

RI008-01: new inventory evidence output now rejects linked ancestors before generation, retaining exclusive `xb` creation. An actual Windows junction and POSIX symlink regression covers this separately from package extraction. Frozen inventory content remains byte-identical.
