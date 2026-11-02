# Progress

Milestones from `docs/SPEC.md`. Each one is done only when its acceptance criterion passes and the commit exists.

- [x] **M0** Scaffold: package.json, tsconfig, ESLint, Vitest, tsup, CLAUDE.md, docs, CLI with `--help`
- [x] **M1** git module: merge-base, status, hunks, normalization, read at ref; test repo helper
- [x] **M2** Configuration and roles
- [x] **M3** Import graph (aliases, barrels, lazy, import type, diagnostics); `impact` command
- [x] **M4** react-router adapter; `routes` command
- [x] **M5** Additive rules, reach, classification, reasons, output schema; `analyze` command
- [x] **M6** Signals: coverage, lint, suppressions, modified tests
- [x] **M7** `report` command
- [x] **M8** `history` command
- [x] **M9** `comment` command, action.yml, example workflow, committed dist/
- [x] **M10** README and validation on the real frontend

## Log

### M0 — done (2026-10-17)
- npm project with exact pins (TypeScript 6.0.3, see DECISIONS), strict ESM tsconfig, typescript-eslint strict type-checked config with `max-lines: 400` and a ban on `exec`/`execSync`, Vitest, tsup bundling everything into `dist/cli.js`.
- CLI skeleton (commander) with all six commands and the global flags; `node dist/cli.js --help` lists them.
- Pending: nothing.

### M1 — done (2026-10-17)
- `src/git/parse.ts` (pure): `-z` name-status parser, unified diff parser (renames, binary, quoted paths, `\ No newline`), hunk normalization (trailing comma/whitespace pairs dropped, greedy in-order matching).
- `src/git/index.ts`: `resolveCommit`, `mergeBase`, `diffFiles`, `showFile`, `listFiles`, `readFiles` (one `cat-file --batch` process), `listMerges`, `originUrl`. Always via `execFile`, with flags that neutralize user git config.
- `test/helpers/repo.ts`: deterministic temp repos (fixed identity/dates, no global config) and the scenario builder (`_base-app` + `base/` overlay, then `head/` + `deleted.txt`).
- Tests: unit tests for hunks and normalization; real repo test covering added/modified/deleted/renamed, merge-base, reads and merge listing.
- Pending: nothing.

### M2 — done (2026-10-17)
- `src/config/schema.ts` (zod, strict, defaults) and `src/config/load.ts` (`UsageError` with actionable messages: file not found, invalid JSON, one line per issue with its path, unknown keys).
- `src/classify/roles.ts`: role precedence global > routes > test > story > barrel > i18n > source, `exclude` handling.
- `src/cli/context.ts` (project dir, repo root, prefix) and `src/cli/run.ts` (exit codes 0/1/2).
- Tests: unit tests for config and role precedence; e2e tests on the built binary for exit code 1 (invalid config, missing file, bad JSON, usage errors). `globalSetup` rebuilds `dist/` before tests.
- Pending: nothing.

### M3 — done (2026-10-17)
- `src/project/fs.ts` (git-tree file system with disk fallback for node_modules), `program.ts` (tsconfig incl. solution-style references, `noLib`), `resolve.ts` (compiler resolution + non-TS assets + project/package distinction), `graph.ts` (edge kinds, barrel precision via `getAliasedSymbol`, type-only skipping, unresolved / non-literal diagnostics, parse errors, origin filter).
- `src/classify/reach.ts`: reverse BFS with barrel-edge rule, shortest chains, route anchors.
- react-router adapter (object + JSX forms) written here because `impact` needs it (see DECISIONS).
- `impact <file> [--ref]` command (JSON output).
- Tests: graph unit tests on an in-memory project; scenarios 14, 15, 16 via the built binary on real temp repos.
- Pending: nothing.

### M4 — done (2026-10-17)
- `routes [--ref]` command; adapter finished (`src/routes/react-router/*`: scope/imports, element trees, object and JSX builders, root discovery) and `src/routes/paths.ts` (path concatenation, key segments).
- Tests: adapter unit tests (object form, lazy variants, wrappers, exported arrays, every dynamic construct, JSX `<Routes>`, `createRoutesFromElements`); scenario tests on the built binary: base fixture table, scenario 11 (`.map` → dynamic diagnostic), working tree mode, missing routes file → exit 2 with actionable message.
- Pending: nothing.

### M5 — done (2026-10-17)
- `src/classify/additive.ts` (routes, barrel, i18n rules), `reasons.ts` (closed enum, effects, ordering), `classify.ts` (pure classification: roles incl. outside-project, unknown triggers, non-additive changes, reach, new files, affected routes with chains).
- `src/output/schema.ts` (zod schema of the whole JSON, signals included), `build.ts` (success / failure outputs), `write.ts` (validate + serialize).
- `analyze` command (`src/cli/analyze.ts`): merge-base, diff, head workspace from git objects, base files and base route table, classification, signals, timings; on failure writes an `unknown` JSON with the error and exits 2.
- `testsModified` signal brought forward from M6 because scenario 17 needs it.
- `docs/reasons.md` documents every code.
- Tests: 20 golden scenarios (all reviewed by hand) with per-scenario assertions; unit tests for additive rules and classification edge cases; e2e on the built binary (exit codes 0/2, schema validation, failure JSON, GITHUB_REPOSITORY); byte-for-byte determinism.
- Pending: coverage, lint and suppressions signals (M6).

### M6 — done (2026-10-17)
- `src/signals/coverage.ts` (Istanbul parsing, statement intersection, ranges, missingFromReport), `lint.ts` (ESLint JSON, changed vs other lines, top 50), `suppressions.ts` (scanner trivia + AST), `tests-modified.ts`, `paths.ts`; report reading and status mapping in `src/cli/signals.ts`.
- Tests: signal scenarios with hand-written reports (partial coverage with exact ranges, file missing from the report, ESLint on changed vs unchanged lines, suppressions vs strings, no reports, missing/malformed reports) with golden files; unit tests for each pure function.
- Pending: nothing.

### M7 — done (2026-10-17)
- `src/report/strings.ts` (every Portuguese text, feedback labels), `src/report/markdown.ts` (marker, title without class, visible signals with "não verificado", collapsed classification block with reasons, new/affected routes with chains, three feedback checkboxes, footer; 60,000-char limit with "e mais N").
- `report --in` command (`src/cli/report.ts`), invalid input → exit 1.
- Tests: file snapshots for one PR of each class plus two signal-rich PRs (`test/report/__snapshots__/*.md`), size limit with 5,000 routes and 3,000 reasons, escaping; e2e analyze → report on the built binary.
- Pending: nothing.

### M8 — done (2026-10-17)
- `history --since [--branch] [--out] [--first-parent]` (`src/cli/history.ts`): analyze each merge commit against its first parent, one JSON per merge plus `summary.json` with counts per class; `--first-parent` for squash-merge repositories (see DECISIONS).
- Tests: a repository with five `--no-ff` merges (isolated ×3, touches-existing, global) and a direct commit: five JSONs valid by the schema, exact summary; `--first-parent` includes the direct commit.
- Pending: nothing.

### M9 — done (2026-10-17)
- `src/github/client.ts` (native fetch, pagination via Link header, explained HTTP errors), `src/github/comment.ts` (marker lookup, feedback preservation, create/update/unchanged), `comment` command.
- `action/action.yml` (composite, inputs via env, runs `dist/cli.js`), `examples/workflow.yml` (two jobs, fixed to work and never block, see DECISIONS), `.github/workflows/ci.yml` (fails when `dist/` is stale).
- `dist/cli.js` is committed and reproducible (same hash on rebuild).
- Tests: mocked fetch covering creation, update on a later page, pagination, preserved ticked boxes, no-op update, HTTP error message, input validation and GitHub Enterprise URL; the action script executed with bash against a scenario repo (analyze), input validation (comment), unknown command; workflow inputs match the action.
- Pending: nothing.

### M10 — done (2026-10-17)
- README: installation, configuration (every key), supported route forms, each command, the classes, the signals, Vitest setup to report files no test loads (Vitest 4+ and 1–3), the action, the two-job security model, known limitations, how to rename `winnin/farol`.
- Validated read-only on a real React app in a monorepo. Its route tree was split across several modules (imported arrays, constant segments, lazy functions); support was added to the adapter (see DECISIONS), with `routes.extraFiles` as an opt-in. `routes` and `history --first-parent` ran without errors.

## Final summary

### What works
- Every milestone M0–M10 with its acceptance criterion; `npm ci && npm run build && npm run typecheck && npm run lint && npm test` passes from a clean clone (24 files, 137 tests, none skipped) and `dist/` is unchanged by the build.
- `analyze` (20 reviewed golden scenarios + signal scenarios), `report`, `comment` (mocked fetch), `routes`, `impact`, `history`, the composite action and the example workflow.
- Deterministic, schema-validated output; every classification explained by closed-list reason codes.

### What does not work / not done
- Route precision through barrels: a route whose component comes from a barrel (`@/modules/brand`) is anchored on the barrel module, so changes to anything that barrel re-exports reach it (conservative).
- No semantic detection of type-only imports without the `type` keyword (kept as edges on purpose).
- The workflow and action were validated locally (the action script runs under bash in tests) but not on GitHub's runners.

### Deviations from the spec (all in docs/DECISIONS.md)
- TypeScript pinned to 6.0.x (7.x has no classic compiler API).
- The react-router adapter was written in M3 because `impact` needs it; M4 added the `routes` command and its tests.
- `testsModified` signal implemented in M5 (scenario 17 needs it).
- Adapter input extended with `read`/`resolve(specifier, fromFile)` to follow route trees split across modules; optional `routes.extraFiles`; `global` globs may point above the project.
- Routes rule ignores removed lines of widened import declarations; route-table changes are reported once against `routes.file`.
- `history --first-parent` for squash-merge repositories (default unchanged).
- Suppressions use the TypeScript scanner's comment trivia on parsed tokens plus the AST, not a raw token loop.

### Limitations found
- Squash merges: the specified `history` (merge commits) finds nothing on the real repository; `--first-parent` is needed.
- History before the routes file existed fails with "routes file not found" → `unknown`. The configuration describes today's layout only.
- `**/index.ts` can match implementation files (hooks with code inside `index.ts`), producing `barrel-not-additive`; narrow `roles.barrel` then.
- Translation modules written in TS (not JSON) cannot use the i18n rule.
- The heaviest step is creating the TypeScript program (~4–5 s per commit on a large app).

## Post-v0 work (2026-10-17)

### Improvement round of 2026-10-18 (items 1, 4, 6, 8–14, 16 of the list)
- 14: the HTML report is a workflow artifact, linked at the top of the PR comment (`--report-url`); Go and Python example workflows.
- 10: manual test checklist (HTML "Test plan" section with ticks per commit; task list in the comment).
- 8 and 9 (opt-in): `--since` incremental reviews, `--reviewers` (CODEOWNERS and recent authors).
- 13: `routes`, `impact` and `history` for Go and Python.
- 6: inline diffs in the review plan, with untested lines and findings marked.
- 16: Go/Python helper outputs cached by git tree (warm runs under a second).
- 12: Go gin, echo and gRPC entry points; methods only libraries call depend on their type.
- 11: Python Flask, Django, MCP, Celery and Temporal entry points; module variables typed by their constructor.
- 4: declaration-level reach for TypeScript frontends (type checker); Python local type inference.
- 1: `calibrate` (score and verdict of past commits against reverts and fixes that followed). On 662 commits of 4 repositories (after the infra role): fast track 0 of 56; score AUC 0.72–0.83 in every repository; careful 1.6–4× quick; global changes weigh 0.3 and make a quick review (see DECISIONS).

### HTML report as a review workbench — done (0.2.0, 2026-10-26)
- Live merge risk, Must check, files by risk tier with diff and untested lines, Can affect with feature flags, Results for the PR comment; the former sections in Details. Score weights revised (dependency bumps, duplicate lint, findings outside the project). See DECISIONS 2026-10-26.
- Open: files excluded from coverage on purpose (types, constants, translations) still count as untested; the score saturates on large PRs (31 files → 84), where the reviewed count says more than the number.

### Biome lint reports — done (CHA-14802)
- `--eslint` also reads `biome lint --reporter=gitlab`; Biome security rules stay lint findings. See DECISIONS 2026-10-26.
- `biome-ignore`, `biome-ignore-all` and `biome-ignore-start` comments are suppressions; file-wide and range ones make the key finding high (CHA-14847, DECISIONS 2026-10-27).
- `generated` globs: imports of git-ignored generated code (Prisma client, protobuf types) no longer make a PR `unknown` (CHA-14807, DECISIONS 2026-10-29).
- Every lint and coverage report except the Go coverprofile (CHA-14900) with no path in the repository (written in another checkout, such as a container) gives that signal status `error` (CHA-14882, DECISIONS 2026-10-29).

### Traffic from Datadog — done (first version, information only)
- `farol usage` (RUM page views by `@view.url_path_group`, APM `trace.<op>.hits` by `resource_name`) writes `usage.json`; `analyze --usage` adds an optional `usage` section; comment line, HTML fact, per-route chips (busiest first) and per-file pills. Name formats checked against real Datadog data (RUM path groups, normalized metric tags). GraphQL operations are not matched.

### Python projects — done (first version)
- `language: "python"`: py-helper/ (stdlib only, `python3 -I`) + shared `src/decls/`; FastAPI routes with routers/prefixes, several apps labeled by service, `__main__` scripts; AST-hash declarations; name-based method resolution for unknown receivers; pyproject/requirements dependencies; coverage.py, ruff (+bandit S rules) and pip-audit reports; Python suppressions. Scenarios p1–p6.
- Checked on a real Python PR (reach, new endpoints, diff coverage, ruff findings). About 3 s per run.
- Python entry points: FastAPI, Flask, Django, MCP (tools/resources/prompts), Celery, Temporal and `__main__` scripts.

### Go projects — done (first version)
- `language: "go"`: Go helper (go-helper/, stdlib only) + `src/golang/`; chi and net/http routes and `main` binaries as entry points; declaration-level impact; go.mod/go.sum dependencies; coverprofile, golangci-lint (+gosec; a report whose paths start at another folder gives lint `error`, CHA-14863) and govulncheck reports; `//nolint`/`#nosec` suppressions. Scenarios g1–g7.
- Checked on a real Go PR (reach through a changed entity, diff coverage, lint, vulnerabilities). About 8 s per run.
- Go entry points: chi, net/http, gin, echo, gRPC services and `main` binaries.

### Merge risk score — done
- 0–100 score at the top of the HTML overview and in the PR comment; recomputed in the page as files are marked reviewed (plus the share of risk already reviewed).

### Backend surface (GraphQL + REST) — in progress, usable
- `surface: "backend"`: GraphQL root operations and REST endpoints as entry points, same JSON protocol and reports ("operations" instead of "pages"). Schema from `.graphql` files and `gql` templates (official `graphql` parser), resolver maps matched against real schema fields, REST via Fastify/Express-style registrations, resolver anchors via the type checker, `global.X = …` globals, `backend.context` for context injection, schema/resolver additive rules, type-only files as `type-only-change`.
- Tests: 8 backend scenarios on `test/fixtures/_base-api` (new query, service, schema type change, resolver change, context loader, global, REST, description-only).
- Checked on a real GraphQL PR: additive schema and resolver changes recognized, reach through services and loaders, diff coverage.

### Known limitations / open questions
- Context injection needs `backend.context`; without it, files reached only through `context.loaders` are "unreachable" (still `touches-existing`).
- Across modules the unit is the module (an operation using one function of a service is affected by a change to another function of it).
- An operation reaches every type it can return, so broad return types (User, Workspace…) make many operations "affected" by changes deep in the type graph.
- REST prefixes from `register`/`use` are not applied (Express, Fastify). Hono `route()` prefixes are (CHA-14806, DECISIONS 2026-10-29): one endpoint per mount, checked on empwr-platform assess (45 endpoints, 31 keys before, 0 `dynamic-route`).  Hono middleware and error handlers are placed on the endpoints that run them (CHA-14808, DECISIONS 2026-10-30).
