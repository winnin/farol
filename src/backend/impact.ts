import { compareStrings, sortedUnique } from '../output/order.js'
import { keyPath, overlaps } from './hono-paths.js'
import { codeText, parseIsolated } from '../project/parse.js'
import { appCodeChanged, diffResolvers, resolverEntries, type MountEntry, type ResolverChanges } from './resolvers.js'
import { restAnchor } from './rest.js'
import type { SchemaDiff } from './schema.js'

/** What a changed schema or resolver file does to the operations. */
export interface BackendFileImpact {
  /** Nothing that existed changed: only new fields, types, resolvers or endpoints. */
  additive: boolean
  problems: string[]
  /** Existing operations affected, with the schema member or resolver that affects them. */
  affected: Map<string, string>
  /** New root operations or endpoints. */
  addedOperations: string[]
  /** New fields, types or resolvers that are not operations (informational). */
  added: string[]
  /** File chain from each affected operation to the change, when known (else the file itself). */
  chains?: Map<string, string[]>
  /** TypeScript: type declarations that changed (erased at runtime, so not problems). */
  erased?: string[]
  /** Added files only (Go): new entry points that reach the file's code; present when the impact covers new files. */
  newEntriesReaching?: string[]
  /** A source file holding a Hono app: the endpoints that import it are reached too (declaration impacts replace reach). */
  keepsReach?: boolean
}

export interface ImpactTable {
  resolverKeys: ReadonlyMap<string, ReadonlySet<string>>
  operationTypes: ReadonlyMap<string, ReadonlySet<string>>
  rootTypes: ReadonlySet<string>
}

function typeOf(member: string): string {
  const cut = [member.indexOf('.'), member.indexOf('|'), member.indexOf('&')].filter((i) => i >= 0)
  return cut.length === 0 ? member : member.slice(0, Math.min(...cut))
}

/** Operations that run a schema member: the root field itself, or every operation that can return its type. */
function operationsUsingMember(member: string, table: ImpactTable): string[] {
  const type = typeOf(member)
  return [...table.operationTypes.entries()].filter(([op, types]) => op === member || types.has(type)).map(([op]) => op)
}

function operationsUsingResolver(key: string, table: ImpactTable): string[] {
  return [...table.resolverKeys.entries()].filter(([, keys]) => keys.has(key)).map(([op]) => op).sort(compareStrings)
}

/** The endpoint comparison of a changed file, with the endpoints a wide change reaches. */
export type CodeFileChanges = ResolverChanges & { keys: string[]; reachKeys: readonly string[] }

export interface CodeFile {
  file: string
  before: string
  after: string
  /** A source file holds an app and has no other comparison: any edit beyond comments and formatting counts. */
  isSource: boolean
  holdsApp: boolean
  rest: boolean
}

export interface CodeTable {
  typeFields: ReadonlyMap<string, ReadonlySet<string>>
  honoFiles: ReadonlySet<string>
  fileReachKeys: (file: string) => readonly string[]
}

const sameCode = (file: string, a: string, b: string): boolean => {
  const code = (text: string): string => {
    const { sourceFile } = parseIsolated(file, text)
    return codeText(sourceFile, sourceFile)
  }
  return code(a) === code(b)
}

/**
 * Compares both versions of a code file. Item by item, moving `app.use(mw)` or a new property of its options is
 * additive; for a file with an app it is not, and every endpoint under its apps is reached.
 */
export function compareCodeFile(table: CodeTable, f: CodeFile): CodeFileChanges {
  const usesHono = table.honoFiles.has(f.file)
  const base = resolverEntries(f.file, f.before, table.typeFields, f.rest, usesHono || f.holdsApp)
  const head = resolverEntries(f.file, f.after, table.typeFields, f.rest, usesHono || f.holdsApp)
  const diff = diffResolvers(base, head)
  const edited = (f.isSource && !sameCode(f.file, f.before, f.after)) || (f.holdsApp && appCodeChanged(base, head))
  const reaches = f.holdsApp || (usesHono && base.middleware.size + head.middleware.size > 0)
  return { ...diff, restChanged: diff.restChanged || edited, wide: diff.wide || edited, keys: [...new Set([...base.entries, ...head.entries].map((e) => e.key))], reachKeys: reaches ? table.fileReachKeys(f.file) : [] }
}

/**
 * Impact of one changed file from its SDL diff and its resolver/endpoint diff (either may be absent). Endpoint keys of
 * the diff are paths as written in `file`; they run the endpoints of their handler anchor (one per Hono mount).
 */
export function backendFileImpact(table: ImpactTable, file: string, schema: SchemaDiff | undefined, resolvers: CodeFileChanges | undefined): BackendFileImpact {
  const using = (k: string): string[] => operationsUsingResolver(k.includes(' ') ? restAnchor(file, k) : k, table)
  /** The full endpoint keys of a handler when its mounts change them, else the key as written. */
  const label = (k: string): string => {
    const ops = k.includes(' ') ? using(k) : []
    return ops.length === 0 ? k : ops.join(', ')
  }
  const affected = new Map<string, string>()
  const problems: string[] = []
  const addedOperations: string[] = []
  const added: string[] = []
  const hit = (ops: string[], cause: string): void => {
    for (const op of ops) if (!affected.has(op)) affected.set(op, cause)
  }
  if (schema) {
    for (const m of schema.removed) {
      problems.push(`schema member ${m} was removed`)
      hit(operationsUsingMember(m, table), m)
    }
    for (const m of schema.changed) {
      problems.push(`schema member ${m} changed (type, arguments or directives)`)
      hit(operationsUsingMember(m, table), m)
    }
    for (const m of schema.added) (table.rootTypes.has(typeOf(m)) && m.includes('.') ? addedOperations : added).push(m)
  }
  if (resolvers) {
    for (const k of resolvers.removed) {
      problems.push(`${k.includes(' ') ? 'endpoint' : 'resolver'} ${label(k)} was removed`)
      hit(using(k), k)
    }
    for (const k of resolvers.changed) {
      problems.push(`${k.includes(' ') ? 'endpoint' : 'resolver'} ${label(k)} changed`)
      hit(using(k), k)
    }
    // The endpoints under a removed mount are gone from the head: they cannot be named, the change still counts.
    problems.push(...resolvers.problems)
    if (resolvers.restChanged) {
      problems.push('code outside the resolvers changed (imports, helpers or module-level code): every resolver of the file may behave differently')
      for (const k of resolvers.keys) hit(using(k), `module code of ${k}`)
    }
    if (resolvers.wide) hit([...resolvers.reachKeys], `module code of ${file}`)
    for (const k of resolvers.added) {
      const ops = k.includes(' ') ? using(k) : []
      if (k.includes(' ')) addedOperations.push(...(ops.length > 0 ? ops : [k]))
      else added.push(k)
    }
  }
  return {
    additive: problems.length === 0,
    problems,
    affected: new Map([...affected.entries()].sort(([a], [b]) => compareStrings(a, b))),
    addedOperations: sortedUnique(addedOperations),
    added: sortedUnique(added),
  }
}

/** A Hono mount a PR adds, with the file that adds it. */
export interface AddedMount extends MountEntry {
  file: string
}

export interface MountTable {
  mountBases: (id: string) => string[]
  mountMiddleware: (id: string) => boolean
  mountKeys: (id: string) => string[]
}

/**
 * Impacts with the PR's new Hono mounts. A mount whose sub-app registers middleware runs it for every request under
 * its full paths, so existing endpoints there are touched; without middleware it only adds routes, like a new handler
 * (a route that shadows an existing pattern is additive), except a route with the full key of an existing endpoint.
 * A new mount that runs other code, or whose paths farol cannot compute, is not additive either. `baseRest`: the REST
 * endpoints that existed before the PR.
 */
export function mountImpacts(table: MountTable, mounts: readonly AddedMount[], baseRest: ReadonlySet<string>, impacts: ReadonlyMap<string, BackendFileImpact>): Map<string, BackendFileImpact> {
  const out = new Map(impacts)
  for (const m of mounts) {
    const bases = table.mountBases(m.id)
    const reached = table.mountMiddleware(m.id) ? [...baseRest].filter((k) => bases.some((b) => overlaps(keyPath(k), b))) : []
    const keys = table.mountKeys(m.id)
    const collides = (k: string): boolean => keys.some((n) => n === k || (keyPath(n) === keyPath(k) && (n.startsWith('ALL ') || k.startsWith('ALL '))))
    const covered = sortedUnique([...reached, ...[...baseRest].filter(collides)])
    const problems = [
      ...(m.plain ? [] : [`mount ${m.prefix} was added with a call in its arguments: that code is not compared`]),
      ...(bases.length === 0 ? [`mount ${m.prefix} was added: farol cannot compute its full paths`] : []),
      ...(covered.length > 0 ? [`mount ${m.prefix} covers existing endpoints: its middleware runs for them`] : []),
    ]
    if (problems.length === 0) continue
    const prev = out.get(m.file) ?? { additive: true, problems: [], affected: new Map<string, string>(), addedOperations: [], added: [] }
    const affected = new Map(prev.affected)
    for (const k of covered) if (!affected.has(k)) affected.set(k, `mount ${m.prefix}`)
    out.set(m.file, { ...prev, additive: false, problems: [...prev.problems, ...problems], affected: new Map([...affected].sort(([a], [b]) => compareStrings(a, b))) })
  }
  return out
}
