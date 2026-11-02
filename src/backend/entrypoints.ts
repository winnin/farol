import ts from 'typescript'
import type { DocumentNode } from 'graphql'
import { posix } from 'node:path'
import { compareStrings, sortedUnique } from '../output/order.js'
import { isProjectPath } from '../project/fs.js'
import type { ProjectProgram } from '../project/program.js'
import type { DynamicRoute, RouteEntry } from '../routes/types.js'
import { definedGlobals, usesGlobal } from './globals.js'
import { honoApps, UNRESOLVED_APP } from './hono.js'
import { keyPath, prefixKey, underPath } from './hono-paths.js'
import { restAnchor } from './rest.js'
import { ENUM_MARKER, entryNodes, resolverAnchors } from './resolvers.js'
import picomatch from 'picomatch'
import { buildSchemaGraph, operationsOf, parseSdl, sdlSources, type SdlProblem } from './schema.js'

/** The entry points of a backend, in the same shape as a route table: one entry per operation or endpoint. */
export interface BackendTable {
  /** GraphQL root operations, REST endpoints and `backend.entries`; `modules` are the modules they use. */
  operations: RouteEntry[]
  /**
   * For each operation, the resolver keys it can run (its own and those of every type it can return). REST endpoints
   * run handler anchors (`restAnchor`: file and path as written); a factory mounted N times gives N endpoints.
   */
  resolverKeys: Map<string, Set<string>>
  /** For each GraphQL operation, the types it can return. */
  operationTypes: Map<string, Set<string>>
  /** Root operation type names. */
  rootTypes: Set<string>
  /** Entry point keys named in `backend.entries`, with their files. */
  configEntries: ReadonlyMap<string, string>
  /** Every type name of the schema (to recognize resolver maps). */
  typeNames: Set<string>
  /** Fields of each type: a resolver map member must name a real field. */
  typeFields: Map<string, Set<string>>
  /** Files with resolver maps or REST handlers, and files with SDL. */
  resolverFiles: Set<string>
  schemaFiles: Set<string>
  /** Every SDL document of the head, with its file (the schema the contracts are compared on). */
  schemaDocs: { doc: DocumentNode; file: string }[]
  /** `global.X = …` assignments: global name → module. */
  globals: Map<string, string>
  problems: SdlProblem[]
  /** Hono constructs farol cannot follow: they make every PR `unknown`. */
  dynamic: DynamicRoute[]
  /** REST endpoint keys without the given mounts (`MountNode` ids) and handler anchors: the endpoints that existed before them. */
  restKeysWithout: (mounts: ReadonlySet<string>, anchors: ReadonlySet<string>) => Set<string>
  /** Full paths a Hono mount (`MountNode` id) serves; empty when farol cannot compute them. */
  mountBases: (id: string) => string[]
  /** Whether a Hono mount's sub-app registers middleware (it then runs for existing endpoints under its paths). */
  mountMiddleware: (id: string) => boolean
  /** Full endpoint keys a Hono mount (`MountNode` id) serves. */
  mountKeys: (id: string) => string[]
  /** Files that use Hono: their mounts are compared even without a hono import. */
  honoFiles: Set<string>
  /** Endpoints a change to a file's module code can hit: those under its Hono apps (no app: every Hono endpoint), and those using the file. */
  fileReachKeys: (file: string) => string[]
  /** Whether a file of the head creates, receives, holds or registers on a Hono app. */
  fileHoldsApp: (file: string) => boolean
}

export interface BackendInput {
  project: ProjectProgram
  repoRoot: string
  /** Repo-relative paths of every file of the head tree (for .graphql files the program does not contain). */
  files: readonly string[]
  read: (repoPath: string) => string | undefined
  /** Whether a repo-relative file counts (tests, stories, excluded and outside-project files do not). */
  isOrigin: (repoPath: string) => boolean
  graphql: boolean
  rest: boolean
  /** Context properties → provider file globs (repo-relative). */
  context: Readonly<Record<string, readonly string[]>>
  /** Entry point kinds → globs of the files that are entry points (repo-relative). */
  entries: Readonly<Record<string, readonly string[]>>
}

/** Each program file a glob of `backend.entries` matches is one entry point, which runs the modules the file names. */
function configuredEntries(byKind: BackendInput['entries'], programFiles: readonly ts.SourceFile[], rel: (fileName: string) => string, anchorsOf: (node: ts.Node) => string[]): (RouteEntry & { entry: string })[] {
  return Object.entries(byKind).flatMap(([kind, globs]) => {
    const match = picomatch([...globs], { dot: true })
    return programFiles.filter((sf) => match(rel(sf.fileName))).map((sf) => {
      const file = rel(sf.fileName)
      const key = `${kind} ${file}`
      return { key, path: key, index: false, entry: file, modules: anchorsOf(sf).filter((m) => m !== file), layouts: [] }
    })
  })
}

export function buildBackendTable(input: BackendInput): BackendTable {
  const root = input.repoRoot.replaceAll('\\', '/')
  const rel = (fileName: string): string => posix.relative(root, fileName.replaceAll('\\', '/'))
  const isProjectFile = (fileName: string): boolean => isProjectPath(root, fileName)
  const programFiles = input.project.program.getSourceFiles().filter((sf) => isProjectFile(sf.fileName) && !sf.isDeclarationFile && input.isOrigin(rel(sf.fileName)))

  // Schema: .graphql files of the tree and gql`…` templates of the program files.
  const problems: SdlProblem[] = []
  const docs: { doc: NonNullable<ReturnType<typeof parseSdl>['doc']>; file: string }[] = []
  const schemaFiles = new Set<string>()
  if (input.graphql) {
    const candidates = [...input.files.filter((f) => (f.endsWith('.graphql') || f.endsWith('.gql')) && input.isOrigin(f)), ...programFiles.map((sf) => rel(sf.fileName))]
    for (const file of sortedUnique(candidates)) {
      const code = input.read(file)
      if (code === undefined) continue
      const found = sdlSources(file, code)
      problems.push(...found.problems)
      for (const source of found.sources) {
        const parsed = parseSdl(source)
        if (parsed.problem) problems.push(parsed.problem)
        if (parsed.doc) {
          docs.push({ doc: parsed.doc, file })
          schemaFiles.add(file)
        }
      }
    }
  }
  const schema = buildSchemaGraph(docs)
  const typeNames = new Set<string>([...schema.fields.keys(), ...schema.possible.keys()])
  const typeFields = new Map([...schema.fields.entries()].map(([t, f]) => [t, new Set(f.keys())]))
  for (const t of schema.possible.keys()) if (!typeFields.has(t)) typeFields.set(t, new Set())
  for (const e of schema.enums) typeFields.set(e, new Set([ENUM_MARKER]))
  const operations = input.graphql ? operationsOf(schema) : []

  const globals = new Map<string, string>()
  for (const sf of programFiles) for (const name of definedGlobals(sf)) globals.set(name, rel(sf.fileName))

  // Context injection: `loaders.X…` → the provider whose directory or file name matches X, else every provider.
  const providers = new Map(
    Object.entries(input.context).map(([key, globs]) => {
      const match = picomatch([...globs], { dot: true })
      return [key, input.files.filter((f) => match(f))]
    }),
  )
  const contextOf = (chain: readonly string[]): string[] => {
    for (const [key, files] of providers) {
      const parts = key.split('.')
      for (let i = 0; i <= 1; i++) {
        if (parts.every((p, j) => chain[i + j] === p)) {
          const next = (chain[i + parts.length] ?? '').toLowerCase()
          const matching = files.filter((f) => f.toLowerCase().split('/').some((seg) => seg.replace(/\.[^.]+$/, '').replaceAll(/[-_]/g, '') === next.replaceAll(/[-_]/g, '')))
          return next !== '' && matching.length > 0 ? matching : files
        }
      }
    }
    return []
  }
  // Resolvers and REST handlers, with the modules their code uses.
  const checker = input.project.program.getTypeChecker()
  const anchorsOf = (node: ts.Node): string[] => resolverAnchors(node, checker, isProjectFile, rel, globals, contextOf)
  // REST handlers and middleware are often held in a variable of the same file (`const mw = create()`, `const { mw } = build()`).
  const argumentModules = (arg: ts.Node): string[] => {
    const own = arg.getSourceFile()
    const followed = new Set<ts.Node>([arg])
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node)
        let decl: ts.Node | undefined = symbol?.valueDeclaration
        while (decl && ts.isBindingElement(decl)) decl = decl.parent.parent
        const code = decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl && ts.isFunctionDeclaration(decl) ? decl : undefined
        if (code && code.getSourceFile() === own && !followed.has(code)) {
          followed.add(code)
          visit(code)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(arg)
    return [...followed].flatMap(anchorsOf)
  }
  const anchors = new Map<string, { file: string; modules: Set<string> }>()
  const handlers: { anchor: string; key: string; receiver: ts.Expression; node: ts.Node }[] = []
  const resolverFiles = new Set<string>()
  for (const sf of programFiles) {
    for (const entry of entryNodes(sf, typeFields, input.rest)) {
      const file = rel(sf.fileName)
      resolverFiles.add(file)
      const id = 'receiver' in entry ? restAnchor(file, entry.key) : entry.key
      if ('receiver' in entry) handlers.push({ anchor: id, key: entry.key, receiver: entry.receiver, node: entry.node })
      const anchor = anchors.get(id) ?? { file, modules: new Set<string>() }
      for (const m of 'receiver' in entry ? argumentModules(entry.value) : anchorsOf(entry.value)) if (m !== file) anchor.modules.add(m)
      for (const guard of 'receiver' in entry ? entry.guards : []) for (const m of argumentModules(guard)) if (m !== file) anchor.modules.add(m)
      anchors.set(id, anchor)
    }
  }
  // REST endpoints: the handler's path under every base path of its Hono app, or as written for other servers.
  const hono = input.rest ? honoApps(programFiles, checker, rel) : undefined
  for (const f of hono?.mountFiles ?? []) resolverFiles.add(f)
  const restKeys = (mounts?: ReadonlySet<string>, without?: ReadonlySet<string>): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>()
    for (const h of handlers) {
      if (without?.has(h.anchor)) continue
      const bases = hono?.basesOf(h.receiver, mounts)
      const keys = bases === undefined || bases === null ? [h.key] : bases.map((b) => prefixKey(h.key, b))
      for (const k of keys) out.set(k, (out.get(k) ?? new Set<string>()).add(h.anchor))
    }
    return out
  }
  // Middleware runs for the endpoints of Hono apps under its full paths; Express and Fastify paths are as written.
  const honoKeys = new Set(handlers.flatMap((h) => (hono?.basesOf(h.receiver) ?? []).map((b) => prefixKey(h.key, b))))
  const registrations = (hono?.registrations ?? []).map((reg) => ({ paths: reg.paths, modules: reg.args.flatMap(argumentModules) }))
  const dynamic = [...(hono?.dynamic ?? [])]
  for (const h of handlers) {
    const bases = hono?.basesOf(h.receiver)
    if (bases === null || bases?.length === 0) {
      const sf = h.node.getSourceFile()
      dynamic.push({ file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(h.node.getStart(sf)).line + 1, detail: bases === null ? UNRESOLVED_APP : 'Hono app is mounted only through a cycle' })
    }
  }

  const byType = new Map<string, string[]>()
  for (const key of anchors.keys()) {
    const type = key.includes('.') && !key.includes(' ') ? key.slice(0, key.indexOf('.')) : ''
    if (type !== '') byType.set(type, [...(byType.get(type) ?? []), key])
  }
  const resolverKeys = new Map<string, Set<string>>()
  const operationTypes = new Map<string, Set<string>>(operations.map((op) => [op.key, op.reachableTypes]))
  const entries: RouteEntry[] = []
  for (const op of operations) {
    const keys = new Set<string>([op.key, ...[...op.reachableTypes].flatMap((t) => byType.get(t) ?? [])].filter((k) => anchors.has(k)))
    resolverKeys.set(op.key, keys)
    const modules = sortedUnique([...keys].flatMap((k) => [...(anchors.get(k)?.modules ?? [])]))
    // The resolver file is not an anchor: only the code the resolvers run is (a resolver file often serves many operations).
    entries.push({ key: op.key, path: op.key, index: false, entry: null, modules, layouts: [] })
  }
  for (const [key, ids] of restKeys()) {
    resolverKeys.set(key, ids)
    const installed = honoKeys.has(key) ? registrations.filter((reg) => reg.paths.some((p) => underPath(keyPath(key), p))).flatMap((reg) => reg.modules) : []
    entries.push({ key, path: key, index: false, entry: null, modules: sortedUnique([...[...ids].flatMap((id) => [...(anchors.get(id)?.modules ?? [])]), ...installed]), layouts: [] })
  }
  const configured = configuredEntries(input.entries, programFiles, rel, anchorsOf)
  entries.push(...configured)
  entries.sort((a, b) => compareStrings(a.key, b.key))
  return {
    operations: entries,
    configEntries: new Map(configured.map((e) => [e.key, e.entry])),
    resolverKeys,
    operationTypes,
    rootTypes: new Set(Object.values(schema.roots)),
    typeNames,
    typeFields,
    resolverFiles,
    schemaFiles,
    schemaDocs: docs,
    globals,
    problems: problems.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line),
    dynamic: dynamic.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.detail, b.detail)),
    restKeysWithout: (mounts, without) => new Set(restKeys(mounts, without).keys()),
    mountBases: (id) => hono?.mountBases(id) ?? [],
    mountMiddleware: (id) => hono?.mountMiddleware(id) ?? false,
    mountKeys: (id) => sortedUnique(handlers.flatMap((h) => (hono?.basesThrough(h.receiver, id) ?? []).map((b) => prefixKey(h.key, b)))),
    honoFiles: hono?.honoFiles ?? new Set(),
    fileHoldsApp: (file) => (hono?.fileBases(file) ?? []).length > 0,
    fileReachKeys: (file) => {
      const bases = hono?.fileBases(file) ?? []
      const under = [...honoKeys].filter((k) => bases.length === 0 || bases.some((b) => underPath(keyPath(k), b)))
      return sortedUnique([...under, ...entries.filter((e) => e.modules.includes(file)).map((e) => e.key)])
    },
  }
}

/** Global edges for the import graph: every program file that reads a global points at the module defining it. */
export function globalUses(project: ProjectProgram, globals: ReadonlyMap<string, string>, rel: (fileName: string) => string, isProjectFile: (fileName: string) => boolean): { from: string; to: string }[] {
  if (globals.size === 0) return []
  const checker = project.program.getTypeChecker()
  const edges: { from: string; to: string }[] = []
  for (const sf of project.program.getSourceFiles()) {
    if (!isProjectFile(sf.fileName) || sf.isDeclarationFile) continue
    const from = rel(sf.fileName)
    for (const [name, to] of globals) {
      if (to !== from && sf.text.includes(name) && usesGlobal(sf, name, checker)) edges.push({ from, to })
    }
  }
  return edges
}
