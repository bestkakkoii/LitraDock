# Third-party inventory for source validation

Project source is GNU AGPL-3.0-only (LICENSE). Dependency licenses apply to their respective components. This preview carries no claim of production readiness, scholarly content rights or additional commercial licensing.

| Component | Version | Evidence / terms |
| --- | --- | --- |
| Playwright | 1.63.0 | Apache-2.0, browser automation test dependency; downloaded Chromium and OS libraries have separate notices; https://github.com/microsoft/playwright/blob/v1.63.0/LICENSE; no browser binary in source snapshot |
| PdfPig | 0.1.14 | Apache-2.0; installed NuGet nuspec points to commit 88172af1c4d4f440949f59c94966c3880e3f6032; https://github.com/UglyToad/PdfPig/blob/88172af1c4d4f440949f59c94966c3880e3f6032/LICENSE; PDF parser dependency, original-paper rights remain separate |
| Npgsql | 10.0.3 | PostgreSQL License, installed NuGet nuspec and upstream LICENSE; https://github.com/npgsql/npgsql/blob/v10.0.3/LICENSE |
| Microsoft.Data.Sqlite / Core | 10.0.12 | MIT, installed NuGet nuspec; https://github.com/dotnet/efcore/blob/v10.0.12/LICENSE.txt |
| SQLitePCLRaw components | 2.1.12 | Apache-2.0 wrapper notices and native SQLite notices; https://github.com/ericsink/SQLitePCL.raw/blob/v2.1.12/LICENSE.TXT |
| .NET / ASP.NET Core | target 10.0 | Runtime supplied by operator/CI, not bundled; https://github.com/dotnet/aspnetcore/blob/main/LICENSE.txt |
| PostgreSQL | proposed CI 18.6 | PostgreSQL License, official image also contains OS packages with separate terms; image not included in snapshot |
| pglast | 8.4, optional offline SQL grammar tooling | GPL-3.0-or-later wrapper plus embedded parser notices; test tool only, not app runtime or bundled binary; inspect upstream https://github.com/lelit/pglast before redistribution |

Locked package references include transitive packages and content hashes. The source snapshot carries no restored binaries; package managers retrieve dependencies under their own terms. Runtime/source distribution review, complete notices and native dependency security review remain release requirements. No third-party paper or extracted full text is included.

Research worker additions: citeproc2.4.63 is used under the AGPLv3 option in its actual packaged LICENSE (npm's AGPL-1.0 metadata is inaccurate); @xmldom/xmldom0.9.12 and parse5 8.0.1 are MIT; transitive entities8.1.0 is BSD-2-Clause. Playwright and playwright-core1.63.0 are Apache-2.0 and now also drive bounded offline document printing. Exact npm integrity hashes are locked; full packaged license notices are retained in src/document-worker/assets. Chromium153.0.8010.12 is operator-downloaded with its own notices and is not in the source snapshot; .NET and Node runtime redistribution needs their respective notices.

Official APA and IEEE CSL styles are pinned to citation-style-language/styles5ad473309db057f70865f5bf3df4a8bb50617bb9 under CC-BY-SA3.0. en-US locale is pinned to citation-style-language/localesa89adece41013402236e2c9020972d7e931fbab8. Noto Sans CJK TC regular uses SIL-OFL1.1 at notofonts/noto-cjkf8d157532fbfaeda587e826d4cd5b21a49186f7c; unmodified font setup verifies its committed SHA256/length. Style metadata retains attribution/rights; assets-manifest.json records exact upstream URLs and hashes. No ownership over these third-party assets is asserted.

PyMuPDF1.28.2 is an independent synthetic PDF extraction/raster verification tool under its AGPL option, not an application runtime dependency or redistributed binary. Its MuPDF/native libraries have their own included notices. Windows verification may require an available Visual C++ runtime; the actual test environment and prerequisites are evidence-specific, not clean-machine support. No commercial license has been purchased or signed.

The pinned en-US locale declares CC-BY-SA 3.0 in its own `<rights>` element; translator attribution and that declaration remain intact.

Independent test consumers are rispy0.10.0 (MIT), bibtexparser2.0.1 (MIT) and its pylatexenc2.11 dependency (MIT). The installed2.0.1 metadata/license differs from older bibtexparser1.x LGPL/BSD documentation; no old-version license assumption is used. Exact test-only wheel hashes for these and PyMuPDF1.28.2 are pinned in tests/documents/requirements.txt and dependency-receipt.json. The initial binary-only attempt at bibtexparser1.4.4 had no matching wheel; no source build ran. Pyparsing3.2.5 was inspected locally but is not a2.0.1 runtime dependency or CI requirement.
