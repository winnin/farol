# Reason codes

Every classification is explained by a list of reasons `{ code, file?, detail }`. The codes form a closed list,
defined in `src/classify/reasons.ts` (`REASONS`) and validated by the output schema. Reasons are sorted in the order
below, then by file, then by detail.

The **effect** column says which class the reason forces. The first class that has at least one reason wins:
`global` > `unknown` > `touches-existing`; with none of them the PR is `isolated`. `info` reasons never change the
class; they explain it.

| Code | Effect | Emitted when | `file` |
|---|---|---|---|
| `global-file-changed` | global | A file with the `global` role (configuration globs) was added, modified, deleted or renamed. | the global file |
| `manifest-changed` | global | A project package manifest (`package.json` of the project, of a directory above it, or of an imported workspace package) was added, deleted or renamed, or changed a field other than the dependency sections (`exports`, `scripts`, `engines`, `overrides`…). | the manifest |
| `dependency-critical` | global | A dependency was removed, bumped a major version (or a breaking 0.x minor / 0.0.x patch), changed to a version that cannot be compared, or moved out of `dependencies`/`peerDependencies`. | the manifest |
| `lockfile-only-change` | global | A lockfile of the project changed while no manifest dependency changed: resolved versions may differ. | the lockfile |
| `analysis-error` | unknown | The analysis threw: bad ref, shallow history, missing routes file or tsconfig, internal error. The message is also in `diagnostics.error`. | — |
| `parse-error` | unknown | A changed TS/JS file has syntax errors in the head program, or a changed i18n JSON file is not valid JSON. | the file |
| `dynamic-route` | unknown | The route adapter met a construct it cannot read statically (spread, `.map`, computed path, component declared in the routes file, imported route array…). Also emitted for the base version when the routes file changed. TypeScript backends: a Hono construct farol cannot follow (a prefix that is not a string literal, `basePath()`, a factory with several returned apps, a mount target that is a parameter, an app farol cannot resolve, `use()` on such an app, spread `route(...args)`). | the routes file, or the file with the Hono construct |
| `unresolved-import` | unknown | A changed file has an import that does not resolve (or an `import()` / `import.meta.glob` with a computed path; not for targets under `generated` globs), or an unchanged file imports a path this PR deleted or renamed away. Also a changed file of a workspace package of the repository whose import does not resolve (no `src/` source for its `dist/` entry, `preserveSymlinks`). | the importing file; for a workspace package, the changed file of the package |
| `routes-not-additive` | touches-existing | The routes file was modified and a base route disappeared, changed entry module, layouts or referenced modules, the normalized diff removed lines, or a token of the base outside its imports is gone. One reason per problem. | the routes file |
| `barrel-not-additive` | touches-existing | A modified barrel contains a statement that is not an export declaration, or a base export declaration is missing or edited. | the barrel |
| `i18n-not-additive` | touches-existing | A modified i18n file lost a key or changed a value (deep comparison), or it is not JSON. | the i18n file |
| `existing-file-modified` | touches-existing | An existing source file was modified; the detail lists the existing routes that reach it with the import chain. | the file |
| `existing-file-unreachable` | touches-existing | An existing source file was modified but no route reaches it (or it is not in the import graph at all, e.g. a Markdown file). Still a change to existing code. | the file |
| `existing-file-renamed` | touches-existing | An existing analyzed file was renamed (any content change included). | the new path |
| `existing-file-deleted` | touches-existing | An existing analyzed file was deleted. | the deleted path |
| `lockfile-changed-elsewhere` | touches-existing | A JavaScript lockfile shared with other projects (a monorepo lockfile above the project) was modified (not deleted, added or renamed), and only manifests of other projects have dependency changes. Resolved versions this project loads may still differ (hoisting, deduplication). Weighs 0.05 in the merge risk score. | the lockfile |
| `infra-file-changed` | touches-existing | An environment, infrastructure or CI file changed (`roles.infra`: env files, Dockerfiles, compose, CI workflows, helm, k8s, terraform…; never source code). No entry point runs it, but deployments do. | the file |
| `new-file-reached-by-existing-route` | touches-existing | A new file is reached by a route that already existed in the base (through a modified file or a changed route component). | the new file |
| `tests-modified` | info | An existing test file was modified, deleted or renamed; the detail gives the removed line count. Highlighted in the report. | the test file |
| `declarations-additive` | info | Go: a modified file whose existing declarations (functions, methods, types, variables, constants) all keep the same code; only new declarations, comments or formatting changed. Compared by a hash of each declaration's tokens. | the Go file |
| `dependency-changed` | info | A dependency was added, or bumped a minor/patch version, or only its range operator changed. | the manifest |
| `lockfile-changed` | info | A lockfile changed together with manifest dependency changes. | the lockfile |
| `route-added` | info | The head route table has a key the base did not have. | the routes file |
| `routes-additive` | info | The routes file was modified and the routes rule holds. | the routes file |
| `barrel-additive` | info | A barrel was modified and only gained export declarations. | the barrel |
| `i18n-additive` | info | An i18n JSON file was modified and only gained keys. | the i18n file |
| `new-file-in-new-route` | info | A new file is reached only by routes added in this PR. | the new file |
| `new-file-disconnected` | info | A new file is reached by no route (also listed in `routes.disconnectedNewFiles`). | the new file |
| `file-excluded` | info | A changed file matches `exclude` and is not a test or story; it is left out of the analysis. | the file |
| `outside-project` | info | A changed file is outside the project directory and is not imported by the project (e.g. another app of the monorepo). | the file |
| `no-existing-code-touched` | info | Summary emitted when no reason forces `global`, `unknown` or `touches-existing`. | — |

## Roles and rules in short

- Package manifests and lockfiles of the project get the roles `manifest` and `lockfile` regardless of the configured
  globs; dependency changes are listed in the `dependencies` block of the output.
- Changed files matching `ignore` (configuration) or `--ignore` are removed before any analysis and listed in
  `ignoredFiles`.
- Roles, in precedence order: `global`, `routes`, `test`, `story`, `barrel`, `i18n`, `source`; `excluded` for files
  matching `exclude` that would otherwise be barrel, i18n or source.
- Only modified `routes`, `barrel` and `i18n` files can be additive. Any other existing file that is modified, deleted
  or renamed is a non-additive change, even if it only gained lines.
- Tests and stories never change the class. A PR that only changes tests is `isolated`, with `tests-modified` when
  existing tests were modified or removed.
