# Setting up farol, stack by stack

This folder has everything to put farol on a repository. Each section below is a complete setup for one stack: the
configuration to commit, the reports to produce, the workflow to copy and what to check. The last sections list every
parameter.

| File | What it is |
|---|---|
| [`farol.config.json`](farol.config.json) | A full configuration for a React Router frontend: routes, roles, signals. |
| [`.farol.json`](.farol.json) | Default values for every CLI parameter, so `farol analyze && farol html` needs no flags. |
| [`workflow.yml`](workflow.yml) | GitHub Actions for TypeScript projects (React Router, Next.js, TanStack Router, Expo Router, GraphQL/REST APIs). |
| [`workflow-go.yml`](workflow-go.yml) | GitHub Actions for Go services. |
| [`workflow-python.yml`](workflow-python.yml) | GitHub Actions for Python services. |

- [How a setup works](#how-a-setup-works)
- Stacks: [React Router](#react-router) · [Next.js](#nextjs) · [TanStack Router](#tanstack-router) · [Expo Router](#expo-router) · [TypeScript API (GraphQL, REST)](#typescript-api-graphql-rest) · [Go](#go) · [Python](#python) · [Monorepos](#monorepos)
- [GitHub Actions](#github-actions)
- [Datadog traffic and errors](#datadog-traffic-and-errors)
- [Every configuration key](#every-configuration-key)
- [Every CLI parameter and `.farol.json`](#every-cli-parameter-and-faroljson)
- [Every action input](#every-action-input)
- [Checking a setup](#checking-a-setup)

## How a setup works

1. **`farol.config.json`** in the project directory describes the project: its language, where its entry points are
   (routes, operations), which files are global, tests, generated code.
2. **Reports** from your own tools (coverage, lint, vulnerability audit) are optional inputs. farol never runs your
   tests or tools; it reads their output. A missing report shows as *not verified*, never as passing.
3. **`farol analyze`** compares the merge-base of the base and the head, writes a JSON result; **`farol html`** turns
   it into a single-file report; **`farol comment`** posts it on the pull request.

```sh
farol analyze --base origin/main --head HEAD \
  --coverage <coverage report> --eslint <lint report> --audit <audit report> --out farol.json
farol html --in farol.json --out farol.html
```

Run farol with `npx @winninjs/farol <command>` (no install), or install it once with `npm install --global
@winninjs/farol`; the commands in this guide write `farol` for short.

Requirements: Node.js 22+ and git with the full history of both branches (`fetch-depth: 0` in CI). Go projects also
need `go` and their modules downloaded (`go mod download`); Python projects need `python3` 3.11+.

---

## React Router

Route tables built with `createBrowserRouter`, `createHashRouter`, `createMemoryRouter`, `createStaticRouter`,
`useRoutes`, an exported route array, `<Routes>`/`<Route>` JSX or `createRoutesFromElements`. Lazy routes,
`React.lazy`, constants and route arrays imported from other modules are followed.

**Configuration** (only `routes.file` is required):

```json
{
  "tsconfig": "tsconfig.json",
  "routes": { "file": "src/routes.tsx" },
  "exclude": ["**/*.stories.tsx", "src/mocks/**"],
  "roles": {
    "global": ["src/main.tsx", "src/App.tsx", "src/styles/global.css", "package.json", "package-lock.json", "tsconfig*.json", "vite.config.ts"]
  },
  "signals": {
    "coverage": "coverage/coverage-final.json",
    "eslint": "reports/eslint.json"
  }
}
```

- **Route tree split across modules** (a routes file that spreads arrays from `routes.config.ts`, paths from a
  constants module): it is read automatically. If those modules only define routes, list them in
  `routes.extraFiles` so that adding a route there counts as additive:
  `"routes": { "file": "src/routes.tsx", "extraFiles": ["src/routes/*.config.ts"] }`.
- **`roles.global`**: files whose change affects every page (app entry, global styles, build config). Their change
  makes the PR `global`.
- **`roles.barrel`** (default `**/index.ts`): re-export files; adding exports is additive. If some `index.ts` files hold
  real code (hooks, components), narrow it, e.g. `["src/**/barrel/index.ts"]`.
- **`roles.i18n`** (default `src/locales/**/*.json`): translation JSON; adding keys is additive.

**Reports:**

```sh
npx vitest run --coverage.enabled --coverage.reportOnFailure --coverage.reporter=json --coverage.reportsDirectory=reports/coverage
npx eslint -f json -o reports/eslint.json <changed files>
npm audit --json > reports/audit.json            # or: pnpm audit --json
```

Set `coverage.include: ['src/**/*.{ts,tsx}']` in the Vitest (or Jest `collectCoverageFrom`) configuration: files no
test loads then show as untested instead of *missing from the report*.

**CI:** [`workflow.yml`](workflow.yml).

## Next.js

Pages Router and App Router, read from the file names (no routes file).

```json
{
  "routes": { "adapter": "next" },
  "roles": { "global": ["next.config.*", "package.json", "src/app/layout.tsx"] }
}
```

- **`routes.dir`**: the directory that holds `pages/` and `app/`. By default the project, or its `src/` when only `src/`
  has them.
- **Pages Router:** every module under `pages/` is a page; `index` is its folder's path; `[id]` reads as `:id`,
  `[...slug]` and `[[...slug]]` as `*`. `_app` and `_document` render every page; `pages/api/**` are API routes.
- **App Router:** every `page` is a page and every `route` an API route. `layout` and `template` of the folders above a
  page are its layouts; `loading`, `error` and `not-found` are part of it. Route groups `(group)` and slots `@slot`
  are left out of the URL; private folders `_x` and intercepting routes `(.)x` are not routes.
- **Middleware** (`middleware.ts` or `proxy.ts` next to `pages/`/`app/`) runs before every route: a change there
  affects all of them.
- **tsconfig that extends a package** (`"extends": "tsconfig/nextjs.json"` in a monorepo): install dependencies before
  analyzing so the package is in `node_modules`.

**Reports and CI:** as for [React Router](#react-router) (Jest or Vitest coverage, ESLint, audit), with
[`workflow.yml`](workflow.yml).

## TanStack Router

File-based routing: the modules that call `createFileRoute('<id>')` (or `createLazyFileRoute`) under the routes
directory.

```json
{ "routes": { "adapter": "tanstack-router", "dir": "src/routes" } }
```

- **`routes.dir`** (default `src/routes`): the routes directory (`routesDirectory` of the router plugin).
- The route id is read from the `createFileRoute` call, so flat (`posts.$id.tsx`) and nested (`posts/$id.tsx`) file
  names work the same. A non-literal id is a dynamic route: the PR is `unknown`.
- The root route (`__root.tsx`), pathless layouts (`_app.tsx`) and parent routes are layouts of the routes under them:
  a change there affects those routes, and they are not listed as pages themselves.
- Files and folders starting with `-` are ignored, as the router does.
- Code-based route trees (`createRoute` with `getParentRoute`) are not read.

**Reports and CI:** as for [React Router](#react-router), with [`workflow.yml`](workflow.yml).

## Expo Router

File-based routing for Expo and React Native apps, read from the file names (no routes file).

```json
{
  "routes": { "adapter": "expo-router" },
  "roles": { "global": ["app.json", "app.config.*", "package.json"] }
}
```

- **`routes.dir`**: the routes directory. By default `app/` in the project, or `src/app/` when only that exists.
- Every module is a screen; `index` is its folder's path; `[id]` reads as `:id`, `[...rest]` as `*`. Groups `(tabs)`
  and `(a,b)` are left out of the URL.
- The `_layout` of every folder above a screen is its layout: a change there affects every screen under it.
- `name+api.ts` modules are API routes; `+not-found` is a screen. `+native-intent` and `+html` at the root are layouts
  of every screen, `+middleware` of every screen and API route.
- Platform modules (`about.ios.tsx`, `about.web.tsx`) belong to the route of `about.tsx`.

**Reports and CI:** as for [React Router](#react-router), with [`workflow.yml`](workflow.yml).

## TypeScript API (GraphQL, REST)

```json
{
  "surface": "backend",
  "backend": { "graphql": true, "rest": true },
  "roles": {
    "test": ["**/*.test.ts", "**/*.spec.ts"],
    "global": ["package.json", "src/app.ts", "src/server.ts"]
  }
}
```

- **GraphQL:** every `.graphql`/`.gql` file and `gql`/`graphql` template is parsed with the official parser; the root
  fields (`Query.*`, `Mutation.*`, `Subscription.*`) are the operations. Resolver maps are matched against the schema.
  Breaking and dangerous schema changes are reported per operation.
- **REST:** Fastify/Express-style registrations (`app.get('/path', handler)`, `router.route('/path').post(h)`,
  `fastify.route({ method, url, handler })`). Prefixes from `register`/`use` are not applied.
- **`backend.context`**: values injected at runtime that the import graph cannot see, as context property → provider
  files. With `"context": { "loaders": ["src/modules/*/loaders/index.ts"] }`, a resolver reading
  `ctx.loaders.Brand.byId()` uses the provider whose directory or name matches `Brand`.
- Set `"graphql": false` or `"rest": false` to skip one of them.

**Reports and CI:** as for [React Router](#react-router) (Jest or Vitest coverage, ESLint, audit), with
[`workflow.yml`](workflow.yml).

## Go

chi, gin, echo and net/http routes (Go 1.22 `"GET /path"` patterns too), gRPC services (`Register<X>Server`) and
`main` binaries.

```json
{ "language": "go", "surface": "backend" }
```

- farol reads Go modules **offline**: run `go mod download` for the base and the head first (the workflow does).
- Generated mocks are excluded by default (`**/mock/**`, `**/mocks/**`, `**/*_mock.go`, `**/mock_*.go`); setting
  `exclude` replaces that list.
- A route path that is not a constant keeps its route, named after the expression (`POST {path + "*"}`). Routers wrapped
  in a project type with its own registration API are not read.
- `main` packages that register no route are entry points named `RUN <dir>`.

**Reports:**

```sh
go test -coverpkg=./... -coverprofile=reports/cover.out ./...
golangci-lint run --output.json.path=reports/golangci.json --issues-exit-code=0 ./...   # enable gosec for security
govulncheck -json ./... > reports/govulncheck.json
```

**CI:** [`workflow-go.yml`](workflow-go.yml).

## Python

FastAPI and Flask (apps, routers and blueprints with prefixes), Django URLs, MCP tools/resources/prompts, Celery tasks,
Temporal workflows and activities, Prefect flows and `if __name__ == "__main__"` scripts. farol parses the code with
Python's own `ast`; it never imports it.

```json
{ "language": "python", "surface": "backend", "python": { "roots": ["src", "."] } }
```

- **`python.roots`** (default `["src", "."]`): import roots. `src` for a src layout (`from shop.api import x` is
  `src/shop/api.py`); `["."]` when packages sit at the project root (`app/main.py`).
- **Prefixes:** `include_router(router, prefix=settings.API_V1_STR)` reads the default declared on the settings
  class (`API_V1_STR: str = "/api/v1"`); other non-literal prefixes keep their routes, named after the expression.
- **Contracts (FastAPI):** path, query, header and form parameters, the body, `response_model` or the return
  annotation, and the Pydantic models and enums they use. Dependencies (`Depends`, also through an alias such as
  `CurrentUser = Annotated[User, Depends(get_current_user)]`) are not part of the request.
- Tests are recognized by default (`tests/**`, `**/test_*.py`, `**/*_test.py`, `conftest.py`).

**Reports:**

```sh
pytest --cov=src --cov-report=json:reports/coverage.json
ruff check --output-format json --extend-select S --extend-ignore S101 --exit-zero . > reports/ruff.json   # S = security
pip-audit --format json -o reports/pip-audit.json
```

With uv: `uv export --format requirements-txt --no-hashes > req.txt && uvx pip-audit -r req.txt --no-deps --disable-pip --format json -o reports/pip-audit.json`.

**CI:** [`workflow-python.yml`](workflow-python.yml) (uses `uv`; swap in your installer).

## Monorepos

Put `farol.config.json` in the app's directory and point farol at it with `--cwd` (or `cwd` in `.farol.json`, or the
`cwd` action input). One analysis per app: a repository with `backend/` and `frontend/` runs farol twice.

```sh
farol --cwd apps/web analyze --base origin/main --head HEAD --out web.json
farol --cwd services/api analyze --base origin/main --head HEAD --out api.json
```

- Paths in the output stay relative to the repository root.
- Changes in other apps that the project does not import are listed as *outside the project*.
- Global globs may point above the project: `"global": ["../../pnpm-lock.yaml"]`.
- Manifests and lockfiles above the project count only when they belong to its language (a root `bun.lock` is no
  dependency of a Python backend).

---

## GitHub Actions

The three workflows share one shape:

| Job | Runs | Permissions |
|---|---|---|
| `tests` | your tests, linter and audit; keeps the reports as an artifact. It runs the PR's code. | `contents: read`, no secrets |
| `farol-usage` | optional: reads Datadog once a day (cached). It never runs the PR's code. | `contents: read`, the Datadog secrets |
| `farol` | after the others, pass or fail: `analyze`, `reviewers`, `html`, uploads the reports and comments. It never runs the PR's code. | `contents: read`, `pull-requests: write` |

What a run does:

- Runs on pull requests that are ready for review (`opened`, `synchronize`, `reopened`, `ready_for_review`); drafts are
  skipped.
- Posts a **new comment on every push** with a link that opens the HTML report in the browser (`upload-artifact@v7`
  with `archive: false`). After a push it adds a second report with only the commits since the previous push
  (`github.event.before`).
- Fork pull requests get a read-only token: no comment there; the reports stay in the run's artifacts.
- Every farol step is `continue-on-error`: farol never fails CI or blocks a merge.
- Go and Python cache helper outputs in `~/.cache/farol` by the base commit: later pushes read only the head.

**To adopt one:**

1. Copy the workflow for your language to `.github/workflows/farol.yml`.
2. If you already have a test job, keep it: add its "Keep the reports for farol" upload step and set `needs:` of the
   `farol` job to it.
3. Commit `farol.config.json`.
4. Optional, Datadog: set the secrets `DD_API_KEY` and `DD_APP_KEY` and the repository variable `FAROL_DATADOG=true`.
5. Pin the action to a commit once it works: `winnin/farol/action@<sha> # main as of <date>`.

## Datadog traffic and errors

Optional and information only: it never changes the class, the score or the verdict.

```json
{
  "datadog": {
    "site": "datadoghq.com",
    "days": 14,
    "env": "prod",
    "errors": true,
    "rum": { "applicationId": "<RUM application id>", "facet": "@view.url_path_group" },
    "apm": { "service": "orders-api", "operations": ["fastapi.request"] }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `site` | `datadoghq.com` | `datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`, `ap2.datadoghq.com` or `ddog-gov.com`. |
| `days` | `14` | Days of data up to now (1–90). |
| `env` | — | Only data with this `env` tag. |
| `errors` | `true` | Also read distinct errors per page/operation and Error Tracking issues per changed file. |
| `rum.applicationId` | — | Frontends: the RUM application. |
| `rum.facet` | `@view.url_path_group` | The RUM facet that groups page views. |
| `apm.service` | — | Backends: the service, or a list for a repository with several services. |
| `apm.operations` | — | Server span names, e.g. `http.request` (net/http, chi), `gin.request`, `echo.request`, `grpc.server`, `fastapi.request`, `flask.request`, `django.request`, `express.request`, `fastify.request`, `graphql.resolve`. |

`rum` or `apm` is required. The application key needs `rum_apps_read`, `timeseries_query`, `apm_read` and
`error_tracking_read`. Run `DD_API_KEY=… DD_APP_KEY=… farol usage --out usage.json`, then
`farol analyze … --usage usage.json`.

---

## Every configuration key

`farol.config.json`, in the project directory. Unknown keys are rejected with a message. Globs are relative to the
project unless noted.

| Key | Default | Meaning |
|---|---|---|
| `language` | `typescript` | `typescript`, `go` or `python`. |
| `surface` | `frontend` | `frontend` (pages) or `backend` (operations, endpoints). Go and Python must be `backend`. |
| `tsconfig` | `tsconfig.json` | TypeScript: the project's tsconfig. Solution-style configs are followed to the reference that includes the routes. |
| `routes.adapter` | `react-router` | Frontends: `react-router`, `next`, `tanstack-router` or `expo-router`. |
| `routes.file` | — | `react-router` (required): the file that builds the route table. Rejected for the other adapters. |
| `routes.dir` | `next`: the project or its `src/`; `tanstack-router`: `src/routes`; `expo-router`: `app/` or `src/app/` | File-system routers: where the routes live. |
| `routes.extraFiles` | `[]` | `react-router`: modules that only define routes; they get the routes rule. |
| `backend.graphql` | `true` | TypeScript backends: read GraphQL schemas and resolvers. |
| `backend.rest` | `true` | TypeScript backends: read REST registrations. |
| `backend.context` | `{}` | TypeScript backends: injected context property → provider file globs. |
| `python.roots` | `["src", "."]` | Python import roots. |
| `exclude` | `[]` (Go: generated mocks) | Files left out of the analysis (still listed). Globals and routes files are never excluded. |
| `ignore` | `[]` | Changed files left out of everything: classification, dependencies, signals (project- or repo-relative). |
| `roles.global` | TS: `src/App.tsx`, `src/main.tsx`, `package.json`, `package-lock.json`, `tsconfig*.json`, `eslint.config.*`, `vite.config.ts`; Go, Python: none | A change affects everything: the PR is `global`. May point above the project. |
| `roles.test` | TS: `**/*.test.ts(x)`; Go: `**/*_test.go`; Python: `tests/**`, `**/test_*.py`, `**/*_test.py`, `**/conftest.py`… | Tests: reported, never treated as code. |
| `roles.story` | TS: `**/*.stories.tsx` | Stories: reported, never treated as code. |
| `roles.barrel` | TS: `**/index.ts` | Re-export files: additive when they only add exports. |
| `roles.i18n` | TS: `src/locales/**/*.json` | Translation JSON: additive when they only add keys. |
| `roles.infra` | env files, Dockerfiles, compose, CI, helm, k8s, terraform… | Deploy-time files, matched on repo-relative paths; shown apart, at most 12 points of risk together. |
| `signals.coverage` | — | Default coverage report path. |
| `signals.eslint` | — | Default lint report path (ESLint, golangci-lint or ruff JSON). |
| `signals.audit` | — | Default vulnerability report path (npm/pnpm audit, govulncheck, pip-audit). |
| `signals.usage` | — | Default usage report path (written by `farol usage`). |
| `signals.coverageIgnore` | `[]` | Changed files left out of diff coverage only (constants, types…). |
| `datadog` | — | See [Datadog](#datadog-traffic-and-errors). |

Setting a `roles` key replaces its default list; every key you leave out keeps the default of the project's language
(setting `roles.global` in a Python project keeps the Python test globs). Report paths in the configuration are relative to the project; flags
on the command line are relative to the current directory and win.

## Every CLI parameter and `.farol.json`

Global options: `--cwd <dir>` (project directory), `--config <file>` (default `farol.config.json`, relative to
`--cwd`), `--farol-file <file>`, `--verbose`.

| Command | Options |
|---|---|
| `analyze` | `--base <ref>`, `--head <ref>`, `--out <file>`, `--coverage <file>`, `--eslint <file>`, `--audit <file>`, `--usage <file>`, `--pr <n>`, `--ignore <glob…>`, `--coverage-ignore <glob…>`, `--since <ref>`, `--reviewers`, `--cache-dir <dir>`, `--no-cache` |
| `html` | `--in <file>`, `--out <file>`, `--repo <owner/name>`, `--pr <n>`, `--reviewers <file>` |
| `report` | `--in <file>`, `--repo <owner/name>`, `--pr <n>`, `--report-url <url>`, `--reviewers <file>` |
| `comment` | `--in <file>`, `--pr <n>`, `--repo <owner/name>`, `--report-url <url>`, `--reviewers <file>`, `--new`, `--since-in <file>`, `--since-report-url <url>` (needs `GITHUB_TOKEN`) |
| `reviewers` | `--in <file>`, `--out <file>` |
| `usage` | `--out <file>`, `--days <n>` (needs `DD_API_KEY`, `DD_APP_KEY`) |
| `routes` | `--ref <ref>` |
| `impact <file>` | `--ref <ref>` |
| `history` | `--since <date>`, `--branch <name>`, `--out <dir>`, `--ignore <glob…>`, `--first-parent` |
| `calibrate` | `--history <dir…>`, `--window <days>`, `--out <file>` |

**`.farol.json`** holds default values for all of them. It is found in the current directory or any parent up to the
repository root. Top-level keys are the global options; one object per command, with option names in camelCase; paths
are relative to the file; flags given on the command line win.

```json
{
  "cwd": "apps/web",
  "config": "farol.config.json",
  "analyze": {
    "base": "origin/main",
    "head": "HEAD",
    "coverage": "coverage/coverage-final.json",
    "eslint": "reports/eslint.json",
    "out": "farol.json",
    "ignore": ["src/generated/**"]
  },
  "html": { "in": "farol.json", "out": "farol.html", "repo": "acme/shop" },
  "report": { "in": "farol.json" },
  "history": { "since": "90 days ago", "branch": "origin/main", "out": "farol-history", "firstParent": true }
}
```

## Every action input

`uses: winnin/farol/action@<ref>` runs one command per step.

| Input | Used by | Meaning |
|---|---|---|
| `command` | all | `analyze`, `html`, `comment`, `usage` or `reviewers`. |
| `base`, `head` | analyze | Refs or SHAs to compare. |
| `coverage`, `eslint`, `audit`, `usage` | analyze | Report files; empty means not given. |
| `since` | analyze | Incremental analysis since that commit. |
| `reviewers` | analyze | `true` for the simple reviewer suggestion (the `reviewers` command is finer). |
| `out` | analyze, usage | Output JSON. |
| `days` | usage | Days of Datadog data. |
| `in` | html, comment, reviewers | The analysis JSON. |
| `html-out` | html | Output HTML. |
| `reviewers-file` | reviewers (writes it), html and comment (read it) | Suggested reviewers file. |
| `pr`, `repo`, `report-url` | comment | The pull request, the repository and the link to the HTML report. |
| `new-comment` | comment | `true`: a new comment per push instead of updating one. |
| `since-in`, `since-report-url` | comment | The incremental analysis and its report, shown on top of the comment. |
| `config`, `cwd`, `verbose` | all | Global options. |

---

## Checking a setup

```sh
farol routes                       # the entry points farol reads: pages, operations, endpoints, jobs, scripts
farol impact src/components/Card.tsx   # what reaches a file, with the chain to each
farol --verbose analyze --base origin/main --head HEAD --out farol.json
```

| Symptom | What to check |
|---|---|
| A page or endpoint is missing from `farol routes` | The route form is supported (see your stack above); `dynamicRoutes` in the output names the constructs farol could not read. |
| `routes file not found` | `routes.file` (or `routes.dir`) is relative to the project directory (`--cwd`). |
| Every PR is `unknown` | A dynamic route or an unreadable import: the reasons and `diagnostics` of the JSON name the file and line. |
| Coverage, lint or audit *not verified* | The report was not given or the path is wrong (relative to the current directory for flags, to the project for the configuration). |
| A new file shows as *missing from the coverage report* | Make the coverage tool include files no test loads (`coverage.include` in Vitest). |
| Go: `farol reads Go modules offline: run go mod download` | Download the modules of the base and the head before analyzing. |
| `invalid tsconfig … not found` | The tsconfig extends a package that is not installed: install dependencies first. |
