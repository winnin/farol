# Changelog

## Unreleased

- **Comments and formatting are not risk.** A modified TypeScript/JavaScript file whose code prints the same without comments (TypeScript printer) is `declarations-additive` with no reach, like Go and Python files already were, and every comments-only file (`commentsOnly` in the JSON) adds nothing to the merge risk. Comments that change emitted or bundled code (`@jsxImportSource`, `#__PURE__`, `webpackChunkName`) still count as code. Found on a contributor's PR, where two files with only doc comments changed weighed 12 points.

## 0.2.1 — 2026-10-26

- **PR comment follows the report.** Merge risk and verdict in the title, one sentence on where the risk comes from, *Must check* as a task list, the High and Medium files with their share of the score, and how much new code is tested; the other signals move to a collapsed *All signals* block. Points match the report: a file's findings are parts of their own (a file no longer shows "risk 34" with its security finding inside).
- **Diff coverage: files left out on purpose are no longer untested.** A changed file missing from the coverage report is excluded by the project when the report shows it lists files no test loaded (Vitest `coverage.include`, coverage.py `source`, Jest `collectCoverageFrom` when an unloaded file has top-level code); files that only declare things (types, static constants) have nothing to run. Both, and `signals.coverageIgnore` files, keep half their risk instead of all of it, and the report lists them apart.
- **Report: syntax highlighting in the diffs** (TypeScript/JavaScript, Go, Python, GraphQL) and **the whole screen width** for the review area; running text keeps a readable width.
- **Social preview image** in the new look.
- **Routes with a computed path are no longer safe by default** ([#6](https://github.com/winnin/farol/issues/6)). In Python (FastAPI, Flask), Go and TypeScript REST (Express, Fastify), a route whose path is computed at run time is `dynamic-route` (the PR is `unknown`) when the PR adds it or changes the file that registers it: it may take the URL of an existing route. TypeScript REST used to drop such routes; they are now entry points. Untouched ones stay as they were.
- **Go: no toolchain download.** `go list` in the analyzed repository runs with `GOTOOLCHAIN=local`: a `go.mod` that needs a newer Go than the installed one makes the analysis `unknown` with that message, instead of trying to download a toolchain (`analyze` never uses the network).
- **Example workflows: coverage even when a test fails** (`--coverage.reportOnFailure`): Vitest writes no report after a failing run by default, and farol then counted every changed line as untested.
- **Command-line tools in TypeScript.** With `"surface": "backend"`, commander, cac and yargs commands are entry points (`CLI analyze`), like REST endpoints: a change is ranked by the commands that run it (`backend.cli`, on by default).
- **farol reviews its own pull requests** (`.github/workflows/farol.yml`), with the action of the pull request itself (read-only) and the coverage of its tests; `farol-comment.yml` (`workflow_run`) posts the comment. `report` takes `--since-in` / `--since-report-url` like `comment`.
- **What farol could not read goes to Must check.** An `unknown` part of the score is checked by hand, never cleared by reviewing a file: a low score with such a part no longer says "likely safe to approve".

## 0.2.0 — 2026-10-26

- **New HTML report: a review workbench.** A side rail with the live merge risk, *Must check* (breaking contract changes, security findings, lint errors and vulnerable dependencies, each confirmed on its own) and the files by risk (High, Medium, Skim, Test files), each with a "reviewed" box. One file at a time with its diff, the lines no test ran marked, and links to comment on any line in GitHub. A dependency view with the bump and how to check it. *Can affect* with the pages to try by hand and feature flags. *Results*: a Markdown record of the review for the PR comment. The risk turns green when it is low and nothing is left to check. The former sections stay in *Details*.
- **Merge risk score:** dependency bumps weigh by how much they can break (a 0.x minor 8 points instead of 25); a lint error on the line of a security finding counts once; findings in files outside the project no longer count.
- **Website and demo** follow the new report.

## 0.1.3 — 2026-10-24

- **npm package:** leaves out Python bytecode (`__pycache__`), which earlier packages carried by mistake. 0.1.3 is the first version on npm; 0.1.1 and 0.1.2 were unpublished.

## 0.1.2 — 2026-10-24

- **GitHub Marketplace:** `action.yml` at the repository root (the Marketplace reads it there), the same action as `action/action.yml`, which keeps working for `uses: winnin/farol/action@…`.
- **Website and live demo:** https://winnin.github.io/farol/ (the package's homepage), with the CI reports of a demo pull request.

## 0.1.1 — 2026-10-22

- **npm:** published as `@winninjs/farol` (`npm install --global @winninjs/farol` or `npx @winninjs/farol`), with no runtime dependencies (they are bundled in `dist/cli.js`).

## 0.1.0 — 2026-10-21 (first public release)

- **Roles:** each `roles` key left out keeps the default of the project's language (setting `roles.global` in a Python project no longer turns Python tests into code).
- **Test plan follows the review:** items whose changed files are all reviewed are marked (✓ files reviewed, or 🚩 behind a flag).
- **Monorepos:** a lockfile or manifest of another language above the project (a root `bun.lock` for a Python backend) no longer makes its PRs `global`.
- **FastAPI contracts:** dependencies declared through an alias (`CurrentUser = Annotated[User, Depends(…)]`) are no longer read as the request body.
- **Barrels:** adding a name to an existing `export { … } from` list is additive (generated clients no longer affect every page).
- **Python prefixes:** `include_router(…, prefix=settings.API_V1_STR)` reads the settings default; other non-literal paths keep their routes as `{expr}` instead of making the PR `unknown`.
- **Inline diffs:** a large new file shows its first 1,000 lines (it showed nothing over 400); oversized hunks are cut instead of dropped.
- **Go precision:** route paths that are not constants keep their entry point (`POST {path + "*"}`) instead of making the PR `unknown`; `String`, `Error`, `MarshalJSON`… called through library interfaces no longer reach every implementation; constants are compared by value, so appending to an `iota` group changes nothing else.
- **Next.js and TanStack Router:** `routes.adapter` `next` (Pages Router, App Router, middleware) and `tanstack-router` (file-based routes, `createFileRoute` ids) read file-system routing, with layouts, dynamic segments and route groups.
- **Docs:** README rewritten around recipes per stack and a guide to each part of the review, with screenshots; every command, option and key moved to `docs/reference.md`. Example workflows follow the CI pattern used in production: farol runs after the tests and reuses their reports, a new comment per push with the report since the last push, HTML reports that open in the browser, optional daily Datadog job.
- **Result tab:** a Markdown record of the review (flags, reviewed files, checked findings and contract changes, initial and final risk) to paste in the PR; flag panel at the top; Reviewers tab.
- **`farol reviewers`:** reviewers by who wrote the changed code (git blame, weighed by risk), added to the HTML and the comment with `--reviewers`.
- **🚩 Behind a feature flag:** mark pages/operations as flagged in the HTML report; files only they use leave the review.
- **Contract changes (backends):** GraphQL (graphql-js rules), FastAPI (parameters, body, response, Pydantic models), Go handlers and gRPC: breaking, dangerous and safe changes per endpoint, removed endpoints, and the services that call them (Datadog).
- **Traffic from Datadog (optional):** `farol usage` reads RUM page views and APM requests per operation into `usage.json`; `analyze --usage` shows the traffic of the affected pages/operations in the comment and the HTML report (information only).
- **Production errors (optional):** RUM errors per page, APM error spans per operation and Error Tracking issues attributed to the changed files that threw them.

### Foundations

- **Languages:**
  - TypeScript/React frontends (React Router), TypeScript/JavaScript backends (GraphQL, REST).
  - Go: chi, gin, echo, net/http, gRPC, binaries.
  - Python: FastAPI, Flask, Django, MCP, Celery, Temporal, Prefect, scripts.
- **Analysis:**
  - Declaration-level reach: TypeScript type checker, `go/types`, Python `ast` with local type inference.
  - Classification (`isolated`, `touches-existing`, `global`, `unknown`) with reason codes.
- **Review aids:** merge risk score weighted by diff coverage, review verdict and plan, inline diffs, manual test checklist, "mark files as reviewed".
- **Signals:** diff coverage, lint, security (built-in, gosec, bandit), vulnerabilities, suppressions, modified tests, dependency changes.
- **Reports:** JSON, PR comment and single-file HTML report.
- **Workflow and tools:** GitHub Action with HTML artifact, incremental mode (`--since`), suggested reviewers (`--reviewers`), `routes`, `impact`, `history` and `calibrate` commands, Go/Python helper cache.
