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
