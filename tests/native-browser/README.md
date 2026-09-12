# Native browser regression

This test suite uses pinned Playwright and fflate only for isolated acceptance, not product runtime dependencies. It runs actual native Go handlers/workers, compiled React assets and a fresh PostgreSQL database. The provider transport is closed and returns explicitly synthetic XML; no external source or public demo is contacted. Browser evidence is separate from genuine-source qualification.

Use the exact public source commit and its generated runtime manifest. Install test dependencies with `npm ci` and `npx playwright install --with-deps chromium`. Create an empty database whose name starts `litradock_native_test_browser_` and provide a private JSON config containing its `Database` connection string. Do not supply a production database. From repository root:

```sh
python3 scripts/run-native-browser.py --revision "$EXACT_REVISION" --config "$PRIVATE_CONFIG" --manifest "$RUNTIME_MANIFEST" --frontend-directory "$COMPILED_WEB" --output-directory "$NEW_TEST_OUTPUT"
```

The driver compiles a test-only server, verifies source/static manifest correspondence, requires an empty explicit test database, and writes generated accounts into a protected input file. It binds an ephemeral loopback port and uses a bounded lifetime. Normal production builds do not include this entry or synthetic transport. The caller owns disposal of the isolated database/output; the driver never deletes a database. Test input/config are excluded from CI artifacts and runtime source packages.

Assertions cover actual login/library creation, queued/loading and provider403 error, large synthetic total versus three retrieved records, selected durable batch, two exact XML downloads, CSV/ZIP members/CRC/bytes/rights/held links, saved-work reload/relogin without another POST, populated desktop/narrow layout and account B ownership denial. Synthetic transport failures and real-source acceptance are different evidence. Source mutation controls, native engine transaction/lease/recovery tests and physical-device qualification remain separate.

The harness can be run directly with `NATIVE_BROWSER_INPUT` pointing to the driver's private JSON file and `NATIVE_BROWSER_URL` matching its origin. The input contains exactly two accounts, source revision, local runtime manifest and two expected original hashes/sizes. An optional `NATIVE_BROWSER_EXECUTABLE` selects an already qualified local Chromium binary. No default browser is opened. Missing/unsafe input or changed assets must fail; absent runtime/PG input is not a passing browser test.
