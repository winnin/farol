# How farol works

This document explains, per language, how farol reads a project, what counts as a change to existing code, how it
finds what a change reaches, and how the score and the verdict are computed. For the reasons behind each choice, see
[DECISIONS.md](DECISIONS.md); for every reason code, [reasons.md](reasons.md).

- [Pipeline](#pipeline)
- [TypeScript frontends (React Router)](#typescript-frontends-react-router)
- [File-system routers (Next.js, TanStack Router)](#file-system-routers-nextjs-tanstack-router)
- [TypeScript and JavaScript backends (GraphQL, REST)](#typescript-and-javascript-backends-graphql-rest)
- [Go](#go)
- [Python](#python)
- [Roles](#roles)
- [Dependencies](#dependencies)
- [Signals](#signals)
- [Risk, merge risk score and verdict](#risk-merge-risk-score-and-verdict)
- [The JSON result](#the-json-result)
- [Guarantees](#guarantees)

## Pipeline

1. **Diff:**
   - It diffs the merge-base of base and head (or the `--since` commit) with `git diff -M`.
   - Pairs of removed and added lines that differ only by a trailing comma or whitespace are ignored: adding an item to a list does not modify the previous item.
2. **Roles:** every changed file gets one role ([Roles](#roles)).
3. **Read** the head tree (and, where needed, the base tree) with the language's own parser and type checker. Nothing is executed. The result is the **entry points** (pages, operations, endpoints, RPC methods, tools, jobs, binaries, scripts) and a **graph** of which declaration uses which.
4. **Impact of each changed file:**
   - TypeScript frontends, Go and Python compare declarations by a hash of their tokens (or AST); see each language. TypeScript backends, JavaScript and renamed TypeScript files use the module graph.
   - Additive rules apply to routes files, barrels, i18n files, GraphQL schemas and resolver maps.
5. **Reach:** a reverse breadth-first search from the changed code to the entry points anchored on it, keeping one shortest chain per entry point.
6. **Classification:** first match wins: `global` > `unknown` > `touches-existing` > `isolated`.
7. **Signals:** diff coverage, lint, suppressions, modified tests, security findings and vulnerabilities, from the reports you give and from the diff itself.
8. **Reports:** JSON (the contract), PR comment Markdown, HTML.

## TypeScript frontends (React Router)

**Reading.**

- farol builds a TypeScript program of the head commit from git objects: the project's tsconfig, path aliases, `baseUrl`, and solution-style configs followed to the reference that includes the routes file. `node_modules` on the disk is read only for third-party packages.
- **Workspace packages** come from the commit too. A dependency declared with `workspace:` links `node_modules/<name>` to the folder of the package with that name. When the package exports a build output that is not committed (`./dist/index.mjs`), farol reads the source it is built from (`src/index.ts`), so a change in the package source reaches the pages that import it, whatever is built or installed on the machine.
  - Only the `src/` → `dist/` layout maps. A package import that does not resolve is unresolved, and so is every changed file of that package (`unresolved-import`, `unknown`). The same goes for a `workspace:` dependency no folder provides, and for `preserveSymlinks`.
  - Limits: the package sources are compiled with the project's compiler options; npm and yarn v1 workspaces (plain versions, no `workspace:`) are read through the links on the disk.
- The routes file is parsed with the compiler API.

**Route forms read.**

- **Object routes:** an array of route objects passed to `createBrowserRouter`, `createHashRouter`, `createMemoryRouter`, `createStaticRouter` or `useRoutes`, or exported as a constant.
  - Read: `path`, `index`, `element`, `Component`, `lazy` (function, method or React Router 7 object) and `children`.
  - Tracked as route modules: `errorElement`, `ErrorBoundary` and `HydrateFallback`.
- **JSX routes:** `<Routes>`/`<Route>` and `createRoutesFromElements`.
- **Values from constants,** of the routes file or of imported modules:
  - strings, template literals with constant parts, and properties of constant objects (`ROUTE_SEGMENTS.users`);
  - route arrays, also spread (`...APP_ROUTES`);
  - lazy functions (`lazy: usersPage` with `usersPage = () => import("./Users")`) and `React.lazy(() => import(…))` components.
- **Split route trees:** modules listed in `routes.extraFiles` get the routes rule.
- **Anything else** (`.map`, computed spreads, paths from function calls) is a *dynamic route*: it is listed in diagnostics and makes the PR `unknown`. `farol routes` shows what was read.

A route with children is a **layout**. Routes without children are the **pages** people visit. Reports count pages
and group layouts apart.

**Declaration-level reach.**

- **Declarations:** every top-level declaration of a project module (function, class header and fields, method, variable, enum, module-level code) gets a hash of its tokens, without comments or whitespace.
- **References:** resolved with the type checker, through imports, re-exports, property accesses, shorthand properties and JSX (`<Card />`).
- **Types:** type positions and type declarations create no edges, because types are erased.
- **Anchors:** a route is anchored on the declarations of its modules (entry, wrappers, layouts) and on everything those modules export, through barrels and re-exports.
- **Methods:** a method nothing in the project calls depends on its class (React lifecycle, libraries).
- **Comparing:** for a modified file, the base text is parsed alone, without type checking, to compare hashes.
  - Only declarations whose code changed or that were removed count as existing code.
  - New declarations, comments and formatting are additive (`declarations-additive`).
  - Changed types are listed as "erased at runtime".

**Module-level reach** (renamed files, JavaScript files):

- The import graph has static, side-effect, dynamic (`import("./x")`), `require` and asset edges.
- Named imports through a barrel point at the module that declares the symbol, so changing component A does not reach a page that only imports component B from the same barrel.
- Imports of types create no edges.

**Additive rules.**

- The routes file is additive when every existing route is unchanged and no line was removed.
- A barrel is additive when it only adds `export` declarations.
- An i18n JSON file is additive when it only adds keys.
- A file that only declares types, in both versions, is `type-only-change`.

## File-system routers (Next.js, TanStack Router)

With `routes.adapter` set to `next` or `tanstack-router`, there is no routes file: the routes are the modules of a
directory, read from the git tree of each commit. Everything after the route table (declaration-level reach, the
additive rules, the score) is the same as for React Router.

**Next.js** (`routes.dir`: the directory holding `pages/` and `app/`; by default the project, or its `src/` when only
`src/` has them).

- **Pages Router:** every module under `pages/` (`.tsx`, `.ts`, `.jsx`, `.js`) is a route; `index` is its directory's path. `[id]` reads as `:id`, `[...slug]` and `[[...slug]]` as `*`. `_app` and `_document` render every page (they are the layouts of every route but the API routes under `pages/api/`).
- **App Router:** every `page` module is a route and every `route` module an API route. The `layout` and `template` of every folder above a page are its layouts; the `loading`, `error`, `not-found`, `forbidden` and `unauthorized` boundaries above it are its modules. Route groups `(group)` and parallel-route slots `@slot` are left out of the URL (the folder path stays in the key, so two folders with the same URL stay apart); private folders `_x` and intercepting routes `(.)x` are not routes.
- **Middleware** (`middleware` or `proxy` next to `pages/`/`app/`) runs before every route: it is the first layout of all of them.
- Tests, stories, mocks and declaration files never count as routes.

**TanStack Router** (`routes.dir`, default `src/routes`), file-based routing:

- A module that calls `createFileRoute('<id>')` or `createLazyFileRoute('<id>')` defines the route with that id; `createRootRoute`/`createRootRouteWithContext` defines the root. The id is read from the call with the compiler API, so flat (`posts.$id.tsx`) and nested (`posts/$id.tsx`) file names give the same result. An id that is not a string literal is a *dynamic route* (the PR is `unknown`).
- The lazy module (`.lazy.tsx`) is the route's entry when there is one; both modules belong to the route.
- A route that other routes render inside (`/posts` for `/posts/$id`, the pathless `/_app` for `/_app/settings`, `/posts` for the index `/posts/`) is their **layout**; the others are the **pages**. The root is the first layout of every route.
- URL paths: pathless (`_app`) and group (`(group)`) segments are dropped, `$id` reads as `:id`, `{-$id}` as `:id`, `$` as `*`, a trailing `_` (un-nested route) is removed.
- Files and folders starting with `-` are ignored, as the router does.

**Route changes.** Any file added, removed or changed under the routes directory makes farol read the base table too.
A new route is additive (`route-added`), a removed route or a route whose layouts changed is `routes-not-additive`,
reported against the route's own module.

## TypeScript and JavaScript backends (GraphQL, REST)

With `"surface": "backend"`, the entry points are GraphQL root operations (`Query.*`, `Mutation.*`, `Subscription.*`)
and REST endpoints (`GET /path`).

- **Schema:** every `.graphql`/`.gql` file and `gql`/`graphql` tagged template, parsed with the official GraphQL parser. An operation's *reachable types* are every type it can return, through fields, unions and interfaces.
- **Resolvers:** resolver maps anywhere (`{ Type: { field() {…} } }`). A member counts only when it names a real field of that type, so loader registries keyed by type names are not mistaken for resolvers. Enum value maps count too. An operation runs its own resolver and the resolvers of every type it can return.
- **REST:** Fastify/Express-style registrations: `app.get('/path', handler)`, `router.route('/path').post(handler)` and `fastify.route({ method, url, handler })`. Prefixes from `register`/`use` are not applied.
- **Hono:** `app.route('/prefix', sub)` mounts are followed with the checker, from the apps nothing mounts (base `/`) down. Paths join like Hono's `mergePath`. A factory (a function that returns one app) mounted N times gives N endpoints, and an app passed to a parameter typed `Hono` is that parameter's app. In a file that imports `hono`, a construct farol cannot follow is a `dynamic-route`, never a path as written: a prefix that is not a string literal, `basePath()`, a factory with several returned apps, a mount target that is a parameter, or a receiver farol cannot resolve. Mount lines are compared like handlers: a new mount gives new endpoints; a removed or changed mount is a change. A new mount is also a change when its sub-app registers middleware (`use()`, a handler that takes `next`, `on()`) that runs for existing endpoints under its path (`:param` and `*` match any segment), when it serves the full key of an existing endpoint, or when its arguments run code. New top-level code in a REST or resolver file that is not a declaration, an inert constant, a handler or a mount (`app.use(mw)`, `const db = connect()`, a side-effect import) runs when the file loads: a change.
- **Hono middleware:** code that an app installs with `use()`, `on()`, `onError()` or a handler that can call `next` runs for every endpoint of a Hono app under its full path (`/x/*` also covers `/x`; a path farol cannot read covers the whole app), so its modules are modules of those endpoints. A guard before the handler (`post('/x', guard, h)`, also in Express and Fastify) is a module of that route only. A same-file variable or function at the argument is followed. A change to the module code of a file that holds an app (it creates, receives or registers on one, or holds one from a factory, with or without handlers) lists every endpoint under that app and every endpoint that uses the file; with no app left in the file, every Hono endpoint. Moving a statement in such a file is a change; in a file with no handlers, so is anything beyond comments and formatting. These are `dynamic-route`: `onError` on an app farol cannot follow, middleware whose code comes from the callers (a parameter, also through a property, a call or a variable), and an app passed to a project function whose parameter is not typed `Hono`.
- **What an operation uses:** the modules its resolver code references, resolved with the checker (imports, re-exports, CommonJS `require`, helpers of the same file). In addition:
  - **Globals** set with `global.X = …`: a reader of `X` uses that module.
  - **Context injection** declared in `backend.context`: `loaders.Brand…` uses the provider whose directory or file name matches `Brand`, or every provider when none matches.
- **Additive rules:**
  - A changed schema is additive when it only adds fields, types, enum values or union members (descriptions are ignored).
  - A changed resolver file is additive when every existing resolver and endpoint keeps its code. The only changes allowed elsewhere in the file are new imports, statements or object properties; comments are ignored.
  - A changed resolver affects only the operations that run it. A changed schema member affects the operations that can return its type.

Backends keep module-level reach: CommonJS bootstrap code often sets globals that would otherwise merge everything.

## Go

A helper in `go-helper/` (Go standard library only) is built once per version into the temp directory. It reads each
tree exported with `git archive`:

- `go list -deps` runs with `GOPROXY=off`, `CGO_ENABLED=0` and `GOWORK=off`;
- `go/parser` and `go/types` type-check the project, with dependencies type-checked without function bodies;
- no code of the module runs.

**Declarations:**

- functions, methods, types, variables and constants;
- a hash of their tokens, without comments or formatting;
- a *core* hash that leaves out route registration calls, so adding a route does not count as changing the function that registers it;
- constants are hashed by their type and value: appending a constant to an `iota` group changes no other constant, reordering the group does.

**References:**

- identifiers and selected fields resolved with `go/types`;
- an interface method call reaches every project type that implements the interface, except library methods (`String`, `Error`, `MarshalJSON`… called through `fmt.Stringer`, `json.Marshaler` or another interface outside the project): those run on whatever value reaches the call, and a type already depends on them, so formatting a value does not reach every `String` of the project;
- a method only libraries can call (never called in the project, or named like an implicit interface: `String`, `Error`, `MarshalJSON`, `ServeHTTP`, `Read`, `Write`, `Scan`, `Value`…) depends on its type;
- a method reading its own receiver's fields is not a use of its type.

**Entry points:**

- **chi:** `Get`/`Post`/…, `Method`, `Handle`, `Mount`, `Route` and `Group` closures, `With` and `Use` middlewares, and functions that receive a router (walked with the caller's prefix).
- **gin and echo:** verbs, `Handle`/`Add`/`Match`, groups (assigned to variables, chained, or passed to functions) and `Use`.
- **net/http:** `Handle`/`HandleFunc`, including Go 1.22 `"GET /path"` patterns.
- **gRPC:** a call to `Register<X>Server(registrar, impl)` makes every method of `<X>Server` an entry point (`RPC <pkg>.<X>/<Method>`), anchored on the implementation's method.
- **Binaries:** each `main` package that registers no route, as `RUN <dir>`.
- **Paths that are not constants:** a local variable takes the constant last assigned to it before the registration (`prefix := "/api/actions"; r.Mount(prefix, …)`); any other expression becomes the path in braces (`POST {path + "*"}`). The route is still an entry point, since its handler is known: only its URL is not. A method that is not a constant (`r.Method(m, …)`) is a dynamic route.
- **Anchors and inline code:** a route's handler and middlewares are its anchors. Inline handler literals are compared by hash, route by route.

**Removed routes:** a route that disappears (removed, or lost through a changed group or prefix) is
`routes-not-additive`.

**Dependencies:** `go.mod` and `go.sum` ([Dependencies](#dependencies)).

## Python

A helper package in `py-helper/` (Python 3.11+, standard library only) runs with `python3 -I`. It only **parses**
files (`ast`, `tokenize`, `tomllib`): nothing of the project is imported or executed.

- **Modules:** every non-test `.py` file, named from the first import root (`python.roots`) that contains it. Relative imports and re-exports through `__init__.py` are followed.
- **Declarations:**
  - functions, classes (header and attributes), methods and module variables;
  - import-time module code, and the `if __name__ == "__main__":` block apart;
  - each compared by its AST dump: comments, docstrings and formatting never count;
  - route decorators, `include_router`/`register_blueprint` calls and Django `urlpatterns` are compared route by route.
- **References:**
  - names through imports, `self.`/`cls.` through the class and its bases;
  - **local type inference** for the receiver of a method call: annotated parameters (`Optional`, `| None`, `Annotated[…, Depends()]`), `x = Class()`, `x: Class`, typed `self.` attributes (class annotations, `self.a = Class()`, `self.a = param`), and module variables assigned from a project class;
  - a call on a value of unknown type reaches every project method with that name (conservative); a value built by something outside the project (`FastAPI()`, `logging.getLogger()`) reaches nothing;
  - classes depend on their dunder methods only.
- **Entry points:**
  - **FastAPI and Flask:** verbs, `api_route`, `websocket`, `route`, `add_api_route`, `APIRouter(prefix=…)` and `Blueprint(url_prefix=…)`, `include_router`/`register_blueprint` (with prefixes). A path or prefix that is not a literal is read from a module constant, or from the string default of a settings attribute (`settings.API_V1_STR` with `settings = Settings()` and `API_V1_STR: str = "/api/v1"` on the class, pydantic-settings style); anything else keeps its routes, with the expression as their path (`{os.environ.get('PREFIX', '')}/me`).
    - Several apps are labeled by service (`api GET /items`).
    - The app object, the routers and the app module's import-time code (lifespan, middlewares) are anchors too.
  - **Django:** `ROOT_URLCONF`, `path`/`re_path`/`url`, `include()`; class-based views anchored on their dispatch and HTTP-verb methods.
  - **MCP:** `@mcp.tool`, `@mcp.resource(uri)`, `@mcp.prompt`, `mcp.add_tool(fn)`.
  - **Celery:** `@app.task`, `@shared_task`.
  - **Temporal:** `@activity.defn`, `@workflow.defn` (with all methods).
  - **Prefect:** `@flow` and `@flow(name=…)` become `FLOW <name>`, with Prefect's default name (the function name with hyphens). Tasks run inside flows and are reached through them.
  - **Scripts:** scripts with a `__main__` guard.

## Roles

Precedence: `global`, `routes`, `test`, `story`, `infra`, then `barrel`, `i18n`, `source`. Files matching `exclude` are
left out and listed. Each `roles` key the configuration leaves out takes the default of the project's language
(TypeScript, Go or Python), key by key. Roles assigned on top of the configuration:

- **`manifest`:** `package.json`, `go.mod`, `pyproject.toml` or `requirements.txt` of the project, of a directory above it, or (npm) of a workspace package the project imports.
- **`lockfile`:** `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, `go.sum`, `uv.lock`, `poetry.lock`, `Pipfile.lock` or `pdm.lock`.
- **`infra`:** environment, infrastructure and CI files (`roles.infra`), matched on repo-relative paths, also outside the project directory, and never for source code files. They make the PR `touches-existing` (`infra-file-changed`), get their own section and weigh at most 0.12 in the score together.
- **`schema` / `resolvers`:** TypeScript backends, files with SDL or resolver maps.

## Dependencies

Each changed manifest is compared requirement by requirement:

- **npm:** `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, and moves between them.
- **Go:** direct `require` and `// indirect`.
- **Python:** `project.dependencies`, extras (`optional-dependencies`, with their name in `group`), PEP 735 `dependency-groups`, uv `dev-dependencies`, Poetry dependencies and groups, and `requirements.txt` lines.

Versions are compared on the lowest version each range allows.

| Critical (class `global`) | Not critical |
|---|---|
| removed dependency (Go `// indirect`: not critical) | added dependency |
| major bump; minor bump of `0.x`; patch bump of `0.0.x` | minor and patch bumps |
| versions that cannot be compared (git URLs, tags, Go pseudo-versions of the same base) | range-only changes |
| downgrade (direct) | moves into runtime sections |
| npm: moved out of `dependencies`/`peerDependencies`; other manifest fields changed (`exports`, `scripts`, `engines`…) | lockfile changed with manifest changes |
| Go: other directives (`go`, `toolchain`, `replace`…); Python: `requires-python`, `build-system`, `tool.uv.sources`… | Python: project metadata and dev-tool settings (`tool.ruff`, `tool.pytest`…) |
| lockfile changed without any dependency change in any manifest of the repository | |

**Monorepos.** A JavaScript lockfile above the project (one root lockfile for every project) that was modified together with
dependency changes only in other projects' manifests is `lockfile-changed-elsewhere`: class `touches-existing`, weight
0.05. With hoisting or deduplication, another project's new dependency can still change the versions this project
loads, so it is never `isolated`; it is not `global` either, or every dependency PR would be `global` in every project.
Only manifests in the lockfile's directory or below count: a lockfile inside the project is the project's own, and
another project's dependency change does not explain it. A root lockfile also covers a project below it that has its
own lockfile, or a project outside the workspace that installs on its own: farol does not read lockfiles or workspace
lists, so it cannot tell which one that project installs from. Go and Python lockfiles are never shared this way (a
nested Go module or Python project has its own): `go.sum` and the Python lockfiles keep the plain lockfile rule. A deleted, added
or renamed lockfile changes every pinned version: it stays `lockfile-only-change`.

## Signals

Each signal has a status: `ok`, `not-provided` (no report, or the file is missing) or `error` (unreadable). Signals
never change the class.

- **Diff coverage:**
  - Changed lines are the added lines of changed code files. A changed line is *executable* when it intersects a statement, and *covered* when every statement intersecting it ran.
  - A changed file missing from the report counts as fully uncovered.
  - Formats: Istanbul JSON, Go coverprofile (blocks of several test binaries merged), coverage.py JSON.
- **Lint on changed lines:**
  - Findings on changed lines count; findings elsewhere are context. At most 50 are kept.
  - Formats: ESLint JSON, Biome GitLab JSON (`biome lint --reporter=gitlab`), golangci-lint JSON, ruff JSON.
- **Added suppressions:**
  - TypeScript: computed with the scanner and the AST (`eslint-disable*`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `biome-ignore`, `biome-ignore-all`, `biome-ignore-start`, `as any`, `: any`), so the same text in strings is ignored. Biome ignores that name only `format` or `assist` switch no check off and are left out; `biome-ignore-end` closes a range and is not counted again.
  - Go and Python: read from comments (`//nolint`, `//lint:ignore`, `#nosec`; `# noqa`, `# type: ignore`, `# nosec`, `# pragma: no cover`, `# pyright: ignore`, `# pylint: disable`).
- **Modified tests:** existing test files modified, deleted or renamed, with removed line counts.
- **Security (added lines):**
  - TypeScript built-in rules:
    - high: `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`, `eval` and `Function`, known token formats (AWS, GitHub, Slack, Stripe, OpenAI-style keys, private keys, JWTs), `javascript:` URLs;
    - medium: string timers, `document.write`, `postMessage(…, "*")`, high-entropy strings assigned to secret-like names;
    - low: `target="_blank"` without `rel`, plain-HTTP URLs.
  - Go: gosec issues from the golangci-lint report.
  - Python: ruff `S` (flake8-bandit) findings.
- **Vulnerabilities:**
  - Advisories on dependencies the PR added or changed (direct), or on packages they bring in (transitive); the rest of the report is context.
  - Formats: npm/pnpm audit, govulncheck (called code is high, imported packages moderate, required-only modules low), pip-audit.

- **Traffic (optional, `--usage`):**
  - Reads a usage report written by `farol usage`: Datadog RUM page views by `@view.url_path_group` (frontends) and the APM metric `trace.<operation>.hits` by `resource_name` (backends).
  - Every row goes to the entry points it matches with the most literal path segments. Route parameters (`:id`, `{id}`, `<int:id>`, `*`) match any segment, including RUM's `?`. Both sides get Datadog's tag normalization (lowercase; other characters become `_`). The method must agree unless either side has none (`ANY` routes, RUM). Service labels (`api GET /x`) are ignored. `RPC pkg.S/M` matches `/pkg.S/M`, and kinds like `FLOW x` also match `x`; `Query.x` matches `graphql.resolve` resources `x:<type>`. Rows tied between entry points count for each.
  - Errors: rows also carry the ids of the distinct errors (Error Tracking issues) seen on them, from RUM `@type:error` events and APM error spans grouped by `@issue.id`; per entry point the count is the size of the union. Error Tracking issues (top 100 by count per source) are attributed to a changed file by the longest shared path suffix (file names compared without extensions; at least three segments, or two that are a whole path; ties and dependency frames match nothing).
  - The output's `usage` holds the total, the matched traffic, the errors, the traffic of the affected pages/operations (layouts excluded), and each affected entry point with traffic. It never changes the class, the score or the verdict.

## Contracts (backends)

- **Shape:** helpers describe parameters, body and response as shapes (`src/contracts/types.ts`): scalars, enums, lists, objects (fields with `req`/`null`), unions, references (recursion) and `unknown`.
- **Comparison** (`src/contracts/compare.ts`) depends on the direction:
  - **request (in):** a new required field or parameter, optional → required, null no longer accepted, or an enum value removed is breaking; a removed field is dangerous;
  - **response (out):** a removed field, a field that may now be missing or null, or a changed type is breaking; an enum value or union member added is dangerous;
  - additions are safe;
  - `unknown` on either side, or a side that is no longer readable, is dangerous ("check by hand").
- **GraphQL:** base schema = the head schema with every changed SDL file in its base version. graphql-js lists breaking and dangerous changes; each is attributed to the root field it names, or to every operation that returns (fields, unions, implementations) or takes (input objects) the changed type.
- **FastAPI:** parameters by source (`Query`, `Path`, `Header`, `Cookie`, `Body`, `Form`/`File`, `Depends` skipped; a model-typed parameter is the body), required unless it has a default; Pydantic fields from annotations, `Field(...)` defaults and aliases, project base classes; enums from `Enum` subclasses and `Literal`; type aliases followed.
- **Go:** request types from `json.Decoder.Decode`, `json.Unmarshal`, gin/echo `Bind…`/`ShouldBind…`; response types from `json.Encoder.Encode`, `json.Marshal`, gin/echo `JSON`, chi `render.JSON`; project functions that pass a parameter to those count at their call sites (two levels). Untyped maps (error bodies) are dropped when a typed value exists; several types become a union. gRPC: the method's request and response messages.
- **Removed endpoints** (HTTP, WebSocket, gRPC) are breaking.
- **Callers:** `farol usage` aggregates indexed client spans with `@peer.service:<service>` by calling `service`, `@http.method` and `@http.url_details.path` (client span resources hold only the method); rows are matched to entry points like traffic. Counts are of indexed spans: a sample, good for comparing callers.
- **Weight:** all breaking endpoints together weigh at most 0.4 in the merge score, dangerous ones 0.1 (not tied to a file). Breaking makes the verdict careful.

## Risk, merge risk score and verdict

**Risk level per file** (Risk section), from its reach:

- **high:** modified and used by at least half of the existing entry points, or by 10 or more;
- **medium:** used by some entry point, or by 10 or more files; or new code already used by existing entry points; or deleted;
- **low:** additive, or not used by existing entry points.

**Merge risk score**, 0–100. Every risky item has a weight *w* in [0, 1], and the score is `100 × (1 − Π(1 − w))`: the
chance that at least one item breaks something, if they were independent. Adding an item never lowers it, and
marking a file as reviewed removes that file's items.

| Item | Weight |
|---|---|
| Modified code file reached by entry points | `0.05 + 0.45 × share of entry points + 0.15 × centrality` (at least 0.35 when high, 0.12 when medium; at most 0.6) |
| Modified code file no entry point reaches | `0.03 + 0.1 × centrality` |
| New code already used by existing entry points / not used | 0.15 / 0.02 |
| New TS/JS file with only declarations (types, re-exports, static constants) | 0.01 each, 0.05 for all together |
| Deleted code file / additive change | 0.2 / 0.02 |
| … each of the above, times what diff coverage leaves | `1 − 0.7 × covered share` (100% covered keeps 30%). Only declarations changed: 0.5. Coverage not verified: 1. |
| Environment, infrastructure and CI files | 0.12 for all of them together |
| Security finding (high / medium / low) | 0.3 / 0.1 / 0.02 |
| Lint error on a changed line | 0.05 |
| Added suppression | 0.02 |
| Existing test deleted / 10+ lines removed / fewer | 0.1 / 0.05 / 0.02 |
| Critical / other dependency change | 0.25 / 0.03 |
| Vulnerability in a changed dependency (critical, high, moderate, low; transitive × 0.6) | 0.5, 0.35, 0.12, 0.03 |
| Global reason (global file, manifest field, lockfile without manifest) | 0.3 |
| Shared lockfile changed by another project's dependencies (`lockfile-changed-elsewhere`) | 0.05 |
| Unknown reason (syntax error, dynamic route, unresolved import) | 0.25 |
| Docs, templates and other files that are not code | 0 |

Levels: high from 60, medium from 30.

**Verdict:**

- **careful** when any of these holds:
  - the class is `unknown`;
  - the score is 60 or more;
  - there is a high-severity security finding;
  - a changed dependency has a critical or high vulnerability;
  - a high-reach file has measured diff coverage below 50%.
- **quick** when any of these holds:
  - the score is 25 or more;
  - existing code changed;
  - environment, infrastructure or CI files changed;
  - the class is `global`;
  - diff coverage is below 50% (below 80% when existing code changed);
  - there are lint errors on changed lines;
  - existing tests were deleted or trimmed by 10+ lines;
  - suppressions were added.
- **fast track** otherwise.

"Start here" lists up to 7 code files with at least 5 risk points, riskiest first.

The weights and thresholds are heuristics. The calibration in DECISIONS (662 commits, four repositories) supports
them: fast track had no problems in 56 commits, and the score's AUC was 0.72–0.83. Use `farol calibrate` on your
own history.

## The JSON result

`analyze` writes one JSON document (schema version 1, validated with zod, deterministic: sorted arrays, `/` paths).
Its main fields:

- **Identification:** `surface`, `tool`, `repo`, `pr`, `base`, `mergeBase`, `head`, `analyzedAt`.
- **Result:** `classification`, `reasons` (code, file, detail) and `files` (path, status, role, additive, lines).
- **Analysis blocks:** `dependencies`, `risk` (per file: reach, centrality, level), and `routes` (added, affected with chains, disconnected new files).
- **Signals:** `signals.coverage`, `lint`, `suppressions`, `testsModified`, `security`, `vulnerabilities`.
- **Diagnostics:** unresolved imports, dynamic routes, parse errors, timings, error.
- **Optional:** `diffs` (inline diffs), `incremental`, `reviewers`.

The reports (`html`, `report`, `comment`) are pure functions of this JSON.

## Guarantees

- **No execution of the analyzed code.** farol never imports, `require`s or runs the analyzed code: no build tools, no configs that execute code (Vite, ESLint, Jest), no `go generate`, no Python imports. Go is read with `go list` and `go/types` offline, Python with `ast`.
- **Network:** only the `comment` command uses it, to call the GitHub API.
- **Fail closed:** when something cannot be read, the class is `unknown` or `touches-existing`, never `isolated`.
- **Shadow mode:** farol informs. Nothing it produces approves or blocks a PR.
