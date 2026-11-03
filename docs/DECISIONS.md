# Decisions

Every decision not covered by `docs/SPEC.md`. One entry per decision: problem, options, choice, reason.

## 2026-10-17 — Repository root is this directory (`farol`), package name is `revscope`

- **Problem:** the spec shows a `revscope/` root, but the workspace handed over is an empty directory called `farol`.
- **Options:** create a nested `revscope/` folder; use the current directory as the root.
- **Choice:** the current directory is the repository root; the npm package and binary are named `revscope`.
- **Reason:** a nested folder would make the action path (`$GITHUB_ACTION_PATH/../dist/cli.js`) and CI awkward; the directory name does not leak into any output.

## 2026-10-17 — Pin TypeScript 6.0.x instead of the latest 7.x

- **Problem:** `npm view typescript` returns 7.0.2, the native (Go) port. Its npm package only exposes `unstable/*` entry points and no classic `ts.createProgram`/`ts.createSourceFile` API. typescript-eslint also requires `typescript <6.1`.
- **Options:** TS 7 unstable API; TS 6.0.x classic API.
- **Choice:** `typescript@6.0.3`, exact version, as a runtime dependency.
- **Reason:** the spec relies on the compiler API (program, module resolution, scanner, checker). 6.0 is the latest release with that API.

## 2026-10-17 — Bundle every dependency (including TypeScript) into `dist/cli.js`

- **Problem:** the action runs `node dist/cli.js` from a checkout of this repository, without `npm install`.
- **Options:** commit `node_modules`; bundle everything.
- **Choice:** tsup bundles all dependencies; a banner defines `require`, `__filename` and `__dirname` for the CommonJS parts of TypeScript.
- **Reason:** a single self-contained file is the only way the composite action can run without installing. The file is large (~10 MB) because of TypeScript; that is accepted.

## 2026-10-17 — The analysis never loads TypeScript lib files (`noLib`, `types: []`)

- **Problem:** building a full program loads `lib.*.d.ts` and every `@types` package, which is slow and, once bundled, the lib files are not shipped.
- **Options:** keep the project's options untouched; override `noLib`/`types`.
- **Choice:** after parsing the project tsconfig, override `noLib: true`, `types: []`, `noEmit: true`. Module resolution options (`paths`, `baseUrl`, `moduleResolution`, `customConditions`, …) are kept exactly as configured.
- **Reason:** the analysis needs syntax, module resolution and alias symbol resolution only; none of them depend on lib files or ambient `@types`.

## 2026-10-17 — Line normalization: trim, drop one trailing comma, collapse whitespace runs

- **Problem:** the spec says removed/added pairs that differ "only by trailing comma or spaces" are unchanged, without defining "spaces".
- **Options:** remove all whitespace; collapse runs of whitespace to one space and trim.
- **Choice:** trim, drop one trailing comma, collapse internal whitespace runs to one space. Pairs are matched greedily in order inside each hunk.
- **Reason:** removing all whitespace would equate `return x` with `returnx`; collapsing is the conservative reading (fewer lines treated as unchanged).

## 2026-10-17 — git output is made independent of user configuration

- **Problem:** user/system git config (`diff.noprefix`, `diff.algorithm`, `core.quotePath`, colors) changes diff output and would make results machine-dependent.
- **Choice:** every call passes `-c core.quotePath=false -c diff.noprefix=false -c color.ui=false`, and diffs use `--no-ext-diff --no-textconv --diff-algorithm=myers --src-prefix=a/ --dst-prefix=b/ -M`. `LC_ALL=C` keeps messages in English.
- **Reason:** deterministic output is a spec requirement.

## 2026-10-17 — Scenario fixtures share a base app

- **Problem:** the spec wants `fixtures/<scenario>/{base,head}` and also one minimal base app reused by scenarios.
- **Choice:** `test/fixtures/_base-app/` is committed first in every scenario, then `<scenario>/base/` (optional overlay), then `<scenario>/head/` plus `deleted.txt` on a `feature` branch. Commits use fixed identity and dates, so SHAs in golden files are stable.
- **Reason:** avoids 20 copies of the same app while keeping the base/head layout of the spec.

## 2026-10-17 — `git log --first-parent` commits as an opt-in for `history`

- **Problem:** a real frontend merges PRs by squash: `git log --merges --first-parent master` returns nothing in the last 90 days, so `history` as specified would analyze zero PRs.
- **Options:** keep merge commits only; detect squash commits by message; opt-in flag.
- **Choice:** default stays merge commits (spec). `history --first-parent` analyzes every first-parent commit against its first parent, which is exactly one squashed PR per commit.
- **Reason:** keeps the specified default and makes the command useful on squash-merge repositories without guessing from commit messages.

## 2026-10-17 — Configuration semantics

- **Problem:** the spec gives an example configuration but not the defaults, the base directory of paths, or how `--config` is resolved.
- **Choice:**
  - Unknown keys are errors (catches typos). `tsconfig` defaults to `tsconfig.json`, `routes.adapter` to `react-router`, `exclude` to `[]`, each role to the example's globs (without the project-specific `src/styles/global.css` in `global`). `routes.file` is required.
  - Every path in the configuration is relative to the project directory (`--cwd`, default: process cwd). `--config` is also resolved against it when relative.
  - `exclude` only removes files whose role would be barrel, i18n or source. Globals and the routes file are never excluded (fail closed); tests and stories keep their role.
- **Reason:** a monorepo app (like a real frontend we tested) has its project directory below the git root, and an external config file must still describe paths inside the project.

## 2026-10-17 — Paths: repo-relative in output, project-relative for configuration globs

- **Problem:** git reports paths relative to the repository root; config globs are written relative to the project. In a monorepo they differ.
- **Choice:** every path in the output is repo-relative (what reviewers see in the PR). Roles are computed on the project-relative path. Changed files outside the project directory are analyzed as `source` when they are part of the project's import graph (e.g. a workspace package resolved through `node_modules` symlinks) and otherwise listed as `excluded` with reason `outside-project`.
- **Reason:** a PR that only touches another app of the monorepo must not make this project `touches-existing`, while shared packages the app imports must still count.

## 2026-10-17 — Type-only imports are excluded from the reach graph (spec requirement, recorded as asked)

- **Problem:** the spec asks to record this decision explicitly.
- **Choice:** `import type …`, `import { type A } …` when every specifier is type-only, `export type … from` and `export { type A } from` create no edge. An `import { A }` without the `type` keyword always creates an edge, even if `A` turns out to be an interface.
- **Reason:** type-only imports are erased by every TypeScript emitter and bundler, so they cannot change runtime behavior. Detecting semantically type-only imports (no `type` keyword) would remove more edges; that is the less conservative direction, so revscope sticks to the syntax.

## 2026-10-17 — Barrel precision through the type checker, with "barrel" edges

- **Problem:** a named import through a barrel must point at the declaring module (scenario 14), but a change to the barrel itself must still reach its importers.
- **Choice:** for each value binding, `checker.getAliasedSymbol` follows every alias (`export { x } from`, `export *`, `import x; export { x }`, default re-exports) to the declaration; the edge goes to the declaring file. The importer also gets a `barrel` edge to the module it imported through. During reach, `barrel` edges are followed only from the changed barrel itself (or from barrels re-exporting a changed re-export-only module). `import * as ns` and `import "./barrel"` keep a normal edge to the barrel, which reaches everything it re-exports. When the checker cannot follow a binding, the edge goes to the imported module (conservative).
- **Reason:** uses the compiler's own alias resolution instead of reimplementing export tables, and keeps changed barrels visible.

## 2026-10-17 — Resolution details not covered by the spec

- **Choice:**
  - Specifiers resolved by the compiler to a file inside the repository and outside `node_modules` are project modules (workspace packages included, through real paths). Everything else the compiler resolves is an external package.
  - Non-TS files (CSS, SVG, images…) are not resolved by the compiler; revscope looks them up relative to the importer, through `paths` and through `baseUrl`. Query suffixes (`?react`, `?raw`) are stripped.
  - An unresolved specifier is a diagnostic only when it points into the project (relative, absolute, `paths` alias, or the first segment exists under `baseUrl`); unresolved bare specifiers are packages without types.
  - `require("x")` and `import x = require("x")` with a literal create edges. `import.meta.glob(...)` is reported as a non-literal import.
  - Module resolution uses the head tsconfig; for a solution-style tsconfig (`files: []` + `references`), the referenced config that includes the routes file is used.
  - tsconfig `include` globs are expanded with the compiler's internal `ts.matchFiles` (TypeScript's exact semantics, over the git tree). TypeScript is pinned, so the internal API cannot change under us; a missing function fails with a clear message.
- **Reason:** follow the compiler wherever it has an answer; fail closed where it has none.

## 2026-10-17 — The react-router adapter is written in M3, the `routes` command in M4

- **Problem:** the M3 acceptance criterion (scenarios 14–16 via `impact`) needs the route table, which is M4.
- **Choice:** M3 includes the adapter (object and JSX forms) because `impact` cannot exist without it; M4 adds the `routes` command, dynamic-route diagnostics tests and the expected base table.
- **Reason:** the milestone order is kept for acceptance; only the code dependency moved earlier.

## 2026-10-17 — The project is read from git objects, not from the working tree

- **Problem:** `history` analyzes old commits and `analyze` receives refs; the working tree may be at another commit.
- **Choice:** the head program is built over an in-memory file system of the head tree (one `git ls-tree` plus one `git cat-file --batch` for every TS/JS/JSON file). Paths inside `node_modules` (never committed) fall back to the disk. `routes`/`impact` without `--ref` read the working tree.
- **Reason:** results depend only on the refs, which is what makes `history` correct and outputs reproducible.

## 2026-10-17 — Route table details not covered by the spec

- **Choice:**
  - A route records `modules`: every project module or package its own definition references (`element` tree, `Component`, `lazy` imports, `errorElement`, `ErrorBoundary`, `HydrateFallback`). `entry` is the innermost component of `element` (children before the wrapper tag and its attributes), so `<Suspense fallback={<Spinner/>}><Page/></Suspense>` has entry `Page`; `Component` wins over `element`, which wins over `lazy`. Reach anchors are `modules` plus `layouts`; additivity compares key, entry, layouts and modules.
  - Components from packages (e.g. `<Navigate/>`) are recorded as `package:<specifier>`; they are not dynamic.
  - Supported beyond the spec, because they are statically decidable in the routes file: local `const` arrays/objects/strings, `React.lazy(() => import("…"))` constants (any call wrapping a function with one literal `import()`), `lazy` methods and RR7 `lazy` objects, `useRoutes`, `createStaticRouter`, `createRoutesFromChildren`, JSX fragments among routes.
  - Unsupported (dynamic): imported route arrays, spreads, computed paths/index flags/keys, components declared in the routes file, computed element content, non-literal lazy imports, routes inside `.map`, files without any route table, syntax errors. Routes that can still be read are kept in the table so reviewers see them; the PR is `unknown` anyway.
  - Exported arrays are route tables only when every object has a route key (`path`, `index`, `element`, `Component`, `lazy`, `children`), so `export const NAV = [{ label }]` is ignored.
  - Index routes use the `(index)` key segment; pathless routes without a component use `(layout)`.
- **Reason:** cover the common centralized-routes idioms without guessing; everything else fails closed.

## 2026-10-17 — Classification details not covered by the spec

- **Choice:**
  - "Existing routes" are head routes whose key exists in the base table (the head table itself when the routes file did not change). `routes.affected` only lists existing routes: new routes cannot have existing behavior.
  - Affected entries group, per route, one shortest chain per non-additive file (`via: [{ file, chain }]`). Base routes removed or changed by a non-additive routes file are affected with the chain `[routesFile]`.
  - A dynamic route makes the PR `unknown` even when the routes file did not change (the spec says any dynamic construct does): without a complete table, no file can be called unreachable.
  - "Unresolved import involving a changed file": the importer is a changed file, or the specifier points (relative or `paths` alias, without extension probing) at a path the PR deleted or renamed away. Pre-existing unresolved imports elsewhere are listed in diagnostics but do not change the class.
  - Parse errors: syntax diagnostics of changed files in the head program, plus invalid JSON in changed i18n files. All head parse errors go to `diagnostics.parseErrors`.
  - An i18n file that is not JSON cannot satisfy the i18n rule (non-additive). A routes file that is renamed is a renamed existing file (non-additive).
  - The base route table is extracted with the head compiler options over the base tree (a tsconfig change is global anyway).
  - `files[].additive` is present only for modified routes, barrel and i18n files.
  - `timingsMs` comes from an injected monotonic clock; it is the only machine-dependent field in production. Golden tests inject a constant clock (all timings 0) and replace SHAs by `<base>`/`<head>` placeholders; determinism is tested byte for byte by running the same analysis twice.
  - Paths given with `--coverage`, `--eslint` and `--out` are relative to the current directory; `signals.*` in the configuration are relative to the project directory.
- **Reason:** fail closed, keep the output explainable, and keep golden files stable when unrelated fixture details change.

## 2026-10-17 — Signal details not covered by the spec

- **Choice:**
  - Coverage only looks at code files (`.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`, not `.d.ts`) with role `source` and status added or modified (as the spec says; renamed files are left out). A CSS or SVG source file would otherwise count every line as uncovered.
  - Uncovered ranges group strictly consecutive line numbers.
  - Report paths: absolute paths are canonicalized with `realpath` when the file exists (macOS `/var` vs `/private/var`, symlinked checkouts) and made relative to the repository root; paths outside the repository are ignored; relative paths are relative to the project directory.
  - Lint counts findings on added lines of every changed file (any role); messages without a line, or on other lines or files, are context. ESLint `severity: 0` is ignored; fatal parse errors get the rule name `(fatal)`. Findings are sorted error first, then path, line, rule; at most 50, with `omittedFindings`.
  - Suppressions: every changed code file is scanned (tests included). Comments are found with the TypeScript scanner's comment-trivia functions (`getLeadingCommentRanges`/`getTrailingCommentRanges`) applied to every token of the parsed file, skipping string, template, regex and JSX-text tokens; `as any` and `: any` are found on the AST (`AsExpression` with an `any` type; an `any` type that is the direct annotation of a declaration). A raw token-by-token scan cannot tell regex, template continuation and JSX text apart without the parser, which the parser-driven scan does.
  - A missing report is `not-provided` with a message saying where it was looked for; an unreadable or malformed one is `error`.
- **Reason:** precise numbers where the format allows, never a false "approved".

## 2026-10-17 — Report layout and language

- **Choice:**
  - Signals are top-level list items with nested lists (a bold line right after a list item would be swallowed by the item in GitHub markdown).
  - Labels, class descriptions and reason names are Portuguese (`src/report/strings.ts`); reason details stay in English because they are data of the JSON output (and the tool is open source). The reason code is shown next to its Portuguese name so the JSON and the comment can be matched.
  - Text from the JSON is HTML-escaped and backticks are replaced, so JSX in a detail cannot break the comment.
  - Truncation: lists are rendered with at most 50 items each; if the comment exceeds 60,000 characters the limit drops (20, 10, 5, 2, 1, 0) and a note says the full list is in the JSON. A final hard cut keeps the marker if even that is too long.
  - The commit in the footer is the first 12 characters of the head SHA.
- **Reason:** readable on GitHub, safe to embed, always under the API limit.

## 2026-10-17 — `history` output and signals

- **Choice:** one `<sha>.json` per analyzed commit plus `summary.json` (`branch`, `since`, `mode`, `total`, `failed`, `byClass`, and per commit `sha`, `firstParent`, `date`, `subject`, `classification`, `file`, `error`), oldest first. History never passes coverage or ESLint reports (the configured report files describe the working tree, not old commits), so those signals are `not-provided`; suppressions and modified tests are computed from each diff. A failed analysis is counted as `unknown` (and in `failed`) and does not stop the run. Progress goes to stderr.
- **Reason:** history is for measuring the classifier over time; mixing in reports of another commit would be wrong.

## 2026-10-17 — GitHub comment, action and example workflow

- **Choice:**
  - `comment` finds the first PR comment whose body starts with `<!-- revscope -->`, PATCHes it (or POSTs a new one), follows `Link: rel="next"` pagination with `per_page=100`, honors `GITHUB_API_URL` (GitHub Enterprise), and adds a hint to every HTTP error (401 token, 403 permission/forks, 404 repo/PR, 422 content). Ticked feedback boxes are copied by label into the new body, always (not only when the commit changed, since copying is harmless when it did not); when the merged body equals the current one, no request is sent. Missing token/repo or a bad `--pr` are usage errors (exit 1); HTTP failures exit 2.
  - The composite action passes inputs through environment variables (never `${{ }}` inside the script) and builds an argument array for `node $GITHUB_ACTION_PATH/../dist/cli.js`.
  - Fixes to the example workflow so it works and never blocks: `persist-credentials: false`; `npm ci`, tests, ESLint and analyze are `continue-on-error`; Vitest flags `--coverage.enabled --coverage.reporter=json --coverage.reportsDirectory=coverage`; ESLint runs once on all changed files (`mapfile` instead of `xargs`, which can split the list and overwrite the report) with `--no-error-on-unmatched-pattern`; the base SHA goes through `env`; the analyze step passes `coverage`/`eslint` explicitly; upload with `if: !cancelled()`, `overwrite: true` (re-runs); the comment job runs `if: !cancelled()`, is `continue-on-error` (fork PRs get a read-only token), and sets up Node 22 without the npm cache (it has no checkout, hence no lockfile); a `concurrency` group per PR avoids racing comment updates.
  - The tool's own CI (`.github/workflows/ci.yml`) builds and fails when `git diff dist/` is not empty, then runs typecheck, lint and tests on Node 22 and 24.
- **Reason:** the spec asks to correct the example so it actually works, keeping the two-job security model.

## 2026-10-17 — Route trees split across modules (found on a real frontend)

- **Problem:** a real-world frontend builds its router from a route array imported from another module (and spread), whose routes use paths from an `as const` object in a constants module, template paths built from those constants and lazy functions from a third module, some memoized (`() => (cache ??= load())`). With a single-file adapter every PR would be `unknown`.
- **Options:** document it as unsupported (always `unknown`); follow imports inside the adapter.
- **Choice:** the adapter input gets `read(file)` and `resolve(specifier, fromFile)`. The adapter follows, through imports and re-exports (`export const`, `export { a as b }`, `export { x } from`, `export *`, `export default`), constant strings, template literals with constant parts, properties of constant objects, imported route arrays (also when spread) and imported lazy functions, following calls to helpers when a lazy function has no `import()` itself. Anything else stays dynamic. `RouteTable.sources` lists the files read, the base table is recomputed when any of them changed, and the base tree is fully prefetched for that.
- **Choice (roles):** only `routes.file` gets the routes rule by default; other source modules of the table stay `source` (a change there is `touches-existing`). The optional `routes.extraFiles` globs let a team declare modules that only define routes; they then get the routes rule. Opt-in because a constants module may also feed existing code (navigation built from the same object), where a pure addition can change behavior.
- **Choice (imports in routes files):** the routes rule ignores removed lines of an import declaration when the head still imports the same module with every binding of the base declaration (`import { a }` → `import { a, b }`). Table changes are reported once, against `routes.file`.
- **Choice (monorepo globals):** `roles.global` globs may name files above the project directory (`../../pnpm-lock.yaml`).
- **Reason:** "add support if small" (M10); the extension stays inside the adapter, the only extension point, and every default remains fail-closed.

## 2026-10-17 — HTML report and key findings (request after v0)

- **Problem:** the JSON is hard to read by people; the user asked for a readable HTML that points out the main issues programmatically.
- **Choice:** `revscope html --in <json> [--out <file>]` renders a self-contained page (inline CSS, no scripts, no network). `src/report/findings.ts` derives ranked findings (alta/média/baixa) from the JSON only; thresholds are constants (`COVERAGE_HIGH` 50%, `COVERAGE_MEDIUM` 80%, `WIDE_IMPACT_ROUTES` 10). Wide-impact files are grouped in one finding. The coverage finding uses the files present in the coverage report, and files missing from it are a separate finding, because on the real frontend 56 missing files (types/consts/i18n excluded by the Vitest preset) turned 99.4% into 64.7%. The JSON and its totals are unchanged (the spec's rule still counts missing files as uncovered). Paths are shortened with the dominant app directory of the monorepo. Texts live in `src/report/strings.ts`.
- **Reason:** a reviewer must see the real problems first; a number driven by deliberately excluded files would hide them.

## 2026-10-17 — Outputs in English (overrides the spec)

- **Problem:** the spec asked for the PR comment in Portuguese; the user then asked for code and every output, HTML included, to be in English.
- **Choice:** all user-facing text (PR comment, HTML report, key findings, reason labels) is English, still centralized in `src/report/strings.ts`. The feedback checkbox labels changed accordingly, so comments created before this change are not matched by label when preserving ticks.
- **Reason:** explicit request of the user; the project will be open source.

## 2026-10-17 — Dependencies are a category of their own

- **Problem:** the user asked for dependency changes to be treated specially: list changed packages with the bump, added and removed ones, in the JSON and in a dedicated HTML tab; a major bump or a removal is critical, patch/minor/added are not.
- **Choice:**
  - New roles `manifest` and `lockfile`, assigned before the configured globs: a `package.json` of the project, of a directory above it, or of a workspace package that contains import-graph nodes; a known lockfile in the project or above it. This replaces "package.json / lockfiles are global" from the example configuration.
  - New `dependencies` block in the output (`manifests`, `lockfiles`, `changes`, `summary`) and reason codes `dependency-critical`, `manifest-changed`, `lockfile-only-change` (effect `global`) and `dependency-changed`, `lockfile-changed` (`info`).
  - Critical: removed; major; 0.x minor and 0.0.x patch (caret ranges treat them as breaking); versions that cannot be compared; moved out of `dependencies`/`peerDependencies`. Not critical: added, minor, patch, downgrades within a major (flagged), range-only and `workspace:`/`catalog:` changes, moves into runtime sections.
  - Fail closed around the manifest: any other field change (`exports`, `scripts`, `overrides`, `engines`…), an added/deleted manifest, or a lockfile change with no manifest dependency change stays `global`.
  - Versions are compared with a small dependency-free parser (lowest version of a range). Lockfiles are not parsed (no YAML dependency).
- **Reason:** dependency changes are the riskiest kind of "global" change, and the most common harmless one; separating them keeps patch/minor bumps from drowning the signal while major bumps and removals stand out.

## 2026-10-17 — `ignore` globs

- **Problem:** the user asked for a way to suppress some files from the analyses, with glob patterns.
- **Choice:** `ignore` in the configuration and `--ignore <glob...>` (analyze, history). Matched against the project-relative and the repo-relative path; matching changed files are removed right after the diff, before roles, classification, dependencies and signals, and are listed in the new `ignoredFiles` output field. They remain part of the import graph (they still exist in the code). `exclude` keeps its narrower meaning.
- **Reason:** generated files, lockfiles of unrelated tools or vendored code should be silenced explicitly and visibly.

## 2026-10-17 — `.footprint.json` for every CLI parameter

- **Problem:** the user asked for every CLI parameter to be settable in a `.footprint.json` at the root.
- **Choice:** looked up from the current directory up to the repository root (first directory with `.git`), or given with `--footprint <file>`. Top-level keys are the global flags, one object per command (camelCase). Validated with zod, unknown keys rejected. Command-line flags win (commander's option value source), footprint values replace defaults, paths are relative to the file, and without `cwd` the project directory is the footprint's directory. Required flags (`--base`, `--head`, `--in`, `--pr`, `--since`, impact's file) are validated after merging, with an error that names the footprint key. It holds CLI parameters only; the analysis configuration stays in `revscope.config.json` (referenced by `config`).
- **Reason:** one place for team defaults; explicit flags still override for one-off runs.

## 2026-10-17 — Single-page HTML and links to the GitHub diff

- **Problem:** tabs read as several pages; the user wants one page that works as a single downloaded file, and every file cited to link to its diff on GitHub, with line ranges when possible.
- **Choice:** the report is one scrolling page with a sticky bar of section anchors (still no external resources). Links (HTML and PR comment): changed files (including ignored ones, which are still in the PR diff) → `pull/<n>/files#diff-<sha256(path)>`, ranges → `…R<start>-R<end>` (`L` for deleted files); files outside the diff → `blob/<head>/<path>#L<a>-L<b>`. The PR number is a new nullable `pr` output field (`--pr`, or the GitHub Actions event file); without it, the compare view `compare/<merge-base>...<head>` is used (same anchors). Without `repo`, no links. `GITHUB_SERVER_URL` supports GitHub Enterprise.
- **Reason:** reviewers jump from a finding straight to the lines in the PR.

## 2026-10-17 — Route graphs in the HTML report (Mermaid from a CDN)

- **Problem:** the user wants the Routes section to list every changed route and, on click, show a graph of the changes (Mermaid or similar). External dependencies are acceptable as long as the report stays a single file.
- **Choice:** one collapsible row per changed route (affected and new). Its diagram is a Mermaid flowchart generated from the `via` chains of the JSON (`src/report/route-graph.ts`, pure): route → modules → changed files, new files and modified files colored, `click` links to GitHub, at most 30 chains drawn. Mermaid `11.4.1` (exact version) is imported from jsDelivr by a module script only when a row is opened; the text chains below each diagram keep the page usable offline. This is the only script and the only external resource of the report.
- **Reason:** a graph explains "why is this route affected" at a glance; lazy loading keeps a 40-route report fast.

## 2026-10-17 — Routes section: pages first, layouts grouped

- **Problem:** pathless wrapper routes (providers, layouts, error boundaries) share the URL of their parent, so the same path (`/org/:orgId`) appeared many times.
- **Choice:** affected and added routes carry `hasChildren` in the output (a route whose key prefixes another route key). The HTML lists pages (routes without children) first and groups layouts in a collapsed "Affected layouts and wrappers" block; the key is shown only when two listed routes share a path (always on hover).
- **Reason:** the list should match the screens someone has to test; wrappers already appear in their pages' graphs.

## 2026-10-17 — Risk from centrality (overrides "no numeric scores" of the spec)

- **Problem:** the user asked to compute the risk of each change from the centrality of each item in the graph (who uses it). The original spec excluded numeric scores from v0.
- **Choice:** `src/classify/risk.ts` (pure) computes, for each changed code file, direct importers, transitive dependents (reverse reach, with the same barrel rule as the affected routes), centrality (dependents / (nodes − 1)), existing pages and routes reached, and a level: high (≥ 50% of the pages or ≥ 10 pages), medium (some page, ≥ 10 dependents, new code in existing pages, deleted files), low (additive, unused). The numbers are explainable counts, not an opaque weighted score; the level never changes the classification. Output: `risk` block; HTML: Risk section and stat; PR comment: risk summary with the non-low files; key findings: high/medium risk replace the earlier "wide impact" finding.
- **Reason:** explicit request; counts keep the risk explainable and testable.

## 2026-10-17 — Coverage-only ignore

- **Problem:** teams do not want to test constants or types, but still want to see those files in routes and risk.
- **Choice:** `signals.coverageIgnore` (configuration), `--coverage-ignore` (CLI) and `analyze.coverageIgnore` (footprint), matched like `ignore`. Matching files are skipped by diff coverage only and listed in `signals.coverage.ignoredFiles`.
- **Reason:** distinct from `ignore`, which removes a file from every analysis.

## 2026-10-17 — Security signals: static analysis and vulnerable dependencies

- **Problem:** the user asked for static security analysis and for CVEs in added or changed dependencies; between reading an audit report and querying OSV.dev from the analysis, they chose the report.
- **Choice:**
  - `signals.security` (`src/signals/security.ts`): AST rules on added lines of changed code files, tests/stories/excluded skipped — XSS sinks, `eval`/`Function`, string timers, `document.write`, `postMessage` to `*`, known credential formats and high-entropy strings assigned to secret-like names, `javascript:` URLs, `target="_blank"` without `rel`, plain-HTTP URLs (localhost, w3.org namespaces and example domains allowed). Regular expressions are used only on string literal values (token formats), never to understand code.
  - `signals.vulnerabilities` (`src/signals/audit.ts`): reads `npm audit --json` (npm 7+) or `pnpm audit --json` (`--audit`, `signals.audit`, `analyze.audit`, action input `audit`). Advisories are kept when they affect a package the PR added, updated or moved (direct) or a package reachable from it (npm `via` links, pnpm finding paths); the whole report is summarized by severity. `analyze` stays offline: the workflow runs the audit in the job that already installs dependencies.
  - Signals never change the class; key findings: critical/high vulnerabilities and high SAST findings are high, the rest medium/low; a missing audit report is "not verified".
- **Reason:** keeps the analysis deterministic and offline while covering the two risks the user named.

## 2026-10-17 — Module tree of pages; pages instead of routes in counts

- **Problem:** the user wants a tree view of the routes to see modules, and only cares about the number of pages, not of routes.
- **Choice:** the Routes section offers a List / Tree switch (CSS only). The tree groups pages by URL segments; a segment without a page of its own and with a single child is merged with it (`org/:orgId`); each module shows its number of changed pages and the highest risk below it; top-level modules start open. Hero stat, section badge and the Risk table count pages only (`routesReached` stays in the JSON for compatibility). Route rendering moved to `src/report/html-routes.ts`.
- **Reason:** modules are how the team thinks about the app; pages are what someone has to test.

## 2026-10-17 — Light/dark switch in the HTML report

- **Choice:** colors are tokens; the dark set applies when the system prefers dark unless `<html data-theme="light">`, or when `data-theme="dark"`. A header button switches theme, remembers the choice per viewer in localStorage (wrapped in try/catch; the page works without it) and redraws open Mermaid diagrams with the matching theme.
- **Reason:** user request; the system theme stays the default.

## 2026-10-17 — Backend surface: GraphQL operations and REST endpoints as entry points

- **Problem:** the user asked to apply the same concept and the same JSON protocol to backends (GraphQL and REST), first on graphql-api.
- **Choice:**
  - `surface: "backend"` in the configuration and in the output (`surface` field). Entry points are GraphQL root fields and REST endpoints, stored in `routes` as `RouteEntry` (key = `Query.brand` / `GET /ping`, `modules` = what their resolvers use, `entry` null so the resolver file itself is never an anchor: a resolver file usually serves many operations).
  - New top-level module `src/backend/` and runtime dependency `graphql` (16.11, the official parser: SDL must be parsed with a real parser, as TypeScript is for code).
  - Operation → resolver keys: its own resolver plus the resolvers of every type reachable from its return type (fields, unions, interfaces). Resolver maps are recognized by type names and real field names of the schema.
  - Resolver anchors: identifiers resolved with the type checker to project declarations (type-only declarations, JS expando assignments ignored), same-file helpers followed, `global.X = …` globals mapped to their module (and added as import-graph edges), and `backend.context` for runtime context injection (dependency injection is invisible statically; the mapping is explicit and falls back to every provider).
  - New roles `schema` and `resolvers` with additive rules (member-level SDL diff ignoring descriptions; resolver-level code comparison plus "rest of the file" as items, ignoring comments and added imports). New reason codes `schema-not-additive`, `resolvers-not-additive`, `schema-additive`, `resolvers-additive`, and `type-only-change` (both surfaces).
  - Risk of schema/resolver files uses the number of operations their change affects (nothing imports them).
  - Reports use "operations" instead of "pages" for a backend.
- **Reason:** same protocol and report for both sides of the product; precision comes from the schema and the resolver code instead of file-level imports.

## 2026-10-17 — Imports of types never create edges (supersedes "syntactic type-only only")

- **Problem:** on graphql-api, `import { IGraphqlContext } from '@shared/interfaces'` (no `type` keyword) made an interfaces-only file "affect" 132 operations.
- **Choice:** a named/default import whose symbol is only a type (no value meaning; const enums still count) creates no edge, in both surfaces. This is what TypeScript, swc and esbuild emit: such imports are erased.
- **Reason:** follows the real compiler output; the earlier syntactic rule was a stricter-than-necessary reading.

## 2026-10-17 — "Reviewed files" filter; Signals section renamed Coverage

- **Choice:** the pages/operations section has a "Mark files as reviewed" panel listing the changed files behind the listed pages/operations (with how many each affects), checkboxes and a regular expression. A page/operation disappears when every changed file behind it is reviewed; row labels show "N of M changed files left", module counts and the title follow, empty modules hide. The selection is kept per commit in localStorage (try/catch; works without it). Rows carry `data-files`. The "Signals" section is labeled "Coverage".
- **Reason:** user request: see what is left to review after reviewing some files.

## 2026-10-17 — Merge risk score (0–100) in the overview, recomputed as files are reviewed

- **Choice:** `src/report/merge-score.ts` derives weighted items from the analyze JSON (change reach and centrality per file, coverage gaps, security findings, lint errors, suppressions, removed tests, dependency changes, vulnerabilities, global and unknown reasons) and combines them as `100 × (1 − Π(1 − w))`. High from 60, medium from 30. The HTML embeds each file's weights in the contributors list. The reviewed-files panel now also lists files that add to the score without reaching a page, and it emits a `revscope-reviewed` event. The score script drops reviewed files' items, recomputes, and shows "% of reviewable risk already reviewed" (linear in the weights). Contributors show each file's own risk, which is stable, instead of its marginal share, which rounds to 0 when the score saturates. The score is computed at report time, not stored in the JSON (old JSONs still render; no schema change). The PR comment shows it.
- **Reason:** user request: a prominent score, higher = riskier, that follows the review. The product form is bounded and monotone: adding a risk never lowers it, and reviewing never raises it. It saturates for big PRs on purpose (many unreviewed risky files are still risky), so the linear "reviewed share" is shown next to it. The weights are heuristic and listed in one place to tune.
- **Supersedes:** in part, "no numeric scores", already relaxed for per-file risk levels.

## 2026-10-17 — Reviewed-files panel at the top, with search

- **Choice:** the "Mark files as reviewed" panel moved from the pages/operations section to the overview, right under the merge risk score, open by default (the routes section keeps a link to it). It gained a search box (case-insensitive, space-separated words that must all match the path) that only narrows the list. "Mark shown" / "Unmark shown" act on the files the search shows, and "hide reviewed" hides ticked files. The regular expression still marks files directly.
- **Reason:** user request. The panel drives the score and the remaining pages, so it belongs next to them, and PRs can have well over 100 files to tick.

## 2026-10-17 — `.farol.json` replaces `.footprint.json`; reviewed-files panel above the overview

- **Choice:** the parameters file is `.farol.json` (flag `--farol-file <file>`; module `src/cli/farol-file.ts`). `.footprint.json` is no longer read, and the entries above that mention it refer to the same file under its old name. The "Mark files as reviewed" panel sits between the section bar and the Overview, collapsed by default.
- **Reason:** user correction (the file was meant to be named after the project) and request.

## 2026-10-17 — Go projects: a Go helper (go-helper/) plus src/golang/, same JSON and reports

- **Problem:** the user asked for the same analysis on Go backends (first target: go-service, chi routes). The spec forbids regex, Babel or tree-sitter for code understanding and forbids executing the analyzed code. There is no mature Go parser or type checker in JavaScript.
- **Choice:**
  - **New top-level module `go-helper/`.** A Go program using the standard library only (`go list -deps`, `go/parser`, `go/types`, `go/scanner`). It is built on first use with the local toolchain into the temp directory and cached by source hash. It never runs code of the analyzed module.
  - **What the helper reads.** It exports the base and head trees (`git archive`) and type-checks them offline (`GOPROXY=off`, `CGO_ENABLED=0`, `GOWORK=off`). It prints:
    - **Top-level declarations** with a hash of their tokens. Comments and formatting do not count. A `core` hash leaves out route registration calls.
    - **Reference edges** between declarations. Interface method calls go to every project type implementing the interface. A type depends on its methods. A method reading its own receiver's fields is not a use of its type.
    - **Entry points:** chi routes (with `Route`, `Group`, `Mount`, `With`, `Use`, prefixes, and router-taking functions followed from their callers) and net/http `Handle`/`HandleFunc`. Each `main` package that registers no route becomes `RUN <dir>`.
  - **New module `src/golang/` (pure).** It computes the impact of each changed Go file declaration by declaration, with the existing `BackendFileImpact` (plus file chains). The classifier uses that impact for `source` files.
  - **Reused unchanged:** the risk, the score, the reports and the JSON (`surface: "backend"`).
  - **Config:** `language: "go"` switches the pipeline, the default roles (`**/*_test.go` are tests) and the default excludes (generated mocks).
  - **Dependencies.** `go.mod` and `go.sum` are the manifest and the lockfile. Their sections are `require` and `indirect`. The npm critical rules apply to direct requirements; indirect ones are critical only on a major bump. Pseudo-version changes are `unknown` (critical). Other directives (`go`, `toolchain`, `replace`…) are manifest changes (global).
  - **Signals.** The coverage, lint and audit flags accept the Go formats: a coverprofile, golangci-lint JSON (gosec issues become security findings) and govulncheck JSON. Called code is rated high, an imported package moderate, a required-only module low. Suppressions are `//nolint`, `//lint:ignore` and `#nosec`.
  - **New reason `declarations-additive` (info).**
  - **Not supported yet for Go:** `routes`, `impact` and `history` give a usage error.
- **Reason:**
  - The Go toolchain is the only reliable reader of Go, and the standard library avoids downloads.
  - Declaration-level reach is more precise than the module-level reach of TypeScript. On a real Go PR, a changed helper function reached exactly the 3 routes of its 3 callers.
  - Inline handler literals are hashed per route instead of anchoring the function that registers routes; anchoring it would reach everything.
- **Requirement:** the analyzed module's dependencies (and its toolchain, if `go.mod` asks for a newer one) must already be in the module cache (`go mod download`). Otherwise the analysis fails with that hint (fail closed).

## 2026-10-17 — Python projects: a Python helper (py-helper/), same pipeline as Go

- **Problem:** the user asked for Python backends; the first target is python-services (three FastAPI services and scripts).
- **Choice:**
  - **New top-level module `py-helper/`.** A package that uses only the Python standard library (`ast`, `tokenize`, `tomllib`). It runs with `python3 -I` (no PYTHONPATH, no user site, no current directory on the path) on each exported tree. It only parses files: nothing of the project is imported or executed.
  - **What the helper prints:** the same JSON shape as the Go helper, now `src/decls/` (shared by both languages).
    - **Declarations:** functions, classes (header and attributes; methods are their own declarations), methods, module variables, import-time module code, and the `if __name__ == "__main__"` block.
    - **Hashes:** of the AST dump, so comments and formatting do not count. Docstrings are dropped. The core hash also drops route decorators and `include_router`/`add_api_route` calls.
    - **Reference edges:**
      - names go through imports, relative imports and re-exports, and `self.`/`cls.` go through the class and its bases;
      - an attribute on a value of unknown type goes to every project method with that name (conservative);
      - a class depends only on its dunder methods (Python calls those implicitly);
      - every declaration depends on its module's import-time code.
    - **Entry points:**
      - FastAPI routes (`@app.get`, `@router.post`, `api_route`, `websocket`, `add_api_route`), with `APIRouter(prefix=…)` and `include_router(…, prefix=…)`. With several apps, keys are labeled with the service (`api GET /items`) and the tree groups by service. The app object, router objects and the app module's import-time code are anchors too (lifespan, middlewares).
      - Scripts with a `__main__` guard become `RUN <file>`.
  - **Config:** `language: "python"`, with `python.roots` (import roots, default `["src", "."]`) and Python default test roles.
  - **Dependencies.** `pyproject.toml` (PEP 621, extras, PEP 735 groups, uv, Poetry, read with `tomllib` through the helper) and `requirements.txt` are manifests. `uv.lock`, `poetry.lock`, `Pipfile.lock` and `pdm.lock` are lockfiles.
    - Requirements carry their extra or group (`group`).
    - Bumps compare specifier lower bounds; the npm critical rules apply.
    - Dev-tool settings (ruff, pytest, coverage, mypy…) and project metadata are not manifest changes; other settings (`requires-python`, `tool.uv.sources`, `build-system`…) are.
  - **Signals.** The report flags accept coverage.py JSON, ruff JSON (flake8-bandit `S` rules become security findings) and pip-audit JSON. Suppressions are `# noqa`, `# type: ignore`, `# nosec`, `# pragma: no cover`, `# pyright: ignore` and `# pylint: disable`.
  - **Removed routes.** A route that disappears because a registration elsewhere changed (an `include_router` removed, a prefix changed) is reported as `routes-not-additive` on the files whose registration calls changed. The same applies to Go.
- **Reason:**
  - Python has no static types to resolve every call. Name-based method resolution over-reports (never under-reports), in line with failing closed.
  - On a real Python PR the reported chains were checked by hand. For example, every route of one service was affected because its `lifespan` hook now created a table at startup.
- **Limits:** dynamic constructs (`getattr`, `importlib`, registries built at runtime) are invisible. Routes whose path is not a constant are `dynamic-route` (unknown). Django, Flask and MCP tools are not read yet.

## 2026-10-17 — File risk weighted by diff coverage; a review plan at the top of the report

- **Coverage in the score.** Each changed code file's weight (reach and centrality) is multiplied by what its diff coverage leaves: `1 − 0.7 × covered share`. 100% covered keeps 30% of the risk, 0% all of it.
  - Without a coverage report the risk stays whole (fail closed).
  - A change made only of declarations (no executable line: types, struct fields, constants) keeps 50%. That is known, not missing data; such lines cannot be tested and rarely break alone.
  - New code reached by existing pages weighs 0.15 before coverage, instead of 0.08.
  - The separate "untested lines" item is gone; coverage is part of the file's weight. The Risk table now shows reach, diff coverage, findings and risk points per file, sorted by points. Importers, dependents and centrality moved to a tooltip.
  - **Reason:** user request. A file at 0% and one at 100% had the same risk.
- **Review plan (`src/report/verdict.ts`, `html-verdict.ts`)** replaces the hero:
  - **Verdict:** *Fast track* / *Quick review* / *Careful review*, with its reasons and the compact score.
  - **Careful when:** global or unknown class, score ≥ 60, high-severity security findings, serious vulnerabilities in changed dependencies, or a central file with measured diff coverage below 50%.
  - **Quick when:** score ≥ 25, existing code changed, low diff coverage, lint errors, trimmed tests, or new suppressions.
  - **Facts strip:** the classification and one-line facts, each linking to its section.
  - **"Start here":** up to 7 code files with at least 5 risk points, riskiest first, with reach, coverage and findings pills and a "reviewed" checkbox bound to the reviewed-files panel. Then "skim" (other code) and "probably no review needed" (not code, manifests/lockfiles, tests).
  - Key findings are one line each, with files and details on demand. The PR comment starts with the verdict and the top files.
  - **Reason:** user request. The page must answer "can this pass, quick look (at what), or careful review" before anything else.

## 2026-10-18 — HTML report as a workflow artifact, linked from the comment

- **Choice:** the action gains `command: html` (`in`, `html-out`, `pr`, `repo`). `report` and `comment` take `--report-url` (also in `.farol.json`): an https link shown at the top of the comment; anything else is rejected. The example workflows (TypeScript, plus new Go and Python variants) render the HTML, upload it with the JSON (`actions/upload-artifact` `artifact-url` output as a job output) and pass the URL to the comment job.
- **Reason:** user request. One click from the PR to the full report. GitHub serves artifacts as zip files, so the link opens the artifact page. A Pages deployment would show the page directly, but needs repository settings and write permissions this shadow-mode workflow avoids.

## 2026-10-18 — Manual test checklist; strings split

- **Choice:** `src/report/test-plan.ts` lists every new and affected page/operation (layouts excluded), grouped by module. A page's module is its first URL segment; a backend's is service plus method, or `RUN`, or the GraphQL root type. New entries come first, then affected ones by the risk points of the riskiest changed file behind them.
  - **HTML:** a "Test plan" section with checkboxes kept per commit in localStorage, and progress per group and in total.
  - **PR comment:** a collapsed GitHub task list (at most 30 items), after the classification block.
- **Strings:** `src/report/strings.ts` neared the 400-line limit, so the review plan and test texts moved to `strings-review.ts`, re-exported by `strings.ts`. The rule is now "user-facing text only in `src/report/strings*.ts`".
- **Reason:** user request (item 10 of the improvement list).

## 2026-10-18 — Incremental mode (--since) and suggested reviewers (--reviewers), both opt-in

- **Incremental.**
  - `--since <ref>` replaces the merge-base with that commit when it is an ancestor of the head; otherwise (a rebased PR) it uses their merge-base, logged.
  - The output gets an optional `incremental: { since }`. The report shows a banner, and file links use the compare view of the new commits instead of the PR page.
  - Everything else (classification, risk, signals) applies to the new commits only.
- **Reviewers (`--reviewers`).**
  - **Sources:** CODEOWNERS at the head (GitHub syntax, last rule wins, gitignore-like patterns) and the authors of the last 30 commits from the past year of each changed code file before the PR. New files use their directory. At most 80 files are read.
  - **Excluded:** the PR's own authors and bots.
  - **Output:** an optional `reviewers` (names and kind only, no e-mails), shown in the review plan and the comment.
- **Reason:** user request (items 8 and 9, as parameters). Optional fields keep existing JSON files and golden outputs unchanged.

## 2026-10-18 — routes, impact and history for Go and Python

- **Choice:**
  - `routes` prints the entry points the language helper finds, from a ref (exported tree) or the working tree.
  - `impact <file>` lists the entry points whose code reaches any declaration of the file, with the file chain.
  - `history` already goes through `analyze`, so it works for every language. It was checked on 40 commits of python-services.
- **Reason:** user request (item 13).

## 2026-10-18 — Inline diffs in the review plan

- **Choice:**
  - **What `analyze` stores:** the diffs of the changed code files, with 3 context lines (`git diff --unified=3`, paths in batches), as an optional `diffs` field. Files are ordered riskiest first.
  - **Size limits:** whole hunks up to 400 lines per file and 8,000 in total. A cut file is marked `truncated` and links to the full diff on GitHub.
  - **In the report:** every "Start here" and "skim" row gets a collapsed "Show diff (+a −r)". It shows old and new line numbers. Added lines that tests do not run get an amber bar and ○; lines with security, lint or suppression findings get a red bar and a ⚠ with the messages. The block scrolls inside a fixed height.
  - Golden outputs leave `diffs` out (it repeats the fixtures); it has its own tests.
- **Reason:** user request (item 6). The HTML report renders from the JSON only, so the hunks have to be in it. A real PR with 39 files and 3,664 diff lines gives a 1 MB HTML.

## 2026-10-18 — Cache of Go/Python helper outputs, keyed by git tree

- **Choice:**
  - **What is cached:** each helper output (base and head), in `$REVSCOPE_CACHE_DIR`, else `$XDG_CACHE_HOME/revscope`, else `~/.cache/revscope`. Settable with `--cache-dir` or `analyze.cacheDir`, off with `--no-cache` or `analyze.cache: false`.
  - **Key:** revscope version, helper language and source hash, the commit's tree SHA, the project directory, the Python roots, and the files whose comments were asked for. The same files and contents give the same output, whatever the commit.
  - **Size:** the newest 200 entries are kept.
  - **CI:** the Go and Python example workflows restore the directory with `actions/cache`, keyed by the PR base SHA.
  - **Tests:** they use a cache in the temp directory, never `~/.cache`.
- **Reason:** user request (item 16). The base tree of every PR is read on every push.
  - Go: 7.5 s → 0.8 s, and Python: 3.0 s → 0.6 s, on a warm cache.
  - TypeScript reads only the head program; the base only when the routes file changed. Its time is almost all head, which changes on every push, so it is not cached.

## 2026-10-18 — Go: gin, echo and gRPC entry points; methods only called implicitly depend on their type

- **gin and echo** are read by package path and method name.
  - **Routes:** the verbs (`GET`…`Any`), gin `Handle`, echo `Add`/`Match`.
  - **Groups:** `r.Group(prefix, mw...)` assigned to a variable or chained. A group passed to a function binds the function's parameter while it is walked.
  - **Middlewares:** `Use` adds them to its router or group. A route's handlers and middlewares are its anchors.
- **gRPC:** a call to a `Register<X>Server(registrar, impl)` function makes every exported method of the `<X>Server` interface an entry point, `RPC <pkg>.<X>/<Method>`, anchored on the implementation's method.
- **Tests:** they use local stub modules with the real import paths (`replace` in go.mod), so they stay offline.
- **Type-to-method edges.** A type used to depend on all of its methods, so constructing a value (`store.New()`) reached every method. Now a method the project calls anywhere is resolved at its call sites, directly or through an interface. The type depends only on methods nothing in the project calls (only a library or reflection can) and on methods named like common implicit interfaces (`String`, `Error`, `MarshalJSON`, `ServeHTTP`, `Read`, `Write`, `Scan`, `Value`…).
  - The Go goldens g1–g7 and a real Go PR are unchanged; in g8 the gin route no longer reaches `store.Find`.
- **Reason:** user request (item 12), and precision.

## 2026-10-18 — Python: Flask, Django, MCP, Celery and Temporal entry points; module variable types

- **Flask:** `Flask`/`Blueprint` objects join the FastAPI machinery: `@x.route(path, methods=…)`, verbs, `url_prefix`, and `register_blueprint(bp, url_prefix=…)`, which replaces the blueprint's own prefix.
- **MCP:** `FastMCP` objects (fastmcp, mcp.server.fastmcp). `@mcp.tool` becomes `TOOL <name>`, `@mcp.resource(uri)` becomes `RESOURCE <uri>`, `@mcp.prompt` becomes `PROMPT <name>`, and `mcp.add_tool(fn)` is read too.
- **Celery:** `@app.task` on a `Celery` object and `@shared_task` become `TASK <name or module.function>`.
- **Temporal:** `@activity.defn` becomes `ACTIVITY <name>`. `@workflow.defn` on a class becomes `WORKFLOW <name>`, anchored on the class and all its methods (run, signals, queries).
- **Django:**
  - `ROOT_URLCONF` names the root URLconf. `urlpatterns` entries (`path`, `re_path`, `url`) and `include()` (by module name or imported module) are followed, giving `ANY /<prefix+route>`.
  - Class-based views (`View.as_view()`) are anchored on the class and its dispatch/HTTP-verb/generic-view methods.
  - `urlpatterns` counts as registrations, left out of the core hash and compared route by route.
- **Module variables assigned from a call.**
  - `x = ProjectClass(…)`: `x.attr` resolves through the class.
  - `x = ExternalThing(…)` (`FastAPI()`, `Celery()`, `logging.getLogger()`): `x.attr` reaches nothing in the project.
  - Before, both went to every project method with that name, so `@app.get(...)` linked routes to any method called `get`.
- **Reason:** user request (item 11), and precision. A real Python PR now also shows the Temporal workflow and activities it affects.

## 2026-10-18 — TypeScript frontends: declaration-level reach (supersedes "modifying an existing file is touches-existing")

- **Choice:** `src/project/decls.ts` builds, from the head program, the same declaration graph the Go and Python helpers print.
  - **Declarations:** functions, classes (header and fields), methods, variables, enums, types, and module-level code.
  - **Hashes:** of their tokens without comments or whitespace.
  - **References:** resolved with the type checker through imports, re-exports, property accesses, shorthand properties and JSX. Type positions and type declarations never create edges.
  - **Entry points:** the routes, anchored on the declarations of their modules plus everything those modules export (barrels and re-exports have no declarations of their own).
  - **Methods:** a method nothing in the project calls depends on its class (React lifecycle, libraries).
- **The base** is parsed per changed file only, for hashes (no second type check). Changed `source` TypeScript files get `declImpacts`, as in Go and Python. Only declarations whose code changed count, with the routes that reach them. New declarations, comments and formatting are additive (`declarations-additive`). Changed types are erased at runtime, listed as "types changed (erased at runtime)" and are not problems.
- **Kept on the file graph:**
  - Renamed files: declaration ids include the path.
  - JavaScript files: CommonJS and globals are only followed there.
  - Type-only files: their own rule.
  - Backends: TypeScript/JavaScript GraphQL/REST code often sets globals in bootstrap code, which the declaration graph would merge into "everything". On a real GraphQL PR that went from 73 to 148 operations, wrongly. Backends keep the file graph and the resolver-level impacts.
- **Effect on the scenarios:**
  - A file that only gains exports is now additive (16, split-routes modules, signals fixtures).
  - A change to one function of a shared file reaches only the pages that use it (new scenario 21).
  - A real frontend PR is unchanged (42 affected), after anchoring routes on exported declarations. Before that fix, the layout view looked unreachable.
- **Reason:** user request (item 4). File-level import centrality overstated the reach of changes to shared modules.

## 2026-10-18 — Python: local type inference instead of pyright

- **Choice:** `py-helper/revscope_py/typing_infer.py` (standard library only) infers which project class a name holds.
  - **Parameters:** annotations, including `Optional[X]`, `X | None`, `Annotated[X, Depends()]` and string annotations.
  - **Locals:** `x = X(…)` and `x: X = …`.
  - **Attributes of self:** class-level annotations (dataclasses, pydantic), `self.a = X(…)`, `self.a: X = …`, and `self.a = param` with `param: X`.
  - `x.method()` and `self.a.method()` then resolve through that class (and its bases). Unknown receivers keep the name-based resolution (conservative).
  - New scenario p8: a typed call no longer reaches an unrelated `find`.
- **Why not pyright:**
  - Pyright has no public API for references or a call graph. It would mean driving its language server per file (slow on 300+ files).
  - It is a large dependency, and its value here comes mostly from the cases above. Local inference covers them in under a second, with nothing to install.
- **Reason:** user request (item 4).

## 2026-10-18 — calibrate: score and verdict against what followed each commit

- **Choice:** `revscope calibrate --history <dir…>` reads `history` outputs and recomputes each commit's merge risk score and verdict. Each commit gets a label:
  - **Reverted:** a later `Revert …` naming its subject or SHA.
  - **Fixed:** within `--window` days (default 14), a commit whose subject is a fix (`fix:`/`fix(scope):`, hotfix, bugfix, "fixes") changes at least one of the same code files.
- **Output:**
  - **Rates:** the problem rate per verdict, per score range (20-point buckets) and per class.
  - **AUC:** of the score.
  - **Suggested thresholds:** below `quick` the rate is at most half the base rate; from `careful` it is at least 1.5 times.
  - Printed per repository and combined, and written as JSON with `--out`.
- **Limits:**
  - The label is a proxy: a fix may target older code, and a defect may be fixed without a "fix" subject.
  - History runs have no coverage or lint reports.
  - The weights stay hand-set; the report is the evidence to tune them.
- **Reason:** user request (item 1).

## 2026-10-18 — First calibration: global changes weigh less; the review verdict thresholds stay

- **Data:**
  - 528 first-parent commits from the past 180 days: python-services (Python, 264), go-service (Go, 106) and frontend-app (TypeScript, 158 readable; older commits used another routes file).
  - Labeled with `calibrate` at 14-, 7- and 3-day windows.
  - Before the change, at 14 days:

    | | python-services | frontend-app | go-service |
    |---|---|---|---|
    | AUC of the score | 0.81 | 0.83 | 0.57 |
    | Fast track | 2/12 | 0/46 | 0/2 |
    | Quick | 67% | 36% | 30% |
    | Careful | 94% | 49% | 32% |

  - "Fast track" had 2 problems in 60 commits (3%), against a 31–51% base rate, at every window.
  - In frontend-app, `global` PRs had 24% problems against 34% for `touches-existing`, and `isolated` had 0 of 52.
  - graphql-api (TypeScript backend) was still running; it is not part of this decision.
- **Change:**
  - A `global` class alone makes a quick review, not a careful one.
  - Global reasons weigh 0.3 instead of 0.6, and critical dependency changes 0.25 instead of 0.35.
  - Effect in frontend-app at 14 days: careful 55% vs quick 29% (was 49% vs 36%). At 7 days: 34% vs 18% (was 29% vs 28%). The AUC went from 0.83 to 0.835.
- **Kept:**
  - The careful threshold of 60. 75 sharpened frontend-app (59% vs 26%) but moved risky python-services commits into quick (quick 69%). 50 diluted it.
  - The quick threshold of 25.
- **Caveats:**
  - The label is a proxy and python-services's base rate is high (an active repository where fixes often follow features). Go's signal is weak on 106 commits.
  - Re-run `calibrate` as history grows.
- **Addendum (graphql-api, 134 commits, after the change):**
  - AUC 0.69. Careful 46% vs quick 19% at 14 days, and 28% vs 13% at 7 days. Fast track 0/4.
  - `global` 6/19 (32%) vs `touches-existing` 37/107 (35%): the lower global weight holds.
  - All 4 repositories (662 commits): fast track 2/64 (3%); careful 57% vs quick 49% at 14 days, dominated by python-services's noisy labels.

## 2026-10-18 — Environment, infrastructure and CI files have a role and a section; low-risk files stop adding up

- **Problem:** on a real Python PR, after reviewing every high- and medium-risk file, the merge risk score stayed at 67 (shown as 62 in the user's browser). About 12 helm/env/CI files were weighed as "modified code nothing reaches" at about 5 points each, plus tests with a few removed lines.
- **Choice:**
  - **New role `infra`** (`roles.infra`, defaults in `DEFAULT_INFRA`): env files, Dockerfiles, compose, CI pipelines, helm, k8s, terraform, Procfile…
    - Matched on repo-relative paths, also outside the project directory, and never for source code files.
    - Reason `infra-file-changed` (touches-existing, as before: deployments run these files).
    - Its own section in the review plan, with diffs and "reviewed" boxes.
  - **Score:**
    - All infra files of a PR together weigh 0.12, shared by file so each stays reviewable.
    - Files that are not code (docs, templates) weigh nothing.
    - A changed code file no entry point reaches weighs 0.03 + 0.1 × centrality (was 0.05 + 0.15 × centrality), and new code no entry point reaches 0.02 (was 0.05).
    - Tests with fewer than 10 removed lines weigh 0.02 (was 0.05).
  - **Verdict:** "existing code changed" counts code reasons only; infra changes are their own quick-review reason.
- **Effect:** that PR goes from 91 to 26 once its high- and medium-risk files are reviewed (was 96 to 67).
- **Calibration after the infra role** (all 4 histories regenerated, so infra files are no longer code; 662 commits, 14-day window):

  | | python-services | go-service | frontend-app | graphql-api |
  |---|---|---|---|---|
  | AUC | 0.75 | 0.82 (was 0.57) | 0.83 | 0.72 |
  | Quick | 57% | 8% | 27% | 16% |
  | Careful | 94% | 33% | 55% | 47% |

  - Fast track: 0 problems in 56 commits.
  - Fixes that only touched infra no longer count against code, which cleaned the Go labels most.

## 2026-10-18 — The project is named farol everywhere (was revscope)

- **Choice (user decision, for the open-source release):** the repository is `winnin/farol` and the parameters file `.farol.json`, so everything else follows:
  - the CLI and npm package `farol`, and the action `winnin/farol/action@main`;
  - the default configuration `farol.config.json`, and the report texts and titles;
  - the PR comment marker `<!-- farol -->`;
  - the cache `~/.cache/farol` (`FAROL_CACHE_DIR`) and the Python helper package `farol_py`;
  - the example files `farol.json` and `farol.html`.
- **Compatibility:**
  - Results with `tool.name: "revscope"` are still read.
  - A PR comment with `<!-- revscope -->` is updated, not duplicated.
  - `revscope.config.json` is read when `farol.config.json` does not exist.
  - `REVSCOPE_CACHE_DIR` is still honored.
- Earlier entries of this file keep the old name: they record what was decided then. `docs/SPEC.md` is the original specification and keeps it too.

## 2026-10-18 — Open-source release preparation

- **Choice:**
  - MIT license (© 2026 Winnin, user decision).
  - README rewritten for users: a 5-minute quick start, support matrix, installation, usage, configuration, reports per language, GitHub Actions, reading the report, limitations, FAQ.
  - `docs/how-it-works.md` holds the analysis details per language, the dependency rules, the signals and every score weight.
  - New `CONTRIBUTING.md` (setup, architecture, the rules every change follows, how to add frameworks, languages and report formats, golden scenarios), `SECURITY.md` (private reporting, the guarantees that make up the security model) and `CHANGELOG.md`.
  - `package.json` metadata (description, keywords, repository, homepage, bugs, author).
  - The repository's CI also sets up Go and Python, since the helper scenario tests need both.
- **Internal references removed** from the docs and examples: the private repositories the analysis was validated on are named by role (`frontend-app`, `graphql-api`, `python-services`, `go-service`), and personal paths are gone. Git history still contains the earlier text: publish from a fresh history if that matters.

## 2026-10-18 — Python: Prefect flows are entry points

- **Choice:** a function decorated with `prefect.flow` (`@flow`, `@flow(name=…)`) is an entry point `FLOW <name>`, using Prefect's default name when none is given (the function name with underscores as hyphens). Tasks (`@task`) are not entry points: they run inside flows, and the reference graph reaches them through the flows that call them. New scenario p9.
- **Reason:** user request. Prefect projects schedule and deploy flows, which play the role routes play for an API.

## 2026-10-18 — Report: highlighted diffs, full screen, filtering "Start here" by entry point

- **Syntax highlighting:**
  - highlight.js (common build, `@highlightjs/cdn-assets@11.9.0`, ES module from jsDelivr, exact version) is loaded the first time an inline diff opens, like Mermaid.
  - Each line is highlighted on its own, in the language of the file extension (Dockerfiles and env files as shell). Multi-line strings and comments are colored on their first line only.
  - The colors are tokens of the report's own stylesheet, light and dark. Without network the diff stays plain.
- **Full screen:** a button on every inline diff and route graph uses the Fullscreen API (Esc leaves). The graph fills the screen.
- **Entry filter:**
  - "Start here" gets a filter: typing part of a page/operation path (suggestions list the affected and new ones) shows only the files that reach a match. Collapsed lists with matches open.
  - Each row carries the entry points it reaches. New Go/Python entry points now record the file that registers them as their entry (the handler module for decorators, the router setup for Go), so they can be found too.
- **Reason:** user request.

## 2026-10-18 — Docs: SPEC in English, validation notes without internal names

- **Choice:** `docs/SPEC.md` is now an English translation of the original v0 prompt, with a note that the project was renamed and grew past v0 (deviations live in this file). DECISIONS and PROGRESS describe the real repositories used for validation by kind ("a real Python PR") instead of PR numbers, module names and domain terms; test fixtures and code comments use generic names.
- **Reason:** user request, before open-sourcing. Git history still contains the earlier text.

## 2026-10-18 — Traffic from Datadog (RUM, APM): `farol usage` and `analyze --usage`

- **Problem:** the user wants each affected page/operation weighed by how much it is used: RUM page views for pages, APM requests for operations. `analyze` must never use the network.
- **Options:** query Datadog inside `analyze`; a separate command writing a file that `analyze` reads, like coverage reports. Traffic in the score now, or information only.
- **Choice:**
  - A new command, `farol usage`, is the only network user besides `comment`. It writes `usage.json`, and `analyze --usage` (or `signals.usage`) only reads it.
  - New top-level module `src/datadog/` (native `fetch`, like `src/github/`). It makes two calls: RUM aggregation (`/api/v2/rum/analytics/aggregate`, count by `@view.url_path_group`) and the metric query (`/api/v1/query`, `sum:trace.<op>.hits{service,env} by {resource_name}.as_count()`).
  - Metrics over indexed spans: trace metrics count every request, not a sample, and keep 15 months.
  - `datadog.site` is a closed list of Datadog sites and the names in queries are restricted to `[A-Za-z0-9_.:-/]`, so a changed configuration cannot send the keys to another host or reshape the query. The example job checks out the base branch, never the PR.
  - **Information only:** the output gets an optional `usage` section; class, score and verdict are unchanged. The report shows the share of all traffic going to the affected entry points, the traffic of each, busiest first, and per file the traffic of the entry points it reaches. Weighing the score waits for calibration on real data (user choice).
  - Matching Datadog names to entry points normalizes strings (Datadog tag rules, path segments). This is not code understanding, so the no-regex rule does not apply. A row goes to the most literal match, and ties count for each. GraphQL root fields match `graphql.resolve` resources (`field:type`, verified on real data); nested fields with a root field's name count for it too.
- **Checked on real data:** RUM `@view.url_path_group` values look like `/org/?/brands`, and `trace.fastapi.request.hits` resources look like `get_/carts/_cart_id_/items`. Both are covered by the unit tests.
- **Reason:** user request; keeps the network and secret boundaries of the security model.

## 2026-10-18 — Production errors per entry point and per changed file

- **Problem:** the user wants Datadog errors in the report, and how many errors each changed file has thrown.
- **Choice:**
  - **Per entry point:** the same traffic rows carry errors. These are RUM `@type:error` events grouped by the same facet, and the APM metric `trace.<op>.errors` by `resource_name`.
  - **Per file:** Error Tracking issues (`/api/v2/error-tracking/issues/search`, `track` rum/trace, ordered by count, at most 100 per call), filtered by the RUM application or the APM service. Each issue's `file_path` (top stack frame) is matched to a changed file by the longest shared path suffix, comparing file names without extensions. This holds because compiled `dist/x.service.js` frames are `src/x.service.ts`.
  - The match needs three segments, or two that are a whole path; ties and dependency frames (node_modules, site-packages, .venv, the Go root) match nothing. Verified on real issues: browser paths after source maps look like `../../../apps/<app>/src/…/index.jsx`, and Node backends report `/home/dist/modules/…/x.service.js`.
  - Only error types go into the report, never messages (they may carry user data). `datadog.errors: false` turns it off.
  - Information only, like traffic.
- **Reason:** user request.

## 2026-10-18 — Traffic matching tuned on real data

- **Problem:** the first real runs, on 4 repositories, distorted the shares.
  - In a repository with three FastAPI services, `/healthz` of each service went to every service's `/healthz` key, and probes were 83% of all requests.
  - In a GraphQL API, `graphql.resolve` also counts nested fields (`title:string`), so the total was 1.1M against 4k for root fields.
- **Choice:**
  - With several `apm.service` values, rows keep their service. A row then goes only to keys whose service label (letters and digits) is part of the service name (`orders_api` in `shop-orders-api`), when there are such keys.
  - Ties are split evenly instead of counted for each.
  - Health checks and metrics scrapes (last segment `health`, `healthz`, `healthcheck`, `ping`, `readiness`, `liveness`, `ready`, `live`, `metrics`…, paths of at most two segments) are dropped.
  - Shares use the traffic that matched some entry point (`matched`, `matchedErrors`), not every row.
- **Observed:** `graphql.resolve` metrics of the API carried `synthetics:true` only. Resolver spans may cover part of the traffic, so GraphQL numbers are documented as relative.
- **Reason:** results of the user's real PRs.

## 2026-10-18 — Distinct errors per entry point; added declaration-only files weigh almost nothing

- **Distinct errors:** the user wants the number of *distinct* errors per page/operation, as Datadog shows them, not totals.
  - `farol usage` groups RUM error events (`/api/v2/rum/analytics/aggregate`) and APM error spans (`/api/v2/spans/analytics/aggregate`, `status:error`) by page/resource and `@issue.id`. Rows carry the issue ids.
  - Distinct counts per entry point and for all affected ones are exact unions, so an error seen on two pages counts once. Ties between entry points do not split issues.
  - Error spans are the indexed ones, so the count of distinct errors survives sampling better than totals would.
  - Total error counts (`trace.<op>.errors`, RUM error counts) were removed.
- **Declaration-only added files:** a new TS/JS file whose statements are all types, interfaces, enums, imports/re-exports or `const`s with static values (literals, objects/arrays of them, references, `as const`) gets `declarationsOnly` in the output. It weighs 0.01 in the merge score, and all such files together at most 0.05 (raised from 0.03 at the user's request), shared like infra.
  - Detected with the TypeScript parser, not coverage: coverage reports leave statement-less files out.
  - Also accepted: a call of a named function whose arguments are all static (`defineTranslateKeys({ … })`), and arrow functions that only return a static value (`(p) => ({ key, parameters: p })`). Translation key modules are written that way.
  - Any other call, function body, class, JSX, `let` or side-effect import disqualifies a file. Files named `index.ts` that hold an implementation stay code.
- **Reason:** user request; the chance that such a file breaks something is very low.

## 2026-10-18 — Contract changes of backend endpoints

- **Problem:** the user wants breaking changes of endpoints flagged: what an endpoint receives and returns, not only whether its code changed.
- **Options:** text diffs of models; OpenAPI generation (would run the app); reading the contract with each language's parser and comparing structured shapes.
- **Choice:**
  - A shared shape format (`src/contracts/types.ts`), one direction-aware comparison, and readers per stack:
    - GraphQL: graphql-js `findBreakingChanges`/`findDangerousChanges` on base and head schemas built from SDL;
    - FastAPI: Python helper, `ast` only;
    - Go handlers and gRPC: Go helper, `go/types`.
  - Entries carry an optional `contract` in the helper JSON. The output gets a `contracts` section with each entry's changes, worst first, and a readable count.
  - Unreadable contracts are never "safe": losing one is dangerous, and endpoints without one are not compared.
  - Breaking changes make the verdict careful and share a weight of 0.4 in the score (dangerous: 0.1), not tied to a file: reviewing the code does not tell whether clients were updated.
  - Callers of each changed endpoint come from Datadog client spans (`peer.service`) in `farol usage`.
  - graphql-js change descriptions are matched with regular expressions to find the type/field they name. This parses tool output, not code.
  - Path parameters of FastAPI routes are read by splitting on braces.
- **Not covered yet:** TypeScript REST handlers, OpenAPI files, Flask (no types), and Go handlers that encode through interfaces or third-party helpers.
- **Reason:** user request.

## 2026-10-18 — HTML report: links to Datadog and a modern visual layer

- **Datadog links:** usage reports keep the Datadog site and, per entry point and per file, the ids of the distinct errors. Error counts link to the APM traces explorer (operations) or the RUM sessions explorer (pages), with the query `@issue.id:(…)` and the analyzed period. These are URL formats Datadog itself returns. The site must be one of the known Datadog sites, otherwise there is no link.
- **Visual layer** (`src/report/html-style-theme.ts`, on top of the layout rules): slate/indigo tokens for light and dark; cards with soft shadows and 12–16px radii; a sticky translucent section bar; a review plan tinted by verdict with an accent stripe; soft-filled chips, pills and facts; hover and focus-visible states. No external fonts: the system stack, with Inter when installed.
- New output fields default to empty, so reports written by earlier versions still render.
- **Reason:** user request ("the UX is good, the UI is not").

## 2026-10-18 — Pages behind a feature flag

- **Problem:** a page, route or operation can be entirely behind a feature flag. Its risk is then irrelevant to the reviewer, but its files still weigh in the review.
- **Choice:**
  - Each page/operation row of the HTML report gets a "🚩 Behind a feature flag" toggle. Layouts get none: they wrap other pages.
  - A changed file whose every page/operation is flagged leaves the review like a reviewed one (score, Start here, remaining entry points, the reviewed panel), labeled "behind a flag" and not ticked. Files that an unflagged entry point also uses still count.
  - Which files a page uses comes from the same data as the rows (`data-files`, the changed files on the way to it), so a file reaching no page is never covered by a flag.
  - Flagged rows stay visible (dashed) so the flag can be undone. The state is saved with the ticks, per commit, in the browser.
  - The toggle is a button inside the row's summary that cancels the click, so flagging does not expand the row.
  - The review script moved to `src/report/html-review-script.ts` to keep files under 400 lines.
- **Term:** "behind a feature flag" instead of "skip", at the user's request, so it is clear why the risk is left out.
- **Reason:** user request.

## 2026-10-18 — Reviewers by authorship: `farol reviewers`

- **Problem:** the user wants reviewers suggested by who wrote the code a PR changes, from a separate run that reads the analysis, added to the HTML like the Datadog usage.
- **Choice:**
  - `farol reviewers --in farol.json` reads the analyze JSON and runs git only: blame at the merge-base of the 40 riskiest changed code files (the whole file, then the removed and context lines of the diff), and lines added to the directory in the past 12 months for new files.
  - Each person's share of a file is half the whole file and half the touched lines. Files weigh by their risk points (at least 1).
  - PR authors and bots are left out. People with no commit in 6 months keep their score but rank at a quarter of it, labeled inactive.
  - CODEOWNERS are listed apart.
  - Output: `reviewers.json` (names only, no e-mails), checked against the analysis head when added with `--reviewers` to html/report/comment. It is merged at render time as `ownership`.
  - `analyze --reviewers` (recent committers) stays for compatibility. The authorship file wins when both are present.
  - Git authorship helpers are in `src/git/authors.ts`. A missing file at the base is checked with `ls-tree`, not caught.
  - Identities (`name`, `email`) of one person are merged before ranking (`src/review/identities.ts`): the same e-mail, a GitHub noreply login matching a name, or names where one holds all the words of the other (two at least) or that are equal without spaces. On real repositories the PR author's other identities (a full name, a GitHub login, a longer name) were otherwise suggested as reviewers. A `.mailmap` covers the rest (git applies it).
- **Reason:** user request; blame tells who knows the code better than commit counts do.

## 2026-10-18 — Result tab, checks, flag panel, Reviewers tab

- **Problem:** the reviewer wants to record what they did (flags, reviewed files, checked security findings and contract changes) and paste it in the PR, with the initial and final risk. They also want flags at the top and reviewers out of the overview.
- **Choice:**
  - A collapsed panel below "Mark files as reviewed" lists every page/operation with changed files, each with a 🚩 toggle and a search box. It shares one state with the row toggles.
  - Security findings, vulnerable dependencies and breaking/dangerous contract changes get a *checked* box. The checks are saved with the review state per commit, but **do not change the score**: a verified break or finding is still there. They are a record.
  - A **Result** tab renders Markdown from the review state and the score card: the initial verdict and score, the score now, files reviewed out of the review panel's files, entry points left, flags (with the files they took out), reviewed files, and checks as task lists (`- [x]`). *Copy as Markdown* uses the clipboard API, or selects the text when the page has no permission (file://).
  - The review script exposes its state as `window.farolState` before it announces a change, and the Result script renders on that event. Static data (initial risk, findings, contracts, texts) is a JSON script element with `<` escaped.
  - Suggested reviewers move to a **Reviewers** tab.
- **Reason:** user request.

## 2026-10-18 — One comment per push, with the commits since the last push

- **Problem:** the user's workflow posts a new PR comment on every push, with the full report and the report of the commits since the previous push.
- **Choice:** `comment --new` always creates a comment (no lookup of the marker). `--since-in <json>` (an `analyze --since` result) adds a block on top with its verdict, score and file count, and `--since-report-url` links its HTML report. The action exposes `new-comment`, `since-in` and `since-report-url`.
- **Reason:** user request.

## 2026-10-18 — Speed: parallel Go type-checking, cached helper binary, concurrent Datadog and blame calls

- **Measured** on a real Go PR in CI: farol took about 10 s of a 10+ minute job. The rest was the repository's own tests, lint and govulncheck, which the workflow ran a second time next to the existing Tests workflow. Inside farol: 6.5 s reading base and head with the Go helper, 1.2 s building the helper, 0.7 s signals.
- **Choice:**
  - The Go helper parses and type-checks packages in parallel. Each package waits for its imports (from `go list -deps`), and at most GOMAXPROCS run at once. On that repository: 5.3 s → 2.7 s, with byte-identical output, also under `-race`.
  - The helper binary is built into the cache directory, keyed by helper source, Go version and platform, so CI caches of `~/.cache/farol` skip the build.
  - `farol usage` runs its Datadog queries six at a time and sorts the rows afterwards. `farol reviewers` runs eight `git blame` processes at a time.
  - The CI integration advice: run farol right after the repository's existing test and lint jobs, reusing their coverage and lint reports instead of running them again.
- **Reason:** user request ("it took more than 10 minutes").

## 2026-10-20 — Logo in the HTML report

- **Choice:**
  - The logo files of `assets/` (horizontal logo and square icon, light and dark) are copied into `src/report/html-assets.ts` by `scripts/embed-assets.mjs`, which `npm run build` runs. A test fails when the module and the files differ.
  - The report stays one self-contained file. The header inlines the horizontal logo, cropped to its content and without its background rectangle. It shows the light or dark variant with the theme tokens (system preference or the page's toggle).
  - The favicon is the square icon as a data URI, one per color scheme.
  - Comments of the SVGs are dropped when inlining. The files were checked to hold no scripts or external references.
  - The README shows the logo with a `<picture>` for dark mode.
- **Reason:** user request.

## 2026-10-21 — Next.js and TanStack Router adapters

- **Choice:**
  - Two route adapters next to `react-router`: `next` (Pages Router and App Router) and `tanstack-router` (file-based routing). The adapter interface gains `source: 'file' | 'directory'` and a `files` list: a directory adapter receives the repo-relative files under `routes.dir` (from the git tree of the commit) and reads them through `read`, so it never touches the disk.
  - Configuration: `routes.adapter` takes the three names; `routes.file` stays required for `react-router` and is rejected for the directory adapters, which take `routes.dir` (Next.js: the directory holding `pages/`/`app/`, default the project or its `src/`; TanStack Router: default `src/routes`).
  - Next.js routes come from file names alone (the framework's contract). TanStack Router routes come from the literal id of `createFileRoute('<id>')`, parsed with the compiler API, not from file names: flat and nested file layouts give the same table, and a non-literal id is a dynamic route (fail closed).
  - `_app`/`_document`, App Router `layout`/`template` and middleware (`middleware`/`proxy`) are layouts of the routes they render, so a change there reaches every route under them; TanStack Router parent and pathless routes are layouts of their children and are not listed as pages.
  - Any change under the routes directory (added files included) makes analyze read the base route table; route changes are reported against the route's own module instead of a routes file.
- **Reason:** user request: analyze Supabase Studio (Next.js pages, migrating to TanStack Start).

## 2026-10-21 — Go: non-constant paths, library methods through interfaces, constants by value

- **Choice:**
  - **Non-constant route paths** no longer make a PR `unknown`. A local variable takes the constant last assigned to it before the registration; any other expression is kept as the path in braces (`POST {path + "*"}`). The handler (what the route runs) is still read, so reach stays complete; only the URL is unknown. Non-constant HTTP methods stay dynamic routes.
  - **Library methods through interfaces:** a call of an implicit method (`String`, `Error`, `MarshalJSON`…) through an interface outside the project (`fmt.Stringer`, `json.Marshaler`) no longer reaches every implementation in the project. The value's own type already depends on its implicit methods, so code that uses a type still reaches them. Project interfaces keep class hierarchy analysis.
  - **Constants** are hashed by type and value instead of the text of their group: appending to an `iota` group changes no other constant.
  - **Not supported:** project types that wrap chi with their own registration API (Gitea's `web.Router`, with `Group` keeping the prefix in a field and `Combo`). The pattern is rare outside the Gitea family; reading it means guessing a project's own conventions. Their routes stay unread and PRs that need them are `unknown`.
- **Reason:** analyzing a Gitea PR showed each of these on generic Go code; farol stays free of project-specific conventions (open source, many projects).

## 2026-10-21 — Inline diffs: cut hunks, 1,000 lines per file

- **Choice:** a hunk over the remaining room is cut to its first lines instead of dropped, and the per-file limit goes from 400 to 1,000 lines (8,000 in total, unchanged). The cut file stays `truncated`, with the link to the full diff on GitHub.
- **Reason:** user report: a new file is one hunk, so a 714-line new file (the riskiest of the PR) had no inline diff at all while smaller, less risky files had theirs.

## 2026-10-21 — Python: settings prefixes and non-literal paths

- **Choice:** a route path or router prefix that is not a literal no longer drops the routes (which made the PR `unknown`). It is read from a module constant, or from the string default declared on the class of a module-level settings instance (`settings = Settings()`, `API_V1_STR: str = "/api/v1"`: the pydantic-settings pattern FastAPI documents); any other expression becomes the path in braces. The handlers are still read, so reach is complete; only the URL may be unknown. Same rule as Go.
- **Reason:** the official FastAPI full-stack template (`include_router(api_router, prefix=settings.API_V1_STR)`) showed one entry point out of 24.

## 2026-10-21 — Barrels compared by binding, not by text

- **Choice:** the barrel rule compares what each export declaration exports (module, name, alias, type-only flag) instead of its text: `export { A, Z } from './a'` keeps `export { A } from './a'`. Removing, renaming, retargeting or turning a binding type-only is still a change. SPEC.md is updated.
- **Reason:** adding a name to an existing list has the same runtime effect as adding a declaration, which the rule already accepted. Generated clients (openapi-ts, graphql-codegen) add names that way: one new type in `client/index.ts` made every page that imports the client "affected" (seen on the FastAPI full-stack template).

## 2026-10-21 — FastAPI contracts: dependencies through project aliases

- **Choice:** a parameter annotated with a project alias of `Annotated[T, Depends(…)]` (`CurrentUser = Annotated[User, Depends(get_current_user)]`) is injected, like `Annotated[T, Depends(…)]` written in place: it is not part of the request. Query, Path, Header and Body markers are read through aliases the same way.
- **Reason:** that alias is the style the FastAPI docs recommend; on the FastAPI full-stack template every endpoint with `current_user: CurrentUser` showed the User model as its request body, so a change to Item reported a body change on every endpoint.

## 2026-10-21 — Monorepos: only the project's own ecosystem above it

- **Choice:** a manifest or lockfile above the project directory counts for the project only when it belongs to the project's language (`package.json` and npm/pnpm/yarn/bun lockfiles for TypeScript, `go.mod`/`go.sum` for Go, `pyproject.toml`, `requirements.txt` and uv/Poetry/Pipenv/PDM lockfiles for Python). Inside the project directory every manifest and lockfile still counts.
- **Reason:** in the FastAPI full-stack template, the root `bun.lock` (the frontend's) made a change to the Python backend `global`.

## 2026-10-21 — Test plan follows the review

- **Choice:** each test plan item carries the changed files behind it (every file of its chains for an affected entry point, the module a new one renders). When all of them are marked as reviewed, the item looks like a reviewed file (✓ files reviewed); when they are out of the review because of feature flags, or the entry point itself is flagged, it shows 🚩 behind a flag. The progress line counts them. The manual-test checkbox is not ticked: reviewing the code is not testing the page.
- **Reason:** user request.

## 2026-10-21 — Role defaults per language, key by key

- **Choice:** each `roles` key left out of the configuration takes the default of the project's language. Before, the Go and Python defaults applied only when `roles` was left out entirely: setting `roles.global` in a Python project brought back the TypeScript test globs, so Python tests were read as code.
- **Reason:** found while writing examples/README.md; user request to fix it.

## 2026-10-22 — npm package `@winninjs/farol`, no runtime dependencies

- **Choice:** the package is published publicly on npm as `@winninjs/farol` (scope of the publishing organization; the binary stays `farol`). Runtime libraries move to `devDependencies`: tsup already bundles all of them into `dist/cli.js`, so the published package has no dependencies to install. The tarball holds `dist/`, `go-helper/`, `py-helper/`, the README and the license. Version 0.1.1, since the git tag v0.1.0 predates the package name.
- **Reason:** user request.

## 2026-10-24 — The action at the repository root, for the GitHub Marketplace

- **Choice:** `action.yml` at the root is the Marketplace entry ("farol PR risk review"); `action/action.yml` stays for `uses: winnin/farol/action@…`, which repositories already use. Both have the same inputs and steps and call the same `dist/cli.js`; only the name, the description and the path to `dist/` differ, and `test/e2e/action.test.ts` fails when they drift.
- **Reason:** the Marketplace only lists an action whose `action.yml` is at the repository root; moving it would break the existing `action/` references.

## 2026-10-26 — The HTML report becomes a review workbench; score weights revised

- **Choice:** the HTML report is rebuilt around the review: a side rail with the live merge risk, *Must check* (breaking contract changes, security findings, lint errors, vulnerable dependencies, each confirmed on its own: reviewing the file no longer clears them) and the files in tiers by their own risk (High ≥ 20 points, Medium ≥ 5, Skim, Test files), each with a "reviewed" box; a main area with the summary (the two largest parts of the risk in one sentence, the parts of the score with shares that add up to it, diff coverage collapsed), one file at a time (diff with untested lines marked, links to comment on any line in GitHub, a note that goes into the results), a dependency view (the bump, what it means, how to check it), *Can affect* (pages/operations to try by hand, feature flags) and *Results* (Markdown for the PR comment). Every part of the score tied to a file is reviewable: manifests and trimmed tests join the file list. Below 30 points with nothing left in Must check, the report says the merge is likely safe to approve. The former tabs (reach table, security, dependencies, signals, contracts, reviewers, routes with their graphs, files, reasons, diagnostics) stay as the *Details* page, shown in a frame; the review plan, test plan, reviewed-files and flag panels and the Result tab are replaced by the workbench.
- **How:** the page is rendered in the browser from one JSON view model (`src/report/workbench-model.ts`) and texts (`src/report/strings-workbench.ts`). The stylesheet and browser scripts are real files in `assets/report/`, embedded into `src/report/html-assets.ts` by `scripts/embed-assets.mjs` like the logo (a test fails when they drift). No new runtime dependency.
- **Score:** a dependency bump weighs by how much it can break (major or removed 0.15, versions that cannot be compared 0.10, a 0.x minor or 0.0.x patch 0.08, compatible 0.02) instead of 0.25 for any "critical" one; a lint error on the line of a security finding is counted once; security findings, lint errors and suppressions in files outside the project (`excluded`) no longer count.
- **Reason:** user request after the first public feedback: the report was not clear about how much of the new code is tested and the score counted some things too much (a minor bump of a design-system package was a quarter of a 31-file PR; on the demo backend, two files and the contract left 42 points).

## 2026-10-26 (2) — The PR comment counts like the report; files left out of coverage on purpose

- **Problem:** the comment still listed "Start here" files with the points of the file and its findings together (`items.py` risk 34) while the report shows the file (4) and its security finding (21) apart. And changed files the project excludes from coverage (migrations, generated code, constants) counted as entirely untested.
- **Choice:**
  - `src/report/review-parts.ts` splits the score into parts like the report's browser code (a file without its security and lint findings, each finding, contract changes, vulnerable dependencies, analysis problems) with whole-number shares that add up to the score (log attribution, largest remainder). A test runs the page's `wb-core.js` on the same data and compares the points. The verdict's file points leave findings out too.
  - The comment's top follows the report's summary: title with the merge risk and verdict, the lede sentence (same texts as the report), *Must check* as a task list, High and Medium files (by their own points: ≥20, ≥5) with their share, coverage. The former signal list moves to a collapsed *All signals* block; classification and the test checklist stay where they were.
  - Coverage: a changed file missing from the report is **excluded by the project** when the report lists at least one file whose statements all count 0 (the tool was told which files to measure: Vitest/Jest `coverage.include`/`all`, coverage.py `source`). Not for Go profiles, which leave out packages without tests. A TypeScript file that only declares things (`isDeclarationsOnlyModule` on the head content) has no executable line. Excluded files are listed in `signals.coverage.excludedByProject` (optional, absent when empty).
  - Excluded and `coverageIgnore` files keep `LEFT_OUT_RISK` = 0.5 of their reach weight (like declarations), labeled as left out, instead of 1.
- **Reason:** user request; the comment and the report must not disagree on the same PR. Fail closed still holds where it matters: without evidence that the report lists unloaded files, a missing file stays untested; and a left-out file keeps half its risk rather than the 30% of a fully covered one.

## 2026-10-26 (3) — Routes with a computed path: unknown when new or changed (issue #6)

- **Problem:** a new FastAPI route whose path came from a function call was read as a new entry point `GET /reports{path('summary')}`, so a PR that shadows an existing route was `isolated` and fast track. Go kept such paths the same way; TypeScript REST dropped the route entirely. The 0.1.0 choice (keep `{expr}`, no problem) was meant to avoid making every PR of a repository with one such route `unknown`, but it did not tell new routes from old ones.
- **Choice:**
  - The helpers (Python `RouteFinder.path`, Go `routeFinder.pattern`) record every path they read as `{expr}`; an entry whose key holds one is `computed`. TypeScript `restNodes` keeps a non-string path on a server receiver (`app`, `router`, `fastify`…) as `{expr}`, `computed`. `RouteEntry.computed` carries where it is registered.
  - `classify`: a computed route that is new (not in the base table) or registered in a changed file adds `dynamic-route` (→ `unknown`) and a diagnostic. Untouched computed routes stay readable entry points.
  - Report and comment: `unknown` score items tied to a file are parts of their own in Must check ("farol could not read this", checked by hand), like security findings. Reviewing the file no longer clears them, and the "likely safe to approve" state needs them checked.
- **Reason:** fail closed. farol cannot tell which URL a computed path takes, so it cannot rule out that it takes an existing one (FastAPI, chi and Express serve the first match).

## 2026-10-26 (4) — Command-line commands as TypeScript entry points; farol reviews its own pull requests

- **Problem:** farol run on itself found no entry point (Python `__main__` and Go `main` are entry points, a TypeScript CLI was not): every changed file was "no operation reaches it", ranked by dependents only.
- **Choice:**
  - `src/backend/cli.ts` (inside the existing `backend` module, next to `rest.ts`): commander and cac `X.command('<spec>')….action(handler)`, and yargs `X.command('<spec>', '<description>' | false, builder, handler)`. The key is `CLI <first word of the spec>` (`$0`/`*` → `(default)`); the handler's code is the entry point's, as for a REST handler. A computed spec is kept as `{expr}` and marked computed (see 2026-10-26 (3)). `backend.cli` (default true) turns it off. `package.json` `bin` is not read: it usually points to the build output, not the sources.
  - The yargs form needs a string (or `false`) description, so `redis.command('GET', key, cb)` is not a command.
  - `.github/workflows/farol.yml` is `examples/workflow.yml` with `./action` (the PR's committed `dist/`, which CI checks against the sources), Go and Python for the helper scenario tests, and no Datadog job. `farol.config.json` at the root: backend surface, no GraphQL, `test/fixtures/**` and `dist/**` excluded.
  - `@vitest/coverage-v8` as a dev dependency (not runtime: nothing changes in the npm package), with `coverage.include: ['src/**/*.ts']` so files no test loads are reported.
- **Reason:** user request (dogfooding), and command-line tools are a common shape of TypeScript open source projects.

## 2026-10-26 (5) — GOTOOLCHAIN=local for go list; coverage on failure in the example workflows

- **Problem:** CI failed on every push since 0.1.0: with Go 1.22 installed, the `g6-go-directive` fixture (`go 1.23`) made `go list` try to download the go1.23.0 toolchain (refused by `GOPROXY=off`). The helper's own build ran with `GOTOOLCHAIN=local`, the `go list` of the analyzed repository did not. And farol's first self-review had no coverage: Vitest writes no coverage report after a failing run unless `coverage.reportOnFailure` is set, although the example workflow said a failing run still has one.
- **Choice:** `GOTOOLCHAIN=local` in every go command (helper `goEnv` and `lang-workspace`): a module that needs a newer Go fails closed (`unknown`, with Go's message). CI installs Go 1.23. `--coverage.reportOnFailure` in the example workflows, the README recipes and farol's own workflow (and `reportOnFailure: true` in vitest.config.ts).
- **Reason:** `analyze` never touches the network; and a failing test must not turn into "nothing is tested".

## 2026-10-26 (6) — Review of PR #7 (Copilot)

- **Computed paths:** the helpers no longer match every computed expression against every route key (a computed `{id}` marked the literal `GET /{id}` as computed). The braces of a computed path carry a NUL mark (no route path holds one), turned into the entry's `computed` flag and stripped from the key. Scenarios p12 and g11 now use a computed expression whose text is a literal path parameter of the same file.
- **TypeScript REST:** `router.route(path('x')).get(handler)` keeps the computed path too (the chained form dropped it).
- **Coverage, files left out by the project:** an all-zero file is no proof on its own (a module that loaded but whose functions never ran is one). The proof is a file where nothing ran, not even a statement that runs on load: an Istanbul statement outside every function, Vitest's `(empty-report)` function (its mark for a file of `coverage.include` it never loaded), or any coverage.py line (a module that loads runs its import and def lines).
- **Self-review workflow:** the job that runs the pull request's own `./action` has a read-only token; it writes the comment with `farol report` (now with `--since-in` / `--since-report-url`, like `comment`), and a separate `comment` job, which runs no code of the pull request, posts the file with `gh pr comment`.
- **Not changed:** `needs: [tests]` with `if: !cancelled() && …` does run after failed tests (`cancelled()` is a status function, so the default `success()` does not apply); the first run of this pull request shows it: tests failed, the farol job ran.

## 2026-10-26 (7) — Syntax highlighting in the report's diffs; full width

- **Choice:** `assets/report/wb-highlight.js`, a line tokenizer written for the report (no library): comments, strings, keywords, literals, numbers, types (capitalized names), calls and Python decorators, for TypeScript/JavaScript, Go, Python and GraphQL by file extension; other files stay plain. An open block comment or multi-line string carries to the next line, with one state per side of the diff (context lines feed both). Colors are theme tokens (`--t-*`, light and dark). The main area drops its 1,100px cap; paragraphs keep a 100ch measure.
- **Reason:** user request. A highlighting library (highlight.js, Prism) would add a dependency and tens of kilobytes to every report for what diff review needs: telling code, strings and comments apart at a glance.

## 2026-10-26 (8) — Second review of PR #7 (Copilot)

- **Self-review workflow:** a `pull_request` workflow is defined by the pull request itself (same-repository PRs), so a write token in any of its jobs is in reach of the PR. `farol.yml` now has no write permission at all; it uploads the comment and the PR number, and `farol-comment.yml` (`workflow_run`, always the default branch's version) posts it, after checking that the number is a number and that the pull request is still at the commit the run analyzed. Fork pull requests get the comment too. It only takes effect once on the default branch.
- **Computed paths, where they are computed:** the helpers' mark now carries the file and line of each computed expression, and the entry lists them all (`computed: [{file, line}]`). A computed router prefix is reported at its `include_router`/`Route`/`Group` call, and an existing route is `unknown` when any file that computes its path changed (scenario p13: only the body of the prefix function changed).
- **Coverage:** an Istanbul file without `fnMap` gives no proof that it never loaded.
- **`.farol.json`:** `report.sinceIn` and `report.sinceReportUrl`, `sinceIn` relative to the file.
- **Not changed:** an all-zero file with a top-level conditional is no false proof: the proof needs every statement at 0, and the `if` itself runs on load. File-less score items are one group each in `scoreGroups` (a contract change and a vulnerable dependency are two parts, both in Must check); a test covers it.

## 2026-11-03 — Comments-only changes are not risk

- **Problem:** on PR #8, two TypeScript files whose only change was a doc comment (`src/cli/workspace.ts`, `src/routes/files.ts`) were `existing-file-modified`, reached by 4 commands, and added to the merge risk (82 instead of 69). TypeScript backends use the file graph, so any change to a file counted; and even Go/Python comments-only files kept the 0.02 weight of an additive change.
- **Choice:** `isCommentsOnlyChange` (classify/additive.ts) prints the base and head of a modified JS/TS source, resolvers, routes or barrel file with the TypeScript printer (`removeComments`), which also normalizes layout; JSX text stays text, so `<p>a // b</p>` is code. Equal output, and the same code-relevant comments (any comment with a JSX pragma, `#__PURE__`/`#__NO_SIDE_EFFECTS__`, a `webpack…` hint or `@vite-ignore`, compared whole and with the index of the code token it precedes, so moving a marker to another call counts), means comments or formatting only: `declarations-additive` ("only comments or formatting changed"), no reach, no declaration impact. A file that does not parse is never comments-only. Go/Python declaration impacts with nothing added or changed get the same mark. Output files carry `commentsOnly: true`, and `scoreItems` gives them no weight.
- **Reason:** user request. A comment cannot change what runs; adding wrapping parentheses can (it is a different syntax tree), so it is not counted as formatting.

