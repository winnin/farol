# farol reference

Every command, option and configuration key. The [README](../README.md) has the recipes and explains how to read a
review; [how-it-works.md](how-it-works.md) explains how farol reads each language and computes the score.

- [Installation and requirements](#installation-and-requirements)
- [Commands](#commands)
- [Every parameter in a file: `.farol.json`](#every-parameter-in-a-file-faroljson)
- [Configuration: `farol.config.json`](#configuration-farolconfigjson)
- [Reports from your tests, linters and audits](#reports-from-your-tests-linters-and-audits)
- [Traffic and errors from Datadog](#traffic-and-errors-from-datadog)
- [Suggested reviewers](#suggested-reviewers)
- [Contract changes](#contract-changes)
- [GitHub Action](#github-action)
- [Verdict, score and class](#verdict-score-and-class)
- [Calibrating the score on your history](#calibrating-the-score-on-your-history)

## Installation and requirements

farol is published on npm as [`@winninjs/farol`](https://www.npmjs.com/package/@winninjs/farol), with no runtime
dependencies: one bundled file plus the Go and Python helpers.

```sh
npx @winninjs/farol --help              # no install needed
npm install --global @winninjs/farol    # or a plain `farol` command
```

The commands below write `farol`; with npx, run `npx @winninjs/farol <command>`.

The same bundle, `dist/cli.js`, is committed to the repository (the GitHub Action runs it): `git clone
https://github.com/winnin/farol.git && node farol/dist/cli.js --help` works too.

- **All projects:** Node.js 22 or later, git, and the full history of the branches you compare. In CI, use `fetch-depth: 0`.
- **TypeScript:** the project's `node_modules` only matter for packages its `tsconfig` extends and for workspace packages. farol installs nothing.
- **Go:** `go` on the `PATH`, and the module's dependencies in the module cache (`go mod download`). farol builds a small helper (standard library only) on first use and reads modules **offline**: nothing is downloaded during the analysis.
- **Python:** `python3` 3.11 or later. farol's helper uses only the standard library and only **parses** your code; it never imports it.

## Commands

| Command | What it does |
|---|---|
| `analyze --base <ref> --head <ref>` | Runs the analysis between the merge-base of the two refs and the head. Writes the JSON result. Options:<br>• `--coverage`, `--eslint`, `--audit <file>`: [reports](#reports-from-your-tests-linters-and-audits).<br>• `--usage <file>`: [traffic and errors](#traffic-and-errors-from-datadog) of the affected pages/operations.<br>• `--pr <n>`: links point to the PR diff (detected in GitHub Actions).<br>• `--ignore <glob…>`: leave files out of everything.<br>• `--coverage-ignore <glob…>`: leave files out of diff coverage only.<br>• `--since <sha>`: incremental review, only the changes since that commit (after a force-push, its merge-base with the head).<br>• `--reviewers`: recent committers and CODEOWNERS of the changed files (the `reviewers` command is finer).<br>• `--cache-dir` / `--no-cache`: Go/Python helper cache. |
| `html --in farol.json [--out file]` | Single-file HTML report: a review workbench (live merge risk, what to check by hand, files by risk with their diff and coverage, what the change can affect, results to paste in the PR) with the full analysis in *Details*. Works offline; the route graphs in Details load Mermaid from a CDN. `--reviewers <file>` adds suggested reviewers. |
| `report --in farol.json` | The PR comment as Markdown. `--report-url <https://…>` adds a link to the HTML report; `--since-in <file>` and `--since-report-url <https://…>` add the commits since the last push, as `comment` does (for a workflow that posts the comment from a job of its own). |
| `comment --in farol.json --pr <n>` | Creates or updates the PR comment. Needs `GITHUB_TOKEN`, and `GITHUB_REPOSITORY` or `--repo`. Keeps the reviewers' feedback ticks. `--new` posts a new comment instead (one per push); `--since-in <json>` and `--since-report-url <url>` add a "since the last push" block from an incremental analysis (`analyze --since`). |
| `routes [--ref <ref>]` | Prints the entry points farol finds: pages, operations, endpoints, RPC methods, tools, jobs, scripts. Use it to check your setup. |
| `impact <file> [--ref <ref>]` | Lists the entry points that reach a file, with the chain of files to each. |
| `reviewers --in farol.json [--out file]` | [Suggested reviewers](#suggested-reviewers) by who wrote the code the PR changes. |
| `usage [--days <n>] [--out file]` | Reads [traffic and errors from Datadog](#traffic-and-errors-from-datadog) into a usage report for `analyze --usage`. Needs `DD_API_KEY` and `DD_APP_KEY`. |
| `history --since <date> [--branch <b>] [--first-parent]` | Analyzes every merge (or first-parent) commit since a date: one JSON per commit plus `summary.json`. |
| `calibrate --history <dir…>` | Compares the score and the verdict of past commits with what followed them. See [Calibrating](#calibrating-the-score-on-your-history). |

Global options: `--cwd <dir>` (project directory, default: the current one), `--config <file>` (default
`farol.config.json`), `--farol-file <file>`, `--verbose`.

Only `comment` (GitHub API) and `usage` (Datadog API) use the network. `analyze` never runs code of the analyzed
repository and never touches the network.

## Every parameter in a file: `.farol.json`

Any option can come from a `.farol.json`, found in the current directory or any parent up to the repository root.
Top-level keys are the global options; there is one object per command, with option names in camelCase. Paths are
relative to the file. Options given on the command line win.

```json
{
  "config": "farol.config.json",
  "analyze": { "base": "origin/main", "head": "HEAD", "out": "farol.json", "coverage": "coverage/coverage-final.json" },
  "html": { "in": "farol.json", "out": "farol.html", "repo": "acme/shop" }
}
```

```sh
farol analyze && farol html     # no flags needed
```

A complete example is in [examples/.farol.json](../examples/.farol.json).

## Configuration: `farol.config.json`

`farol.config.json` lives in the project directory (`--cwd`). Unknown keys are rejected, with a message.

| Key | Default | Meaning |
|---|---|---|
| `language` | `typescript` | `typescript`, `go` or `python`. |
| `surface` | `frontend` | `frontend` (pages) or `backend` (operations, endpoints). Go and Python are always `backend`. |
| `tsconfig` | `tsconfig.json` | TypeScript only. Solution-style configs are followed to the reference that includes the routes file. Packages it extends (`"extends": "tsconfig/nextjs.json"`) must be in `node_modules`. |
| `routes.adapter` | `react-router` | Frontend router: `react-router` (a route table in `routes.file`), `next` (Next.js Pages and App Router), `tanstack-router` (TanStack Router file-based routes) or `expo-router` (Expo Router). |
| `routes.file` | — | `react-router`: the file that builds the route table. |
| `routes.dir` | `next`: the project, or its `src/`; `tanstack-router`: `src/routes`; `expo-router`: the project's `src/app/`, else `app/` | File-system routers: `next` → the directory holding `pages/` and `app/`; `tanstack-router` → the routes directory; `expo-router` → the routes directory (a directory named `app` or holding a root `_layout`), or the project holding `src/app/` or `app/` (`src/app/` first, as Expo CLI). |
| `routes.extraFiles` | `[]` | `react-router`: modules that **only** define routes (split route trees). |
| `backend.graphql` / `backend.rest` / `backend.cli` | `true` | TypeScript backends: read GraphQL schemas and resolvers / REST registrations / command-line commands (commander and cac `.command('name')…action(handler)`, yargs `.command('name', 'description', builder, handler)`), each command an entry point `CLI name`. |
| `backend.context` | `{}` | TypeScript backends: values injected at runtime, as context property → provider files. For example, `"loaders"` makes `loaders.Brand.byId()` use the provider whose name matches `Brand`. |
| `python.roots` | `["src", "."]` | Python import roots (`src` for a src layout). |
| `exclude` | `[]` (Go: generated mocks) | Files left out of the analysis, still listed. |
| `ignore` | `[]` | Changed files left out of **everything**: classification, dependencies, signals. |
| `roles.global` | TS: app entry, configs, `package.json`… | Files whose change affects everything (class `global`). Globs may point above the project in a monorepo (`../../pnpm-lock.yaml`). |
| `roles.test` / `roles.story` | per language | Tests and stories: reported, never treated as code. |
| `roles.barrel` / `roles.i18n` | `**/index.ts` / `src/locales/**/*.json` | TypeScript re-export files and translation JSON: additive when they only add exports or keys. |
| `roles.infra` | env, Docker, compose, CI, helm, k8s, terraform… | Environment, infrastructure and CI files, matched on repo-relative paths. Source code files never match. |
| `signals.coverage` / `signals.eslint` / `signals.audit` | — | Default report paths, relative to the project. Flags override them. |
| `signals.usage` | — | Default usage report path (written by `farol usage`). |
| `signals.coverageIgnore` | `[]` | Changed files left out of diff coverage only (constants, types…). |
| `datadog` | — | Where `farol usage` reads traffic: see [Datadog](#traffic-and-errors-from-datadog). |

Each `roles` key left out takes the default of the project's language, key by key. A complete frontend example is in
[examples/farol.config.json](../examples/farol.config.json); [examples/README.md](../examples/README.md) lists the defaults
per language.

In a monorepo, point `--cwd` (or `cwd` in `.farol.json`) at the app: paths in the output stay relative to the
repository root, and changes in other apps the project does not use are listed as outside the project.

## Reports from your tests, linters and audits

farol never runs your tests or tools; it reads the reports your CI already produces. Each report is optional. A
missing one shows as **"not verified"** and never as passing; without coverage, the score counts every change as
untested.

| | Coverage (`--coverage`) | Lint and security (`--eslint`) | Vulnerabilities (`--audit`) |
|---|---|---|---|
| TypeScript | Istanbul `coverage-final.json` (Vitest, Jest) | `eslint -f json` | `npm audit --json`, `pnpm audit --json` |
| Go | `go test -coverprofile` | golangci-lint JSON (gosec for security) | `govulncheck -json` |
| Python | coverage.py JSON (`pytest --cov`) | ruff JSON (`S` rules = flake8-bandit) | `pip-audit --format json` |

The `--eslint` flag takes whichever lint report fits the language: farol recognizes each format by its content.
TypeScript also gets built-in security rules (XSS sinks, `eval`, hard-coded secrets, `javascript:` URLs…) without
any report.

Configure Vitest coverage with `include: ['src/**/*.{ts,tsx}']`, so files no test imports are reported too.
Otherwise a new untested file shows as *missing from the report*.

## Traffic and errors from Datadog

farol can show how much traffic each affected page or operation gets, and which errors it already has. It is
**information only**: the class, the score and the verdict do not change.

- **Frontends:** page views from Datadog RUM, grouped by `@view.url_path_group` (`/org/?/brands`).
- **Backends:** requests per resource from the APM metric `trace.<operation>.hits` (`GET /brands/{id}`).
- **Errors** (`errors`, on by default): **distinct** errors (Error Tracking issues) per page, from RUM errors, and per operation, from APM error spans; and the Error Tracking issues of the RUM application or the service. Each issue is attributed to the changed file of its top stack frame, so the report lists the changed files that already throw errors in production.
- **Callers** (backends): the services that call each changed endpoint, from client spans with `peer.service`.

```json
{
  "datadog": {
    "site": "datadoghq.com",
    "days": 14,
    "env": "prod",
    "rum": { "applicationId": "<RUM application id>" },
    "apm": { "service": "orders-api", "operations": ["fastapi.request"] }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `site` | `datadoghq.com` | Your Datadog site: `datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`, `ap2.datadoghq.com` or `ddog-gov.com`. |
| `days` | `14` | Days of traffic, up to now (1–90). |
| `env` | — | Only traffic of this `env` tag. |
| `errors` | `true` | Also read distinct errors per page/operation and Error Tracking issues per file. |
| `rum.applicationId` | — | Frontends: the RUM application. `rum.facet` changes the grouping (default `@view.url_path_group`). |
| `apm.service`, `apm.operations` | — | Backends: the service (or a list, for a repository with several apps) and its server span names, e.g. `http.request` (Go net/http, chi), `gin.request`, `echo.request`, `grpc.server`, `fastapi.request`, `flask.request`, `django.request`, `express.request`, `fastify.request`, and `graphql.resolve` for GraphQL root fields. Check the `trace.*.hits` metrics of your service. |

```sh
DD_API_KEY=… DD_APP_KEY=… farol usage --out usage.json
farol analyze --base main --head HEAD --usage usage.json --out farol.json
```

The application key needs `rum_apps_read`, `timeseries_query`, `apm_read` and `error_tracking_read`. You can also
write `usage.json` yourself from another source: `{"farolUsage": 1, "source": "…", "from": "<ISO date>", "to": "<ISO
date>", "pages": [{"name": "/org/?/reports", "count": 120}], "operations": [{"name": "GET /brands/{id}", "count": 80}]}`.

The report then shows the share of the traffic that goes to the affected pages or operations, the traffic and the
distinct errors of each, busiest first, and the changed files with Error Tracking issues. Error messages are not
copied into the report, only error types. Distinct error counts link to the Datadog explorer (APM traces or RUM
sessions) filtered by those errors' issue ids, in the analyzed period.

**Files.** Error Tracking reports the file of the top stack frame, as the runtime saw it: `../../apps/web/src/x.jsx`
(after source maps), `/app/dist/modules/a/b.service.js` (compiled), `/app/src/shop/store.py`. A changed file matches
when it shares the longest path suffix, comparing file names without extensions (`b.service.js` is `b.service.ts`).
It needs at least three segments, or two that are the whole of either path; ties match nothing. Frames in
dependencies (`node_modules`, `site-packages`, `.venv`, the Go root) and bundles (`dist/main.js`) match nothing. The
API returns at most the 100 issues with the most errors per source.

**Matching.** Route parameters (`:id`, `{id}`, `<int:id>`) match any value and RUM's `?`. Datadog's tag
normalization (`get_/brands/_id_`) is applied to both sides. A row goes to the most specific route
(`/brands/new` before `/brands/:id`), split evenly when several tie. Health checks and metrics scrapes (`/healthz`,
`/health/readiness`, `/ping`, `/metrics`…) are left out. With several APM services, each service's rows go to the
entry points labeled with it. Shares are computed over the traffic that matched some page or operation, so rows of
unknown pages and nested GraphQL fields do not dilute them. GraphQL operations match `graphql.resolve` resources
(`getcatalog:cataloginterface` is `Query.getCatalog`). Tracers often record resolver spans only for part of the
traffic, so GraphQL numbers are better read as relative.

**In CI**, run `farol usage` in a job of its own that has the Datadog keys and runs no code of the PR (farol only
reads `farol.config.json`), and cache its output for the day. The [example workflows](../examples/) do this in the
`farol-usage` job.

## Suggested reviewers

`farol reviewers --in farol.json --out reviewers.json` reads an analysis and asks git who wrote the code it changes:

- **Changed files:** `git blame` at the merge-base (whitespace ignored, `.mailmap` applied). A person's share of a file is half their share of the whole file and half their share of the changed lines and their context. **New files** use the lines each person added to the same directory in the past 12 months.
- **Weight:** each file counts by its risk points, so the people who wrote the riskiest code come first. At most the 40 riskiest code files are blamed.
- **Left out:** the PR's own authors and bots. People with no commit in the last 6 months rank lower and are labeled *inactive*.
- **Code owners** (CODEOWNERS of the head) are listed apart.
- **One person, several git identities** (laptop, GitHub web, login as name) are merged: the same e-mail, a GitHub noreply login, or names where one holds every word of the other (two at least) or that differ only by spaces. For anything else, add a `.mailmap` to the repository: git applies it first.

Then `html`, `report` and `comment` take `--reviewers reviewers.json`. It reads only git, and works on any analysis
JSON of the same commit.

## Contract changes

For backends, farol compares what each endpoint **receives and returns** between the base and the head:

| Stack | What is read | How |
|---|---|---|
| GraphQL | The whole schema | graphql-js `findBreakingChanges` / `findDangerousChanges`; each change goes to the operations that return or take the changed type |
| FastAPI | Path, query, header and form parameters, the body, `response_model` or the return annotation, and the Pydantic models and enums they use | Python `ast` (nothing is imported) |
| Go (net/http, chi, gin, echo) | Types the handler decodes (`json.Decode`, `Bind…`) and encodes (`Encode`, `c.JSON`, `render.JSON`), also through project helpers like `writeJSON(w, v)`; query and path parameters read by name | `go/types`; struct fields by `json` tag, `omitempty`, `binding:"required"` |
| gRPC | Request and response messages of each method | `go/types` on the generated structs |

Each change is **breaking** (clients built for the base can fail: removed endpoint or response field, changed type,
new required field or parameter, enum value removed from a request), **dangerous** (they may misbehave: enum value
added to a response, a part farol can no longer read) or **safe** (compatible additions). Breaking changes make the
review careful and add to the score; dangerous ones make it at least quick. Endpoints whose contract farol cannot read
(untyped handlers, `any` values) are not compared, never reported as safe.

## GitHub Action

`winnin/farol/action` is a composite action that runs one farol command per step.

| Input | For | Meaning |
|---|---|---|
| `command` | all | `analyze`, `html`, `comment`, `usage` or `reviewers`. |
| `base`, `head` | analyze | Refs or SHAs to compare. |
| `coverage`, `eslint`, `audit`, `usage` | analyze | Report files; empty means not given. |
| `since` | analyze | Incremental analysis since that commit. |
| `reviewers` | analyze | `true` for the simple reviewer suggestion. |
| `out` | analyze, usage | Output JSON. |
| `days` | usage | Days of Datadog data. |
| `in` | html, comment, reviewers | The analysis JSON. |
| `html-out` | html | Output HTML. |
| `reviewers-file` | reviewers (output), html, comment (input) | Suggested reviewers file. |
| `pr`, `repo`, `report-url` | comment | The PR, the repository and a link to the HTML report. |
| `new-comment`, `since-in`, `since-report-url` | comment | One comment per push, with the report of the commits since the previous push. |
| `config`, `cwd`, `verbose` | all | Global options. |

## Verdict, score and class

| Verdict | When |
|---|---|
| ✓ **Fast track** | Only new code, tests or low-risk changes; nothing existing is widely affected. |
| ◐ **Quick review** | Existing code changed in a contained way; a global or infrastructure file changed; low diff coverage; lint errors, suppressions or trimmed tests; a dangerous contract change; or a score of 25 or more. |
| ⚠ **Careful review** | The change could not be fully read (class `unknown`); a score of 60 or more; high-severity security findings; serious vulnerabilities in changed dependencies; a breaking contract change; or a central file whose changed lines are mostly untested. |

The **merge risk score** is the chance that at least one risky item breaks something, if they were independent:
`100 × (1 − Π(1 − w))`.

- **Changed code files** count by their reach (existing entry points that run them, centrality), times what their diff coverage leaves: 100% covered keeps 30% of the risk, untested keeps all of it. New files that only declare (types, constants) count 1 point each, 5 at most together.
- **Other items** add to it: security findings, lint errors, suppressions, removed tests, breaking or dangerous contract changes, critical dependency changes, vulnerable dependencies, and global or unknown reasons. Environment, infrastructure and CI files add at most 12 points together.
- **Marking a file as reviewed**, or every entry point that uses it as behind a feature flag, takes its part out.

| Class | Meaning |
|---|---|
| `isolated` | The PR only adds: new entry points, new files or declarations, new exports or keys, tests. |
| `touches-existing` | Existing code changed. The report lists every existing entry point that runs it, with the chain. |
| `global` | A global file, a manifest or a critical dependency changed: everything may be affected. |
| `unknown` | farol could not read part of the change safely: a syntax error, a dynamic route, an unresolved import. Never read it as safe. |

Every weight is in [how-it-works.md](how-it-works.md); every reason code in [reasons.md](reasons.md).

## Calibrating the score on your history

```sh
farol history --branch origin/main --since "180 days ago" --first-parent --out history/
farol calibrate --history history/ --out calibration.json
```

`calibrate` marks each past commit as *followed by a problem* when a later commit reverted it, or when within 14 days
(`--window`) a fix changed one of the same code files. It then reports the problem rate per verdict and per score
range, the AUC of the score (0.5 means no signal, 1 a perfect ranking) and the thresholds the data supports.

On 662 commits of four repositories (TypeScript frontend and backend, Go, Python): *fast track* had **0 problems in
56 commits**, the score's AUC was **0.72–0.83** in every repository, and *careful* had 1.6 to 4 times the problem rate
of *quick*. History runs have no coverage or lint reports.
