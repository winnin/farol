import { readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { classify } from '../classify/classify.js'
import { contextDiff, diffFiles, isAncestor, listFiles, mergeBase, originUrl, readFiles, resolveCommit } from '../git/index.js'
import { suggestReviewers } from './reviewers.js'
import { limitDiffs } from '../review/diffs.js'
import type { ChangedFile } from '../git/types.js'
import { buildOutput, failureOutput, type OutputMeta } from '../output/build.js'
import type { Output } from '../output/schema.js'
import { serializeOutput, writeTextFile } from '../output/write.js'
import { createTreeFileSystem, toPosix } from '../project/fs.js'
import { TS_FILE } from '../project/parse.js'
import { createResolverContext } from '../project/resolve.js'
import type { RouteTable } from '../routes/types.js'
import { computeSignals, computeUsage, type SignalInputs } from './signals.js'
import { backendImpacts } from './backend.js'
import type { Context } from './context.js'
import { createDiskFileSystem } from './disk-fs.js'
import { defaultCacheDir, loadLangWorkspace, readToml } from './lang-workspace.js'
import { diffPyproject, diffRequirementsTxt } from '../python/pyproject.js'
import { UsageError } from '../config/load.js'
import { EXIT_FAILURE, EXIT_OK, writeStdout } from './run.js'
import { createAnalysisRoleOf, createIgnoreOf, extractRoutes, filesUnder, loadWorkspace, SOURCE_EXTENSIONS, type Workspace } from './workspace.js'
import { diffManifest, ECOSYSTEM_FILES, MANIFESTS, ManifestParseError, type ManifestResult } from '../classify/dependencies.js'
import { isTypeOnlyModule } from '../classify/additive.js'
import { isDeclarationsOnlyModule, isScriptFile } from '../classify/declarations-only.js'
import { contractsSection, helperContractChanges } from '../contracts/entries.js'
import { diffGoMod } from '../golang/gomod.js'
import { baseDecls, tsDeclGraph } from '../project/decls.js'
import { declImpacts } from '../decls/impact.js'
import { createGeneratedMatcher, type AnalysisRole } from '../classify/roles.js'
import { KEY_SEPARATOR } from '../routes/paths.js'

export interface AnalyzeOptions {
  base: string
  head: string
  coverage?: string
  eslint?: string
  out?: string
  /** Extra "ignore" globs from the command line. */
  ignore?: string[]
  /** Pull request number (defaults to the one of the GitHub Actions event). */
  pr?: number
  /** Extra globs of files left out of diff coverage only. */
  coverageIgnore?: string[]
  /** npm/pnpm audit --json report. */
  audit?: string
  /** Traffic report written by `farol usage`. */
  usage?: string
  /** Incremental mode: analyze only the changes since this ref (e.g. the head of the last review). */
  since?: string
  /** Suggest reviewers (CODEOWNERS and git history of the changed files). */
  reviewers?: boolean
  /** Go/Python helper outputs kept between runs here (default ~/.cache/farol); false disables the cache. */
  cacheDir?: string
  cache?: boolean
}

export interface AnalyzeDeps {
  /** Wall clock for analyzedAt. */
  now: () => Date
  /** Monotonic clock in ms for timings. */
  clock: () => number
  env: NodeJS.ProcessEnv
}

/** PR number of the GitHub Actions `pull_request` event, when farol runs in one. */
export function prFromEvent(env: NodeJS.ProcessEnv): number | null {
  const path = env.GITHUB_EVENT_PATH
  if (!path) return null
  try {
    const event = JSON.parse(readFileSync(path, 'utf8')) as { pull_request?: { number?: unknown }; number?: unknown }
    const n = event.pull_request?.number ?? event.number
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
  } catch {
    // No readable event (not in Actions, or not a PR event): links fall back to the compare view.
    return null
  }
}

export const realDeps = (): AnalyzeDeps => ({ now: () => new Date(), clock: () => performance.now(), env: process.env })

/** owner/name from GITHUB_REPOSITORY or a GitHub remote URL; null when unknown. */
export function repoName(env: NodeJS.ProcessEnv, remote: string | null): string | null {
  const fromEnv = env.GITHUB_REPOSITORY?.trim()
  if (fromEnv) return fromEnv
  if (remote === null) return null
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote)
  return match ? `${match[1] ?? ''}/${match[2] ?? ''}` : null
}

const COMPARED_ROLES = new Set(['routes', 'barrel', 'i18n'])

/** Modified files whose base and head contents the additive rules compare. */
function comparedFiles(files: readonly ChangedFile[], roleOf: (path: string) => AnalysisRole | 'outside'): string[] {
  return files.filter((f) => f.status === 'modified' && COMPARED_ROLES.has(roleOf(f.path))).map((f) => f.path)
}

/** Base path of the routes file when any file the route table is read from changed; undefined when none did. */
function changedRoutesBase(files: readonly ChangedFile[], ws: Workspace): string | undefined {
  if (ws.routesFromDirectory) {
    // File-system routers: any file added, removed or changed under the routes directory may add or remove a route.
    const under = (p: string | undefined): boolean => p !== undefined && (ws.routesFile === '' || p.startsWith(`${ws.routesFile}/`))
    return files.some((f) => under(f.path) || under(f.oldPath)) ? ws.routesFile : undefined
  }
  const sources = new Set([ws.routesFile, ...ws.routes.sources])
  const touched = files.some((f) => f.status !== 'added' && (sources.has(f.path) || (f.oldPath !== undefined && sources.has(f.oldPath))))
  if (!touched) return undefined
  return files.find((f) => f.path === ws.routesFile && f.status === 'renamed')?.oldPath ?? ws.routesFile
}

async function baseRouteTable(ctx: Context, ws: Workspace, mergeBaseSha: string, basePath: string): Promise<RouteTable> {
  const files = await listFiles(ctx.repoRoot, mergeBaseSha)
  const routeFiles = ws.routesFromDirectory ? filesUnder(files, basePath) : []
  if (ws.routesFromDirectory ? routeFiles.length === 0 : !files.includes(basePath)) return { routes: [], dynamic: [], sources: [] }
  // The table may be split across modules: every source file of the base is readable, as in the head.
  const contents = await readFiles(ctx.repoRoot, mergeBaseSha, files.filter((f) => SOURCE_EXTENSIONS.has(posix.extname(f)) || f === basePath))
  const code = ws.routesFromDirectory ? '' : contents.get(basePath)
  if (code === undefined) throw new Error(`internal: base content of ${basePath} was not read`)
  const fs = createTreeFileSystem({ repoRoot: ctx.repoRoot, files, contents, fallback: createDiskFileSystem() })
  // Module resolution of the base uses the head compiler options: a tsconfig change is a global change anyway.
  const resolver = createResolverContext({ fs, options: ws.project.options, configPath: ws.project.configPath, projectDir: toPosix(ctx.projectDir) })
  return extractRoutes(ctx, resolver, basePath, code, routeFiles)
}

/** Dependency diff of every selected changed manifest, from its base and head contents. */
async function manifestDiffs(ctx: Context, files: readonly ChangedFile[], select: (path: string) => boolean, baseSha: string, headSha: string): Promise<ManifestResult[]> {
  const manifests = files.filter((f) => select(f.path))
  const base = await readFiles(ctx.repoRoot, baseSha, manifests.map((f) => f.oldPath ?? f.path))
  const head = await readFiles(ctx.repoRoot, headSha, manifests.map((f) => f.path))
  return Promise.all(manifests.map(async (f) => {
    try {
      const before = f.status === 'added' ? null : (base.get(f.oldPath ?? f.path) ?? null)
      const after = f.status === 'deleted' ? null : (head.get(f.path) ?? null)
      const name = posix.basename(f.path)
      if (name === 'pyproject.toml') return diffPyproject(f.path, before === null ? null : await parseToml(before), after === null ? null : await parseToml(after))
      if (name === 'requirements.txt') return diffRequirementsTxt(f.path, before, after)
      return (name === 'go.mod' ? diffGoMod : diffManifest)(f.path, before, after)
    } catch (error) {
      if (error instanceof ManifestParseError) return { manifest: f.path, error: error.message }
      throw error
    }
  }))
}

/**
 * Diffs of the project's manifests, and of the changed manifests of its ecosystem outside it (other projects of a
 * monorepo): those a lockfile covers explain its change without making this project's own dependencies change.
 */
async function projectAndOtherManifests(ctx: Context, files: readonly ChangedFile[], roleOf: (path: string) => AnalysisRole | 'outside', baseSha: string, headSha: string): Promise<{ manifests: ManifestResult[]; otherManifests: ManifestResult[] }> {
  const ecosystem = ECOSYSTEM_FILES[ctx.config.language]
  const isOther = (path: string): boolean => {
    const name = posix.basename(path)
    return roleOf(path) === 'outside' && MANIFESTS.has(name) && ecosystem.has(name)
  }
  const [manifests, otherManifests] = await Promise.all([manifestDiffs(ctx, files, (p) => roleOf(p) === 'manifest', baseSha, headSha), manifestDiffs(ctx, files, isOther, baseSha, headSha)])
  return { manifests, otherManifests }
}

/** pyproject.toml parsed by Python's tomllib; a file it rejects is a parse error of the manifest. */
async function parseToml(text: string): Promise<unknown> {
  try {
    return await readToml(text)
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new ManifestParseError(`invalid TOML: ${(error instanceof Error ? error.message : String(error)).split('\n').slice(-1)[0] ?? ''}`)
  }
}

function reportPath(ctx: Context, flag: string | undefined, configured: string | undefined): string | undefined {
  if (flag !== undefined) return resolve(flag)
  return configured === undefined ? undefined : resolve(ctx.projectDir, configured)
}

/** Runs the whole pipeline. Never throws for analysis failures: they produce an `unknown` output with the error. */
export async function runAnalyze(ctx: Context, options: AnalyzeOptions, deps: AnalyzeDeps): Promise<{ output: Output; failed: boolean }> {
  const timings: Record<string, number> = {}
  let t = deps.clock()
  const lap = (name: string): void => {
    const now = deps.clock()
    timings[name] = Math.max(0, Math.round(now - t))
    t = now
  }
  const meta: OutputMeta = {
    repo: repoName(deps.env, await originUrl(ctx.repoRoot)),
    surface: ctx.config.surface,
    pr: options.pr ?? prFromEvent(deps.env),
    base: { ref: options.base, sha: null },
    mergeBase: null,
    head: { ref: options.head, sha: null },
    analyzedAt: deps.now(),
    timingsMs: timings,
    ignoredFiles: [],
  }
  try {
    meta.base.sha = await resolveCommit(ctx.repoRoot, options.base)
    meta.head.sha = await resolveCommit(ctx.repoRoot, options.head)
    let mb = await mergeBase(ctx.repoRoot, meta.base.sha, meta.head.sha)
    if (options.since !== undefined) {
      // Incremental: everything since the last reviewed commit; after a force-push, since its merge-base with head.
      const since = await resolveCommit(ctx.repoRoot, options.since)
      mb = (await isAncestor(ctx.repoRoot, since, meta.head.sha)) ? since : await mergeBase(ctx.repoRoot, since, meta.head.sha)
      if (mb !== since) ctx.log(`--since ${since.slice(0, 12)} is not an ancestor of head (rebased?): using their merge-base ${mb.slice(0, 12)}`)
      meta.incremental = { since: mb }
    }
    meta.mergeBase = mb
    const ignoredOf = createIgnoreOf(ctx, options.ignore ?? [])
    const allFiles = await diffFiles(ctx.repoRoot, mb, meta.head.sha)
    // A rename stays when one of its paths is not ignored: code that leaves for an ignored path is still gone.
    const files = allFiles.filter((f) => !ignoredOf(f.path) || (f.oldPath !== undefined && !ignoredOf(f.oldPath)))
    meta.ignoredFiles = allFiles.filter((f) => !files.includes(f)).map((f) => f.path)
    lap('diff')
    ctx.log(`${files.length} changed file(s) between ${mb.slice(0, 12)} and ${meta.head.sha.slice(0, 12)}`)

    const wsTimings: Record<string, number> = {}
    let result: ReturnType<typeof classify>
    let roleOf: (path: string) => AnalysisRole | 'outside'
    let readHead: (path: string) => string | undefined
    let headExists: (path: string) => boolean
    let lang: SignalInputs['lang']
    let headRoutes: RouteTable
    let contracts: Output['contracts']
    if (ctx.config.language !== 'typescript') {
      const baseRole = createAnalysisRoleOf(ctx, [])
      const ext = ctx.config.language === 'go' ? '.go' : '.py'
      const cache = options.cache === false ? null : resolve(options.cacheDir ?? defaultCacheDir(deps.env))
      const langWs = await loadLangWorkspace(ctx, files, mb, meta.head.sha, (p) => p.endsWith(ext) && baseRole(p) === 'source', wsTimings, deps.clock, cache)
      Object.assign(timings, wsTimings)
      t = deps.clock()
      roleOf = createAnalysisRoleOf(ctx, langWs.graph.nodes)
      const { manifests, otherManifests } = await projectAndOtherManifests(ctx, files, roleOf, mb, meta.head.sha)
      const headContents = await readFiles(ctx.repoRoot, meta.head.sha, files.filter((f) => f.status !== 'deleted').map((f) => f.path))
      const headFiles = new Set(await listFiles(ctx.repoRoot, meta.head.sha))
      readHead = (path) => headContents.get(path)
      headExists = (path) => headFiles.has(path)
      lang = { language: ctx.config.language, module: langWs.head.module, comments: langWs.head.comments }
      headRoutes = langWs.headRoutes
      const helperContracts = helperContractChanges(langWs.base, langWs.head)
      contracts = contractsSection(helperContracts.changes, helperContracts.readable)
      lap('base')
      result = classify({ files, roleOf, isGenerated: () => false, manifests, otherManifests, backend: { impacts: langWs.impacts }, graph: langWs.graph, routesFile: '', headRoutes: langWs.headRoutes, baseRoutes: langWs.baseRoutes, baseText: new Map(), headText: new Map() })
    } else {
      const ws = await loadWorkspace(ctx, meta.head.sha, wsTimings, deps.clock)
      headRoutes = ws.routes
      Object.assign(timings, wsTimings)
      t = deps.clock()
      roleOf = createAnalysisRoleOf(ctx, ws.graph.nodes, ws.backend)
      readHead = (path) => ws.fs.readFile(posix.join(toPosix(ctx.repoRoot), path))
      headExists = (path) => ws.fs.fileExists(posix.join(toPosix(ctx.repoRoot), path))
      const compared = comparedFiles(files, roleOf)
      const baseText = await readFiles(ctx.repoRoot, mb, compared)
      const headText = await readFiles(ctx.repoRoot, meta.head.sha, compared)
      let baseRoutes: RouteTable | null = null
      let backend: Awaited<ReturnType<typeof backendImpacts>> | undefined
      if (ws.backend) {
        backend = await backendImpacts(ctx, ws.backend, files, roleOf, mb, meta.head.sha)
        baseRoutes = backend.baseRoutes
        contracts = contractsSection(backend.contracts.changes, ws.backend.operations.filter((o) => !o.key.includes(' ')).length, backend.contracts.problem)
      } else {
        const routesBase = changedRoutesBase(files, ws)
        baseRoutes = routesBase === undefined ? null : await baseRouteTable(ctx, ws, mb, routesBase)
      }
      const { manifests, otherManifests } = await projectAndOtherManifests(ctx, files, roleOf, mb, meta.head.sha)
      const entryFiles = new Set(ws.backend?.configEntries.values())
      const isCode = (path: string): boolean => roleOf(path) === 'source' || entryFiles.has(path)
      const tsModified = files.filter((f) => f.status === 'modified' && isCode(f.path) && TS_FILE.test(f.path)).map((f) => f.path)
      const tsBase = await readFiles(ctx.repoRoot, mb, tsModified)
      const tsHead = await readFiles(ctx.repoRoot, meta.head.sha, tsModified)
      const typeOnlyFiles = new Set(tsModified.filter((p) => isTypeOnlyModule(p, tsBase.get(p) ?? 'x', ws.project.options) && isTypeOnlyModule(p, tsHead.get(p) ?? 'x', ws.project.options)))
      // Declaration-level reach of changed TypeScript source files (renamed files keep the file graph: their
      // declaration ids change with the path). JavaScript keeps the file graph too: CommonJS and
      // globals (global.X = require(...)) are only followed there. Type-only files keep their own rule.
      // Frontends only: backends (often CommonJS with globals set at bootstrap) keep the file graph and the
      // resolver-level impacts, which follow globals the declaration graph would merge into the bootstrap code.
      const declChanged = ws.backend ? [] : files.filter((f) => f.status !== 'renamed' && roleOf(f.path) === 'source' && TS_FILE.test(f.path) && !typeOnlyFiles.has(f.path))
      const declBaseText = await readFiles(ctx.repoRoot, mb, declChanged.filter((f) => f.status !== 'added').map((f) => f.oldPath ?? f.path))
      const head = declChanged.length === 0 ? { module: '', files: [], decls: [], edges: [], entries: [], problems: [], comments: [] } : tsDeclGraph({ project: ws.project, repoRoot: toPosix(ctx.repoRoot), isOrigin: (p) => { const r = roleOf(p); return r !== 'test' && r !== 'story' && r !== 'excluded' && r !== 'outside' }, routes: ws.routes })
      const baseOut = { module: '', files: [], decls: [...declBaseText].flatMap(([p, code]) => baseDecls(p, code)), edges: [], entries: [], problems: [], comments: [] }
      const existing = new Set((baseRoutes ?? ws.routes).routes.map((r) => r.key))
      const declImpactMap = declImpacts(baseOut, head, declChanged, () => true, { existing, erasedTypes: true })
      lap('base')
      result = classify({ files, roleOf, isGenerated: createGeneratedMatcher(ctx.config.generated, ctx.projectPrefix, ctx.config.generated.length === 0 ? [] : await listFiles(ctx.repoRoot, meta.head.sha)), manifests, otherManifests, typeOnlyFiles, declImpacts: declImpactMap, ...(backend && ws.backend ? { backend: { impacts: backend.impacts, configEntries: ws.backend.configEntries } } : {}), graph: ws.graph, routesFile: ws.routesFile, ...(ws.routesFromDirectory ? { routesFromDirectory: true } : {}), headRoutes: ws.routes, baseRoutes, baseText, headText })
    }
    // Added files that only declare things weigh almost nothing in the merge score.
    for (const f of result.files) if (f.status === 'added' && (f.role === 'source' || f.role === 'barrel') && isScriptFile(f.path) && isDeclarationsOnlyModule(f.path, readHead(f.path) ?? 'x(')) f.declarationsOnly = true
    lap('classify')
    const signalInputs: SignalInputs = {
      files,
      roleOf,
      // Flags are relative to the current directory, configuration paths to the project directory.
      coverage: reportPath(ctx, options.coverage, ctx.config.signals.coverage),
      eslint: reportPath(ctx, options.eslint, ctx.config.signals.eslint),
      readHead,
      headExists,
      ...(lang ? { lang } : {}),
      coverageIgnored: createIgnoreOf(ctx, options.coverageIgnore ?? [], ctx.config.signals.coverageIgnore),
      audit: reportPath(ctx, options.audit, ctx.config.signals.audit),
      changedPackages: new Set(result.dependencies.changes.filter((c) => c.change !== 'removed').map((c) => c.name)),
    }
    const signals = computeSignals(ctx, signalInputs)
    const keys = headRoutes.routes.map((r) => r.key)
    const usage = computeUsage(reportPath(ctx, options.usage, ctx.config.signals.usage), {
      surface: ctx.config.surface,
      entries: headRoutes.routes.map((r) => ({ key: r.key, path: r.path, hasChildren: keys.some((k) => k.startsWith(`${r.key}${KEY_SEPARATOR}`)) })),
      affected: result.routes.affected.map((r) => r.key),
      changedFiles: files.map((f) => f.path),
      callersOf: (contracts?.entries ?? []).map((e) => e.key),
    })
    if (usage) meta.usage = usage
    if (contracts) meta.contracts = contracts
    lap('signals')
    // Inline diffs for the report: code files, riskiest first (the risk table order), then the others.
    const codeRoles = new Set(['source', 'resolvers', 'schema', 'routes', 'barrel', 'i18n', 'global', 'infra'])
    const shown = result.files.filter((f) => codeRoles.has(f.role) && !files.find((c) => c.path === f.path)?.binary).map((f) => f.path)
    const order = [...result.risk.files.map((f) => f.path).filter((p) => shown.includes(p)), ...shown.filter((p) => !result.risk.files.some((f) => f.path === p))]
    meta.diffs = limitDiffs(await contextDiff(ctx.repoRoot, mb, meta.head.sha, order), order)
    lap('diffs')
    if (options.reviewers === true) {
      meta.reviewers = await suggestReviewers(ctx, files, roleOf, mb, meta.head.sha)
      lap('reviewers')
    }
    ctx.log(`classification: ${result.classification}`)
    return { output: buildOutput(meta, result, signals), failed: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.log(`analysis failed: ${message}`)
    return { output: failureOutput(meta, message), failed: true }
  }
}

export async function analyzeCommand(ctx: Context, options: AnalyzeOptions, deps: AnalyzeDeps = realDeps()): Promise<number> {
  const { output, failed } = await runAnalyze(ctx, options, deps)
  const text = serializeOutput(output)
  if (options.out === undefined) await writeStdout(text)
  else writeTextFile(resolve(options.out), text)
  if (failed) process.stderr.write(`farol: analysis failed: ${output.diagnostics.error ?? 'unknown error'}\n`)
  return failed ? EXIT_FAILURE : EXIT_OK
}
