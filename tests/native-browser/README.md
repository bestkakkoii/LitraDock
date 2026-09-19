# Native browser regression

Pass `--staged-query` with a fresh database/output to exercise schema-11 saved
query capture. The closed browser transport tests the original Boolean/fielded
query, a 10,001-match source fixture through complete date/complement segments,
cancelled and lost-reply recovery, no automatic source continuation, missing
metadata and exact durable choices. A separate, explicitly seeded 20,000-record
fixture measures bounded rendering and one-click whole selected metadata ZIPs.
Every file hash, exported membership, no-source reopen/export, foreign-account
denial and 1280/390px layout is checked. Seeded metadata is not evidence of live
PubMed capacity. The shipped server contains no fixture entry point.

This test suite uses pinned Playwright and fflate only for isolated acceptance, not product runtime dependencies. It runs actual native Go handlers/workers, compiled React assets and a fresh PostgreSQL database. The provider transport is closed and returns explicitly synthetic XML; no external source or public demo is contacted. Browser evidence is separate from genuine-source qualification.

Use the exact public source commit and its generated runtime manifest. Install test dependencies with `npm ci` and `npx playwright install --with-deps chromium`. Create an empty database whose name starts `litradock_native_test_browser_` and provide a private JSON config containing its `Database` connection string. Do not supply a production database. From repository root:

```sh
python3 scripts/run-native-browser.py --revision "$EXACT_REVISION" --config "$PRIVATE_CONFIG" --manifest "$RUNTIME_MANIFEST" --frontend-directory "$COMPILED_WEB" --output-directory "$NEW_TEST_OUTPUT"
```

The driver compiles a test-only server, verifies source/static manifest correspondence, requires an empty explicit test database, and writes generated accounts into a protected input file. It binds an ephemeral loopback port and uses a bounded lifetime. Normal production builds do not include this entry or synthetic transport. The caller owns disposal of the isolated database/output; the driver never deletes a database. Test input/config are excluded from CI artifacts and runtime source packages.

Assertions cover actual login/library creation, queued/loading and provider403 error, large synthetic total versus three retrieved records, selected durable batch, two exact XML downloads, CSV/ZIP members/CRC/bytes/rights/held links, saved-work reload/relogin without another POST, populated desktop/narrow layout and account B ownership denial. Synthetic transport failures and real-source acceptance are different evidence. Source mutation controls, native engine transaction/lease/recovery tests and physical-device qualification remain separate.

The harness can be run directly with `NATIVE_BROWSER_INPUT` pointing to the driver's private JSON file and `NATIVE_BROWSER_URL` matching its origin. The input contains exactly two accounts, source revision, local runtime manifest and two expected original hashes/sizes. An optional `NATIVE_BROWSER_EXECUTABLE` selects an already qualified local Chromium binary. No default browser is opened. Missing/unsafe input or changed assets must fail; absent runtime/PG input is not a passing browser test.

Install the independent test reader in a virtual environment with `python3 -m pip install --require-hashes -r tests/native-browser/workbook-requirements.txt`, and set `NATIVE_WORKBOOK_PYTHON` to that environment's Python executable. `verify-workbook.py FILE --synthetic --negative-controls` checks the separately generated synthetic workbook and rejects numeric/formula/identifier/hyperlink/missing-row mutations. Browser XLSX downloads are compared with independently obtained native API metadata/provenance using openpyxl, not the Go writer.

Additional compiled-browser schedules exercise twelve saved records versus synthetic provider counts1000/10000/25001, five-record pages, ten-selection cap/eleventh denial, exact cross-page selected IDs, same-run page persistence, changed-run/library clearing, and a delayed real native XLSX response released after run change. A same-session successful owned export precedes wrong-library export denial. Synthetic transport counts are not live provider retrieval. Physical Excel/Mac/mobile support remains unverified.

Pass `--plans` to the driver, with a separate fresh database/output, for the processing-plan suite. It uses 100 explicitly synthetic saved records versus a provider total of 25001 and selects 37 across pages. A test-only body-release file pins actual native in-flight pause/resume; one closed-transport 429 requires explicit retry after its advertised cooldown. The suite checks same-request replay after a lost POST response, four server-created child groups, two distinct original hashes, held reasons, independent XLSX parsing, CSV/ZIP bytes, confirmed cancellation, GET-only reopen and tenant denial. The test pool matches production's eight connections. No body gate or synthetic provider transport exists in the shipped binary. A captured file replay remains different from genuine live integration.
