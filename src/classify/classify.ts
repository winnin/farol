import { posix } from 'node:path'
import type { ChangedFile } from '../git/types.js'
import { compareStrings, sortedUnique } from '../output/order.js'
import type { AddedRoute, AffectedRoute, Dependencies, OutputFile, UnresolvedImportOut } from '../output/schema.js'
import type { ImportGraph, ParseError } from '../project/graph.js'
import { KEY_SEPARATOR } from '../routes/paths.js'
import type { DynamicRoute, RouteEntry, RouteTable } from '../routes/types.js'
import { checkBarrelAdditive, checkI18nAdditive, compareRouteTables, JsonParseError, losesTokens, unexplainedRemovedLines } from './additive.js'
import { createReachIndex, reachFrom, routesReaching, type ReachIndex } from './reach.js'
import { classificationFrom, reason, REASONS, sortReasons, type Classification, type Reason } from './reasons.js'
import type { AnalysisRole } from './roles.js'
import { computeRisk, type FileRisk } from './risk.js'
import type { BackendFileImpact } from '../backend/impact.js'
import { describeChange, sortChanges, type ManifestResult } from './dependencies.js'
import { lockfileReason } from './lockfile.js'

export interface ClassifyInput {
  files: readonly ChangedFile[]
  /** Role of a repo-relative path; `outside` for files outside the project directory. */
  roleOf: (repoPath: string) => AnalysisRole | 'outside'
  /** Whether an import target (repo-relative, as written) is generated code that git ignores (`generated` globs). */
  isGenerated: (repoPath: string) => boolean
  /** Modified files that only declare types in base and head (erased at compile time). */
  typeOnlyFiles?: ReadonlySet<string>
  /** Backend only: impact of each changed schema or resolver file (Go/Python: of every source file). */
  backend?: { impacts: ReadonlyMap<string, BackendFileImpact> }
  /** TypeScript: declaration-level impact of changed source files (precise reach instead of the file graph). */
  declImpacts?: ReadonlyMap<string, BackendFileImpact>
  /** Dependency diff of every changed manifest (or why it could not be read). */
  manifests: readonly ManifestResult[]
  /** Dependency diff of changed manifests of the same ecosystem outside the project (monorepo siblings). */
  otherManifests: readonly ManifestResult[]
  graph: ImportGraph
  routesFile: string
  /** File-system router: routes are their own modules, so route changes are reported against each route's module. */
  routesFromDirectory?: boolean
  headRoutes: RouteTable
  /** Route table of the base when the routes file changed; null when it did not (the head table is the base). */
  baseRoutes: RouteTable | null
  /** Base contents of modified routes, barrel and i18n files, by repo path. */
  baseText: ReadonlyMap<string, string>
  /** Head contents of modified routes, barrel and i18n files. */
  headText: ReadonlyMap<string, string>
}

export interface ClassifyResult {
  classification: Classification
  reasons: Reason[]
  files: OutputFile[]
  routes: { added: AddedRoute[]; affected: AffectedRoute[]; disconnectedNewFiles: string[] }
  dependencies: Dependencies
  risk: { totalPages: number; files: FileRisk[]; summary: { high: number; medium: number; low: number } }
  diagnostics: { unresolvedImports: UnresolvedImportOut[]; dynamicRoutes: DynamicRoute[]; parseErrors: ParseError[] }
}

function withoutExtension(path: string): string {
  const ext = posix.extname(path)
  return ext === '' ? path : path.slice(0, -ext.length)
}

/** Whether an unresolved specifier target could have pointed at a file this PR deleted or renamed away. */
function targetsRemoved(target: string, removed: readonly string[]): boolean {
  return removed.some((r) => r === target || withoutExtension(r) === target || (posix.dirname(r) === target && posix.basename(r).startsWith('index.')))
}

class AffectedCollector {
  private readonly byKey = new Map<string, { key: string; path: string; via: Map<string, string[]> }>()

  add(route: { key: string; path: string }, file: string, chain: string[]): void {
    let entry = this.byKey.get(route.key)
    if (!entry) {
      entry = { key: route.key, path: route.path, via: new Map() }
      this.byKey.set(route.key, entry)
    }
    const current = entry.via.get(file)
    if (!current || chain.length < current.length) entry.via.set(file, chain)
  }

  list(hasChildren: (key: string) => boolean): AffectedRoute[] {
    return [...this.byKey.values()]
      .map((e) => ({ key: e.key, path: e.path, hasChildren: hasChildren(e.key), via: [...e.via.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([file, chain]) => ({ file, chain })) }))
      .sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.key, b.key))
  }
}

/** Route label for reason details: the path, plus the key when another route shares the path. */
function routeLabel(route: RouteEntry, all: readonly { route: RouteEntry }[]): string {
  const shared = all.some((h) => h.route !== route && h.route.path === route.path)
  return shared ? `${route.path} [${route.key}]` : route.path
}

function describeHits(hits: { route: RouteEntry; via: string[] }[]): string {
  const shown = hits.slice(0, 3).map((h) => `${routeLabel(h.route, hits)} via ${h.via.join(' → ')}`)
  return hits.length > 3 ? `${shown.join('; ')}; and ${hits.length - 3} more` : shown.join('; ')
}

function dependenciesBlock(input: ClassifyInput, files: readonly OutputFile[]): Dependencies {
  const changes = sortChanges(input.manifests.flatMap((m) => ('error' in m ? [] : m.changes)))
  const bumps = (b: string) => changes.filter((c) => (c.change === 'updated' || c.change === 'moved') && c.bump === b).length
  return {
    manifests: sortedUnique(input.manifests.map((m) => m.manifest)),
    lockfiles: sortedUnique(files.filter((f) => f.role === 'lockfile').map((f) => f.path)),
    changes,
    summary: {
      critical: changes.filter((c) => c.critical).length,
      major: bumps('major'),
      minor: bumps('minor'),
      patch: bumps('patch'),
      added: changes.filter((c) => c.change === 'added').length,
      removed: changes.filter((c) => c.change === 'removed').length,
    },
  }
}

/** Pure classification of a PR from its diff, the head graph and the route tables. */
export function classify(input: ClassifyInput): ClassifyResult {
  const { graph, headRoutes } = input
  const reasons: Reason[] = []
  const nodes = new Set(graph.nodes)
  const index: ReachIndex = createReachIndex(graph)
  const affected = new AffectedCollector()
  const outputFiles: OutputFile[] = []
  const disconnected: string[] = []

  const baseTable = input.baseRoutes ?? headRoutes
  const baseKeys = new Set(baseTable.routes.map((r) => r.key))
  const existingRoutes = headRoutes.routes.filter((r) => baseKeys.has(r.key))
  const addedRoutes = headRoutes.routes.filter((r) => !baseKeys.has(r.key))
  // Where a route change is reported: the routes file, or the route's own module for file-system routers.
  const routeFileOf = (key: string): string => {
    if (!input.routesFromDirectory) return input.routesFile
    return headRoutes.routes.find((r) => r.key === key)?.entry ?? input.baseRoutes?.routes.find((r) => r.key === key)?.entry ?? input.routesFile
  }
  for (const r of addedRoutes) reasons.push(reason('route-added', input.backend ? `new entry point ${r.key}${r.entry ? ` (registered in ${r.entry})` : ''}` : `${r.path} (${r.key}) renders ${r.entry ?? 'nothing'}`, input.routesFile === '' && !input.routesFromDirectory ? undefined : routeFileOf(r.key)))

  const dynamicRoutes = [...headRoutes.dynamic, ...(input.baseRoutes?.dynamic ?? []).map((d) => ({ ...d, detail: `in the base version: ${d.detail}` }))]
  for (const d of dynamicRoutes) reasons.push(reason('dynamic-route', `line ${d.line}: ${d.detail}`, d.file))

  const changed = new Set(input.files.filter((f) => f.status !== 'deleted').map((f) => f.path))
  const removed = input.files.flatMap((f) => (f.status === 'deleted' ? [f.path] : f.status === 'renamed' && f.oldPath !== undefined ? [f.oldPath] : []))
  for (const e of graph.parseErrors) if (changed.has(e.file)) reasons.push(reason('parse-error', `line ${e.line}: ${e.message}`, e.file))
  for (const u of graph.unresolved) {
    // A generated target is missing from git by design; a target this PR removed is still a broken import.
    const brokenByChange = changed.has(u.file) && !(u.target !== undefined && input.isGenerated(u.target))
    const brokenByRemoval = u.target !== undefined && targetsRemoved(u.target, removed)
    if (brokenByChange || brokenByRemoval) {
      const what = u.reason === 'non-literal' ? `import with a computed path ${u.specifier}` : `cannot resolve "${u.specifier}"`
      reasons.push(reason('unresolved-import', `line ${u.line}: ${what}`, u.file))
    }
  }
  // A workspace package whose entry does not resolve: what its changed files reach is unknown.
  const unresolvedPackages = new Map<string, (typeof graph.unresolved)[number]>()
  for (const u of graph.unresolved) for (const folder of u.packages ?? []) if (!unresolvedPackages.has(folder)) unresolvedPackages.set(folder, u)
  for (const file of changed) {
    for (const [folder, u] of unresolvedPackages) {
      if (folder === '' || file.startsWith(`${folder}/`)) reasons.push(reason('unresolved-import', `cannot resolve "${u.specifier}" (workspace package ${folder === '' ? '.' : folder}), imported at ${u.file} line ${u.line}`, file))
    }
  }

  // The route table is compared once; its changes are reported against the routes file.
  const tableChanges = input.baseRoutes ? compareRouteTables(input.baseRoutes, headRoutes) : []
  for (const c of tableChanges) {
    const file = routeFileOf(c.key)
    reasons.push(reason('routes-not-additive', c.detail, file))
    affected.add(headRoutes.routes.find((r) => r.key === c.key) ?? c, file, [file])
  }

  const entryWord = input.backend ? 'entry point' : 'route'
  const impactOf = (path: string): BackendFileImpact | undefined => input.declImpacts?.get(path) ?? input.backend?.impacts.get(path)
  const addImpact = (path: string): void => {
    const impact = impactOf(path)
    for (const op of impact?.affected.keys() ?? []) {
      const route = headRoutes.routes.find((r) => r.key === op)
      if (route) affected.add(route, path, impact?.chains?.get(op) ?? [path])
    }
  }

  const reachTargets: { path: string; reportModified: boolean }[] = []
  const newFiles: string[] = []

  for (const file of input.files) {
    let role = input.roleOf(file.path)
    if (role === 'outside') {
      if (file.status !== 'deleted' && nodes.has(file.path)) role = 'source'
      else {
        role = 'excluded'
        reasons.push(reason('outside-project', 'outside the project directory and not imported by the project', file.path))
      }
    } else if (role === 'excluded') {
      reasons.push(reason('file-excluded', 'matches "exclude" in the configuration', file.path))
    }
    const out: OutputFile = { path: file.path, status: file.status, role, linesAdded: file.added.length, linesRemoved: file.removed.length }
    if (file.oldPath !== undefined) out.oldPath = file.oldPath
    outputFiles.push(out)

    if (role === 'excluded' || role === 'story') continue
    if (role === 'manifest') {
      const diff = input.manifests.find((m) => m.manifest === file.path)
      if (diff && 'error' in diff) reasons.push(reason('parse-error', diff.error, file.path))
      if (file.status !== 'modified') reasons.push(reason('manifest-changed', `package manifest ${file.status}`, file.path))
      if (diff && !('error' in diff)) {
        for (const c of diff.changes) reasons.push(reason(c.critical ? 'dependency-critical' : 'dependency-changed', describeChange(c), file.path))
        if (diff.otherFields.length > 0) reasons.push(reason('manifest-changed', `fields changed: ${diff.otherFields.join(', ')}`, file.path))
      }
      continue
    }
    if (role === 'lockfile') {
      reasons.push(lockfileReason(file, input.manifests, input.otherManifests))
      continue
    }
    if (role === 'global') {
      reasons.push(reason('global-file-changed', `${file.status} global file`, file.path))
      continue
    }
    if (role === 'infra') {
      // Deploy-time configuration (env, infrastructure, CI): no entry point runs it, but deployments do.
      reasons.push(reason('infra-file-changed', `environment, infrastructure or CI file ${file.status}`, file.path))
      continue
    }
    if (role === 'test') {
      if (file.status !== 'added') reasons.push(reason('tests-modified', `existing test ${file.status}, ${file.removed.length} line(s) removed`, file.path))
      continue
    }
    if (file.status === 'added') {
      newFiles.push(file.path)
      // A new file whose Hono mount covers existing endpoints touches them (`backendImpacts`).
      const mountImpact = input.backend?.impacts.get(file.path)
      if (mountImpact) {
        for (const p of mountImpact.problems) reasons.push(reason('resolvers-not-additive', p, file.path))
        addImpact(file.path)
      }
      continue
    }
    if (file.status === 'deleted') {
      reasons.push(reason('existing-file-deleted', 'existing file deleted', file.path))
      addImpact(file.path)
      continue
    }
    if (file.status === 'renamed') {
      reasons.push(reason('existing-file-renamed', `renamed from ${file.oldPath ?? '?'}`, file.path))
      reachTargets.push({ path: file.path, reportModified: false })
      continue
    }
    // Modified existing file: only routes, barrel and i18n files can be additive.
    const declImpact = role === 'source' ? impactOf(file.path) : undefined
    if (declImpact) {
      // Declaration-level impact (Go, Python, TypeScript files that hold a Hono app): only changed or removed declarations count, with the entry points they reach.
      out.additive = declImpact.additive
      if (declImpact.additive) {
        const list = (items: readonly string[]): string => `${items.slice(0, 8).join(', ')}${items.length > 8 ? ', …' : ''}`
        const parts = [
          ...(declImpact.addedOperations.length > 0 ? [`new entry points ${list(declImpact.addedOperations)}`] : []),
          ...(declImpact.added.length > 0 ? [`new declarations ${list(declImpact.added)}`] : []),
          ...(declImpact.erased && declImpact.erased.length > 0 ? [`types changed (erased at runtime) ${list(declImpact.erased)}`] : []),
        ]
        reasons.push(reason('declarations-additive', parts.length > 0 ? `only additions: ${parts.join('; ')}` : 'only comments or formatting changed', file.path))
      }
      else {
        // Removed entry points are route table changes; the other problems are code that changed.
        const removedEntries = declImpact.problems.filter((p) => p.startsWith('entry point ') && p.endsWith(' was removed'))
        for (const p of removedEntries) reasons.push(reason('routes-not-additive', p, file.path))
        const problems = declImpact.problems.filter((p) => !removedEntries.includes(p))
        const what = `${problems.slice(0, 6).join('; ')}${problems.length > 6 ? `; and ${problems.length - 6} more` : ''}`
        const n = declImpact.affected.size
        if (problems.length > 0) reasons.push(n > 0 ? reason('existing-file-modified', `${what}: reached by ${n} existing ${entryWord}(s): ${[...declImpact.affected.keys()].slice(0, 3).join('; ')}${n > 3 ? `; and ${n - 3} more` : ''}`, file.path) : reason('existing-file-unreachable', `${what}; no ${entryWord} reaches it`, file.path))
      }
      addImpact(file.path)
      if (!declImpact.additive && declImpact.keepsReach) reachTargets.push({ path: file.path, reportModified: false })
      continue
    }
    if ((role === 'schema' || role === 'resolvers') && input.backend) {
      const impact = input.backend.impacts.get(file.path)
      if (impact) {
        out.additive = impact.additive
        const notAdditive = role === 'schema' ? 'schema-not-additive' : 'resolvers-not-additive'
        for (const p of impact.problems) reasons.push(reason(notAdditive, p, file.path))
        if (impact.additive) reasons.push(reason(role === 'schema' ? 'schema-additive' : 'resolvers-additive', impact.added.length + impact.addedOperations.length > 0 ? `only additions: ${[...impact.addedOperations, ...impact.added].slice(0, 8).join(', ')}` : 'no existing definition changed', file.path))
        addImpact(file.path)
        continue
      }
    }
    if (role === 'routes') {
      const baseText = input.baseText.get(file.path)
      const headText = input.headText.get(file.path)
      if (baseText === undefined || headText === undefined) throw new Error(`internal: missing base or head content of ${file.path}`)
      const removedLines = unexplainedRemovedLines(file.path, baseText, headText, file.removed.map((l) => l.line))
      const lostCode = removedLines.length === 0 && losesTokens(file.path, baseText, headText)
      out.additive = tableChanges.length === 0 && removedLines.length === 0 && !lostCode
      if (removedLines.length > 0) reasons.push(reason('routes-not-additive', `${removedLines.length} line(s) removed (line ${removedLines.join(', ')} of the base)`, file.path))
      if (lostCode) reasons.push(reason('routes-not-additive', 'code of the base is gone though no line was removed (a string, JSX text, or code on an import line)', file.path))
      if (out.additive) reasons.push(reason('routes-additive', 'every existing route is unchanged and no line was removed', file.path))
      continue
    }
    if (role === 'barrel' || role === 'i18n') {
      const baseText = input.baseText.get(file.path)
      const headText = input.headText.get(file.path)
      if (baseText === undefined || headText === undefined) throw new Error(`internal: missing base or head content of ${file.path}`)
      let additive = false
      if (role === 'barrel') {
        const result = checkBarrelAdditive(file.path, baseText, headText)
        additive = result.additive
        for (const p of result.problems) reasons.push(reason('barrel-not-additive', p, file.path))
      } else if (!file.path.endsWith('.json')) {
        reasons.push(reason('i18n-not-additive', 'the i18n rule only applies to JSON files', file.path))
      } else {
        try {
          const result = checkI18nAdditive(baseText, headText)
          additive = result.additive
          for (const p of result.problems) reasons.push(reason('i18n-not-additive', p, file.path))
        } catch (error) {
          if (!(error instanceof JsonParseError)) throw error
          reasons.push(reason('parse-error', error.message, file.path))
        }
      }
      out.additive = additive
      if (additive) reasons.push(reason(role === 'barrel' ? 'barrel-additive' : 'i18n-additive', role === 'barrel' ? 'only new export declarations' : 'only new keys', file.path))
      else reachTargets.push({ path: file.path, reportModified: false })
      continue
    }
    if (input.typeOnlyFiles?.has(file.path)) {
      reasons.push(reason('type-only-change', 'the file only declares types in both versions: nothing changes at runtime', file.path))
      continue
    }
    reachTargets.push({ path: file.path, reportModified: true })
  }

  for (const target of reachTargets) {
    const hits = nodes.has(target.path) ? routesReaching(reachFrom(index, target.path), existingRoutes) : []
    for (const h of hits) affected.add(h.route, target.path, h.via)
    if (!target.reportModified) continue
    if (hits.length > 0) reasons.push(reason('existing-file-modified', `reached by ${hits.length} existing route(s): ${describeHits(hits)}`, target.path))
    else reasons.push(reason('existing-file-unreachable', nodes.has(target.path) ? 'modified, and no route reaches it' : 'modified, and it is not part of the import graph', target.path))
  }

  for (const file of newFiles) {
    const impact = impactOf(file)
    if (impact?.newEntriesReaching !== undefined) {
      addImpact(file)
      const n = impact.affected.size
      if (n > 0) reasons.push(reason('new-file-reached-by-existing-route', `reached by ${n} existing ${entryWord}(s): ${[...impact.affected.keys()].slice(0, 3).join('; ')}${n > 3 ? `; and ${n - 3} more` : ''}`, file))
      else if (impact.newEntriesReaching.length > 0) reasons.push(reason('new-file-in-new-route', `reached only by new ${entryWord}(s): ${sortedUnique(impact.newEntriesReaching.map((k) => headRoutes.routes.find((r) => r.key === k)?.path ?? k)).join(', ')}`, file))
      else {
        disconnected.push(file)
        reasons.push(reason('new-file-disconnected', `new file that no ${entryWord} reaches`, file))
      }
      continue
    }
    const reach = nodes.has(file) ? reachFrom(index, file) : undefined
    const existingHits = reach ? routesReaching(reach, existingRoutes) : []
    const newHits = reach ? routesReaching(reach, addedRoutes) : []
    if (existingHits.length > 0) {
      for (const h of existingHits) affected.add(h.route, file, h.via)
      reasons.push(reason('new-file-reached-by-existing-route', `reached by ${describeHits(existingHits)}`, file))
    } else if (newHits.length > 0) {
      reasons.push(reason('new-file-in-new-route', `reached only by new route(s): ${sortedUnique(newHits.map((h) => h.route.path)).join(', ')}`, file))
    } else {
      disconnected.push(file)
      reasons.push(reason('new-file-disconnected', 'new file that no route reaches', file))
    }
  }

  if (!reasons.some((r) => REASONS[r.code] !== 'info')) reasons.push(reason('no-existing-code-touched', 'the PR only adds new files, routes, exports or keys, or changes tests'))
  // A route with children is a layout (wrapper); the others are the pages people visit.
  const allKeys = [...headRoutes.routes, ...(input.baseRoutes?.routes ?? [])].map((r) => r.key)
  const hasChildren = (key: string): boolean => allKeys.some((k) => k.startsWith(`${key}${KEY_SEPARATOR}`))
  const riskFiles = outputFiles
    .filter((f) => !input.typeOnlyFiles?.has(f.path))
    .filter((f) => f.role === 'source' || f.role === 'barrel' || f.role === 'i18n' || f.role === 'routes' || f.role === 'schema' || f.role === 'resolvers')
    .map((f) => ({ path: f.path, change: f.status === 'modified' ? (f.additive === true ? 'additive' : 'modified') : f.status }) as const)
  // Pages (not layouts) the declaration-level impact reaches.
  const overrides = new Map([...(input.backend?.impacts ?? []), ...(input.declImpacts ?? [])].map(([f, i]) => [f, [...i.affected.keys()].filter((k) => !hasChildren(k)).length] as const))
  const risk = computeRisk({ index, nodes, existingRoutes, hasChildren, files: riskFiles, ...(input.backend ? { unit: { one: 'operation', many: 'operations' } } : {}), ...(overrides.size > 0 ? { affectedOverride: overrides } : {}) })
  const sorted = sortReasons(reasons)
  return {
    classification: classificationFrom(sorted),
    reasons: sorted,
    files: outputFiles.sort((a, b) => compareStrings(a.path, b.path)),
    routes: {
      added: addedRoutes.map((r) => ({ key: r.key, path: r.path, entry: r.entry, hasChildren: hasChildren(r.key) })).sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.key, b.key)),
      affected: affected.list(hasChildren),
      disconnectedNewFiles: sortedUnique(disconnected),
    },
    dependencies: dependenciesBlock(input, outputFiles),
    risk: { ...risk, summary: { high: risk.files.filter((f) => f.level === 'high').length, medium: risk.files.filter((f) => f.level === 'medium').length, low: risk.files.filter((f) => f.level === 'low').length } },
    diagnostics: {
      unresolvedImports: graph.unresolved.map((u) => ({ ...u })),
      dynamicRoutes,
      parseErrors: graph.parseErrors,
    },
  }
}
