import { readdirSync } from 'node:fs'
import { posix } from 'node:path'
import { buildBackendTable, globalUses, type BackendTable } from '../backend/entrypoints.js'
import { compareStrings } from '../output/order.js'
import { ECOSYSTEM_FILES, LOCKFILES, MANIFESTS } from '../classify/dependencies.js'
import { createIgnoreMatcher, createInfraMatcher, createRoleMatcher, type AnalysisRole, type FileRole, type RoleMatcher } from '../classify/roles.js'
import { listFiles, readFiles } from '../git/index.js'
import { createTreeFileSystem, toPosix, type ProjectFileSystem } from '../project/fs.js'
import { buildImportGraph, type ImportGraph } from '../project/graph.js'
import { createProjectProgram, type ProjectProgram } from '../project/program.js'
import { resolveSpecifier, type ResolverContext } from '../project/resolve.js'
import { getRouteAdapter, type ModuleResolution, type RouteTable } from '../routes/index.js'
import type { Context } from './context.js'
import { UsageError } from '../config/load.js'
import { createDiskFileSystem } from './disk-fs.js'

export const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.graphql', '.gql'])

export interface Workspace {
  fs: ProjectFileSystem
  project: ProjectProgram
  graph: ImportGraph
  routes: RouteTable
  /** Repo-relative routes file, or the routes directory when `routesFromDirectory`. */
  routesFile: string
  /** File-system router (Next.js, TanStack Router, Expo Router): every route module under `routesFile` is a route of its own. */
  routesFromDirectory?: boolean
  /** Repo-relative paths of every file in the tree (git ref) — undefined for the working tree. */
  treeFiles?: string[]
  /** Backend entry points (surface "backend" only). */
  backend?: BackendTable
}

/** Repo-relative path → role, with files outside the project directory reported as `outside`. */
export function createRepoRoleOf(ctx: Context): (repoPath: string) => FileRole | 'outside' {
  const roleOf: RoleMatcher = createRoleMatcher(ctx.config)
  const isInfra = createInfraMatcher(ctx.config)
  return (repoPath) => {
    const rel = ctx.projectPrefix === '' ? repoPath : posix.relative(ctx.projectPrefix, repoPath)
    if (rel.startsWith('../') || rel === '..') {
      // Global globs may name files above the project (e.g. "../../pnpm-lock.yaml" in a monorepo); infrastructure
      // usually lives at the repository root.
      if (roleOf(rel) === 'global') return 'global'
      return isInfra(repoPath) ? 'infra' : 'outside'
    }
    const role = roleOf(rel)
    // Infrastructure comes after global, routes, tests and stories, before the code roles.
    return (role === 'source' || role === 'barrel' || role === 'i18n' || role === 'excluded') && isInfra(repoPath) ? 'infra' : role
  }
}

function projectRelative(ctx: Context, repoPath: string): string {
  return ctx.projectPrefix === '' ? repoPath : posix.relative(ctx.projectPrefix, repoPath)
}

/** Whether a changed file is left out by "ignore" (configuration) or --ignore globs. */
export function createIgnoreOf(ctx: Context, extra: readonly string[], base: readonly string[] = ctx.config.ignore): (repoPath: string) => boolean {
  const ignored = createIgnoreMatcher([...base, ...extra])
  return (repoPath) => ignored(projectRelative(ctx, repoPath), repoPath)
}

/**
 * Roles with dependency files on top of the configuration: a package.json in the project, in a directory above it, or
 * in a workspace package the project imports is a `manifest`; a lockfile in the project or above it is a `lockfile`.
 */
export function createAnalysisRoleOf(ctx: Context, graphNodes: readonly string[], backend?: BackendTable): (repoPath: string) => AnalysisRole | 'outside' {
  const config = createRepoRoleOf(ctx)
  const base = (repoPath: string): AnalysisRole | 'outside' => {
    const role = config(repoPath)
    if (!backend || (role !== 'source' && role !== 'barrel')) return role
    if (backend.resolverFiles.has(repoPath)) return 'resolvers'
    return backend.schemaFiles.has(repoPath) ? 'schema' : role
  }
  const prefix = ctx.projectPrefix
  const nodeDirs = new Set<string>()
  for (const node of graphNodes) for (let d = posix.dirname(node); d !== '.' && !nodeDirs.has(d); d = posix.dirname(d)) nodeDirs.add(d)
  return (repoPath) => {
    const name = posix.basename(repoPath)
    const dir = posix.dirname(repoPath) === '.' ? '' : posix.dirname(repoPath)
    const inside = prefix === '' || dir === prefix || dir.startsWith(`${prefix}/`)
    // Above the project (a monorepo root), only the files of the project's own ecosystem: a bun.lock at the root of
    // a repository is no dependency of its Python backend.
    const aboveOrSelf = dir === '' || dir === prefix || prefix.startsWith(`${dir}/`)
    const ours = inside || ECOSYSTEM_FILES[ctx.config.language].has(name)
    if (MANIFESTS.has(name) && ours && (aboveOrSelf || inside || nodeDirs.has(dir))) return 'manifest'
    if (LOCKFILES.has(name) && ours && (aboveOrSelf || inside)) return 'lockfile'
    return base(repoPath)
  }
}

/** Absolute path ↔ repo-relative helpers. */
export function toRepoPath(ctx: Context, absolute: string): string {
  return posix.relative(toPosix(ctx.repoRoot), toPosix(absolute))
}

export function projectToRepoPath(ctx: Context, projectPath: string): string {
  return posix.normalize(posix.join(ctx.projectPrefix, toPosix(projectPath)))
}

/** File system of a git ref (prefetched in one batch) or of the working tree when `ref` is undefined. */
export async function createFileSystem(ctx: Context, ref: string | undefined): Promise<{ fs: ProjectFileSystem; treeFiles?: string[] }> {
  const disk = createDiskFileSystem()
  if (ref === undefined) return { fs: disk }
  const treeFiles = await listFiles(ctx.repoRoot, ref)
  const wanted = treeFiles.filter((f) => SOURCE_EXTENSIONS.has(posix.extname(f)))
  const contents = await readFiles(ctx.repoRoot, ref, wanted)
  return { fs: createTreeFileSystem({ repoRoot: ctx.repoRoot, files: treeFiles, contents, fallback: disk }), treeFiles }
}

export function moduleResolver(ctx: Context, resolver: ResolverContext): (specifier: string, fromFile: string) => ModuleResolution {
  const repoRoot = toPosix(ctx.repoRoot)
  return (specifier, fromFile) => {
    const r = resolveSpecifier(resolver, repoRoot, posix.join(repoRoot, fromFile), specifier, undefined)
    if (r.kind === 'module' || r.kind === 'asset') return { kind: 'module', file: posix.relative(repoRoot, r.file) }
    if (r.kind === 'external') return { kind: 'external', specifier }
    return { kind: 'unresolved' }
  }
}

/** Extracts the route table with the configured adapter, reading other modules from `fs`. `files` lists the routes directory (file-system routers). */
export function extractRoutes(ctx: Context, resolver: ResolverContext, routesFile: string, code: string, files: readonly string[] = []): RouteTable {
  const repoRoot = toPosix(ctx.repoRoot)
  return getRouteAdapter(ctx.config.routes.adapter).extract({
    file: routesFile,
    code,
    files,
    resolve: moduleResolver(ctx, resolver),
    read: (file) => resolver.fs.readFile(posix.join(repoRoot, file)),
  })
}

/** Whether the configured router reads a directory (Next.js, TanStack Router, Expo Router) rather than one routes file. */
export function routesFromDirectory(ctx: Context): boolean {
  return getRouteAdapter(ctx.config.routes.adapter).source === 'directory'
}

/** Repo-relative routes directory of a file-system router ('' for the repository root). */
export function routesDirectory(ctx: Context): string {
  const dir = posix.normalize(posix.join(ctx.projectPrefix, ctx.config.routes.dir ?? ''))
  return dir === '.' ? '' : dir
}

/** Files under a repo-relative directory ('' for every file), sorted. */
export function filesUnder(files: readonly string[], dir: string): string[] {
  return files.filter((f) => dir === '' || f.startsWith(`${dir}/`)).sort(compareStrings)
}

export class RoutesFileMissingError extends Error {
  constructor(file: string, ref: string | undefined) {
    super(`routes file not found at ${file}${ref === undefined ? '' : ` in ${ref}`}; adjust routes.file in the configuration`)
    this.name = 'RoutesFileMissingError'
  }
}

/** Builds the program, import graph and route table of the project at a ref (or the working tree). */
export async function loadWorkspace(ctx: Context, ref: string | undefined, timings?: Record<string, number>, now: () => number = () => performance.now()): Promise<Workspace> {
  if (ctx.config.language !== 'typescript') throw new UsageError('internal: the TypeScript workspace was asked for a Go or Python project')
  let t = now()
  const lap = (name: string): void => {
    const current = now()
    if (timings) timings[name] = Math.round(current - t)
    t = current
  }
  const { fs, treeFiles } = await createFileSystem(ctx, ref)
  lap('readTree')
  const projectDir = toPosix(ctx.projectDir)
  if (ctx.config.surface === 'backend') return loadBackendWorkspace(ctx, fs, treeFiles, lap)
  if (routesFromDirectory(ctx)) return loadDirectoryRoutesWorkspace(ctx, fs, treeFiles, lap)
  const routesAbs = posix.join(projectDir, ctx.config.routes.file)
  const routesCode = fs.readFile(routesAbs)
  if (routesCode === undefined) throw new RoutesFileMissingError(ctx.config.routes.file, ref)
  const project = createProjectProgram({ fs, projectDir, tsconfigPath: posix.join(projectDir, ctx.config.tsconfig), anchorFile: routesAbs })
  lap('program')
  const roleOf = createRepoRoleOf(ctx)
  const graph = buildImportGraph(project, {
    repoRoot: ctx.repoRoot,
    isOrigin: (path) => {
      const role = roleOf(path)
      return role !== 'test' && role !== 'story' && role !== 'excluded'
    },
  })
  lap('graph')
  const routes = extractRoutes(ctx, project, toRepoPath(ctx, routesAbs), routesCode)
  lap('routes')
  return { fs, project, graph, routes, routesFile: toRepoPath(ctx, routesAbs), ...(treeFiles ? { treeFiles } : {}) }
}

/** Frontend workspace of a file-system router: the route table comes from the files of the routes directory. */
function loadDirectoryRoutesWorkspace(ctx: Context, fs: ProjectFileSystem, treeFiles: string[] | undefined, lap: (name: string) => void): Workspace {
  const projectDir = toPosix(ctx.projectDir)
  const repoRoot = toPosix(ctx.repoRoot)
  const dir = routesDirectory(ctx)
  const files = filesUnder(treeFiles ?? diskFiles(projectDir, repoRoot), dir)
  const project = createProjectProgram({ fs, projectDir, tsconfigPath: posix.join(projectDir, ctx.config.tsconfig) })
  lap('program')
  const roleOf = createRepoRoleOf(ctx)
  const graph = buildImportGraph(project, {
    repoRoot: ctx.repoRoot,
    isOrigin: (path) => {
      const role = roleOf(path)
      return role !== 'test' && role !== 'story' && role !== 'excluded'
    },
  })
  lap('graph')
  const routes = extractRoutes(ctx, project, dir, '', files)
  lap('routes')
  return { fs, project, graph, routes, routesFile: dir, routesFromDirectory: true, ...(treeFiles ? { treeFiles } : {}) }
}

/** Every repo-relative file of the project directory on disk (working tree mode, where no git listing exists). */
function diskFiles(dir: string, repoRoot: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = posix.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(posix.relative(repoRoot, full))
    }
  }
  walk(dir)
  return out
}

/** Context globs are written relative to the project; the table works with repo-relative paths. */
function projectGlobs(ctx: Context, context: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(context).map(([k, globs]) => [k, globs.map((g) => (ctx.projectPrefix === '' ? g : `${ctx.projectPrefix}/${g}`))]))
}

/** Backend workspace: the same program and import graph, with GraphQL operations and REST endpoints as entry points. */
function loadBackendWorkspace(ctx: Context, fs: ProjectFileSystem, treeFiles: string[] | undefined, lap: (name: string) => void): Workspace {
  const projectDir = toPosix(ctx.projectDir)
  const repoRoot = toPosix(ctx.repoRoot)
  const project = createProjectProgram({ fs, projectDir, tsconfigPath: posix.join(projectDir, ctx.config.tsconfig) })
  lap('program')
  const roleOf = createRepoRoleOf(ctx)
  const isOrigin = (path: string): boolean => {
    const role = roleOf(path)
    return role !== 'test' && role !== 'story' && role !== 'excluded' && role !== 'outside'
  }
  const graph = buildImportGraph(project, { repoRoot: ctx.repoRoot, isOrigin: (path) => isOrigin(path) || roleOf(path) === 'outside' })
  lap('graph')
  const files = (treeFiles ?? diskFiles(projectDir, repoRoot)).filter((f) => ctx.projectPrefix === '' || f.startsWith(`${ctx.projectPrefix}/`))
  const backend = buildBackendTable({ project, repoRoot, files, read: (f) => fs.readFile(posix.join(repoRoot, f)), isOrigin, graphql: ctx.config.backend.graphql, rest: ctx.config.backend.rest, cli: ctx.config.backend.cli, context: projectGlobs(ctx, ctx.config.backend.context) })
  // A global set with `global.X = …` (service locators such as `Core`) is an import of its module for every reader.
  const rel = (fileName: string): string => posix.relative(repoRoot, toPosix(fileName))
  const isProjectFile = (fileName: string): boolean => toPosix(fileName).startsWith(`${repoRoot}/`) && !toPosix(fileName).includes('/node_modules/')
  const extra = globalUses(project, backend.globals, rel, isProjectFile)
  if (extra.length > 0) {
    const nodes = new Set(graph.nodes)
    for (const e of extra) {
      graph.edges.push({ from: e.from, to: e.to, kind: 'static' })
      nodes.add(e.to)
    }
    graph.nodes = [...nodes].sort(compareStrings)
    graph.edges.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.kind, b.kind))
  }
  // Invalid SDL is a syntax error of its file (unknown when the file changed).
  for (const p of backend.problems) if (p.detail.startsWith('invalid GraphQL')) graph.parseErrors.push({ file: p.file, line: p.line, message: p.detail })
  lap('routes')
  return { fs, project, graph, routes: { routes: backend.operations, dynamic: [], sources: [] }, routesFile: '', backend, ...(treeFiles ? { treeFiles } : {}) }
}
