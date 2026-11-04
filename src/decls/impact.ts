import type { BackendFileImpact } from '../backend/impact.js'
import type { ChangedFile } from '../git/types.js'
import { compareStrings, sortedUnique } from '../output/order.js'
import type { ImportGraph } from '../project/graph.js'
import type { RouteTable } from '../routes/types.js'
import type { Decl, Entry, DeclHelperOutput } from './types.js'

/** Declaration graph of one side (base or head) of the PR, with reverse edges for "who runs this code". */
export class DeclGraph {
  readonly byId = new Map<string, number>()
  private readonly reverse = new Map<number, number[]>()

  constructor(readonly out: DeclHelperOutput) {
    out.decls.forEach((d, i) => this.byId.set(d.id, i))
    for (const [from, to] of out.edges) {
      const list = this.reverse.get(to) ?? []
      list.push(from)
      this.reverse.set(to, list)
    }
  }

  decl(i: number): Decl {
    const d = this.out.decls[i]
    if (d === undefined) throw new Error(`internal: Go declaration ${i} does not exist`)
    return d
  }

  /** Breadth-first over reversed edges: every declaration whose code can run the starting ones, with the next step back. */
  reach(starts: readonly number[]): Map<number, { dist: number; next: number | null }> {
    const result = new Map<number, { dist: number; next: number | null }>(starts.map((s) => [s, { dist: 0, next: null }]))
    let frontier = [...starts]
    while (frontier.length > 0) {
      const next: number[] = []
      for (const node of frontier) {
        const dist = (result.get(node)?.dist ?? 0) + 1
        for (const from of this.reverse.get(node) ?? []) {
          if (result.has(from)) continue
          result.set(from, { dist, next: node })
          next.push(from)
        }
      }
      frontier = next
    }
    return result
  }

  /** Entry points whose anchors reach the starting declarations, each with the file chain anchor → … → start. */
  entriesReaching(starts: readonly number[], keys?: ReadonlySet<string>): Map<string, string[]> {
    const reach = this.reach(starts)
    const out = new Map<string, string[]>()
    for (const entry of this.out.entries) {
      if (keys && !keys.has(entry.key)) continue
      let best: number | undefined
      for (const a of entry.anchors) {
        const r = reach.get(a)
        if (r && (best === undefined || r.dist < (reach.get(best)?.dist ?? Infinity))) best = a
      }
      if (best === undefined) continue
      const files: string[] = []
      for (let cur: number | null = best; cur !== null; cur = reach.get(cur)?.next ?? null) {
        const file = this.decl(cur).file
        if (files[files.length - 1] !== file) files.push(file)
      }
      out.set(entry.key, files)
    }
    return out
  }

  anchorIds(entry: Entry): string {
    return entry.anchors.map((a) => this.decl(a).id).sort(compareStrings).join('\n')
  }
}

/** File-level import graph from the declaration edges (for risk numbers and new files). */
export function declImportGraph(out: DeclHelperOutput): ImportGraph {
  const seen = new Set<string>()
  const edges: ImportGraph['edges'] = []
  for (const [from, to] of out.edges) {
    const a = out.decls[from]?.file
    const b = out.decls[to]?.file
    if (a === undefined || b === undefined || a === b || seen.has(`${a}\0${b}`)) continue
    seen.add(`${a}\0${b}`)
    edges.push({ from: a, to: b, kind: 'static' })
  }
  edges.sort((x, y) => compareStrings(x.from, y.from) || compareStrings(x.to, y.to))
  const parseErrors = out.problems.filter((p) => p.kind !== 'dynamic-route').map((p) => ({ file: p.file, line: Math.max(1, p.line), message: p.detail }))
  return { nodes: [...out.files].sort(compareStrings), edges, unresolved: [], parseErrors, reexportOnly: [] }
}

/** Entry points as a route table: the anchors' files are the route modules. */
export function declRouteTable(out: DeclHelperOutput): RouteTable {
  // The entry module is the file that registers the entry point (the handler's module for decorators, the router setup
  // for Go): the file a PR changes to add it.
  const routes = out.entries.map((e) => ({
    key: e.key,
    path: e.key,
    index: false,
    entry: e.file === '' ? null : e.file,
    modules: sortedUnique(e.anchors.map((a) => out.decls[a]?.file ?? '').filter((f) => f !== '')),
    layouts: [],
    ...(e.computed !== undefined && e.computed.length > 0 ? { computed: e.computed.map((c) => ({ file: c.file, line: Math.max(1, c.line), detail: `${e.key}: path computed at run time` })) } : {}),
  }))
  const dynamic = out.problems.filter((p) => p.kind === 'dynamic-route').map((p) => ({ file: p.file, line: Math.max(1, p.line), detail: p.detail }))
  return { routes: routes.sort((a, b) => compareStrings(a.key, b.key)), dynamic, sources: sortedUnique(out.entries.map((e) => e.file)) }
}

export type DeclFileImpact = BackendFileImpact & {
  /** File chain from the entry point's anchor to the changed code, per affected entry point. */
  chains: Map<string, string[]>
  /** New entry points that reach code of this file (added files). */
  newEntriesReaching: string[]
}

const isStartup = (id: string): boolean => id.includes('.init#') || id.includes('._#')

/**
 * What each changed source file does to the entry points, declaration by declaration: a changed or removed function,
 * method, type, variable or constant affects the entry points whose code reaches it (head graph for changes, base
 * graph for removals). Comment and formatting changes change no hash; new declarations are additive.
 */
export interface DeclImpactOptions {
  /** Keys of the entry points that existed in the base, when the base output has no entries (TypeScript). */
  existing?: ReadonlySet<string>
  /** Type declarations are erased at runtime (TypeScript): changing them is not a problem. */
  erasedTypes?: boolean
}

/** The problem of a file whose imports, compiler directives or code-changing comments changed. */
export const HEADER_CHANGED = 'imports or code directives changed'

/**
 * Whether the header entries of a file changed in a way its unchanged declarations can see. A name bound only before
 * (unused now, or its users changed) or only after (new, used by changed code) does not count; the same name bound to
 * another source, or any other entry added or removed, does. Missing on one side only: changed (fail closed).
 */
export function headerChanged(before: readonly string[] | undefined, after: readonly string[] | undefined): boolean {
  if (before === undefined || after === undefined) return before !== after
  const bound = (entries: readonly string[]): Set<string> => new Set(entries.filter((e) => e.startsWith('bind ')).map((e) => e.split(' ')[1] ?? ''))
  const [boundBefore, boundAfter] = [bound(before), bound(after)]
  const [setBefore, setAfter] = [new Set(before), new Set(after)]
  const counts = (e: string, other: Set<string>): boolean => !e.startsWith('bind ') || other.has(e.split(' ')[1] ?? '')
  return before.some((e) => !setAfter.has(e) && counts(e, boundAfter)) || after.some((e) => !setBefore.has(e) && counts(e, boundBefore))
}

export function declImpacts(base: DeclHelperOutput, head: DeclHelperOutput, files: readonly ChangedFile[], isSource: (path: string) => boolean, options: DeclImpactOptions = {}): Map<string, DeclFileImpact> {
  const b = new DeclGraph(base)
  const h = new DeclGraph(head)
  const short = (id: string): string => (head.module !== '' && id.startsWith(`${head.module}/`) ? id.slice(head.module.length + 1) : id)
  const baseKeys = options.existing ?? new Set(base.entries.map((e) => e.key))
  const headKeys = new Set(head.entries.map((e) => e.key))
  const existing = new Set([...headKeys].filter((k) => baseKeys.has(k)))
  const added = new Set([...headKeys].filter((k) => !baseKeys.has(k)))
  const result = new Map<string, DeclFileImpact>()
  for (const file of files) {
    if (!isSource(file.path)) continue
    const oldPath = file.oldPath ?? file.path
    const impact: DeclFileImpact = { additive: true, problems: [], affected: new Map(), addedOperations: [], added: [], chains: new Map(), newEntriesReaching: [] }
    const hit = (reached: Map<string, string[]>, cause: string): void => {
      for (const [key, chain] of reached) {
        if (impact.affected.has(key)) continue
        impact.affected.set(key, cause)
        impact.chains.set(key, chain)
      }
    }
    const headHere = file.status === 'deleted' ? [] : head.decls.map((d, i) => [d, i] as const).filter(([d]) => d.file === file.path)
    const baseHere = file.status === 'added' ? [] : base.decls.map((d, i) => [d, i] as const).filter(([d]) => d.file === oldPath)
    if (file.status === 'added') {
      const starts = headHere.map(([, i]) => i)
      hit(h.entriesReaching(starts, existing), file.path)
      impact.newEntriesReaching = [...h.entriesReaching(starts, added).keys()].sort(compareStrings)
      impact.added = headHere.map(([d]) => short(d.id)).sort(compareStrings)
    }
    for (const [d, i] of file.status === 'added' ? [] : headHere) {
      const before = b.byId.get(d.id)
      if (before === undefined && !isStartup(d.id)) {
        impact.added.push(short(d.id))
        continue
      }
      if (before !== undefined && b.decl(before).core === d.core) continue
      if (options.erasedTypes === true && d.kind === 'type') {
        impact.erased = [...(impact.erased ?? []), short(d.id)]
        continue
      }
      impact.problems.push(`${d.kind} ${short(d.id)} ${before === undefined ? 'added (runs at startup)' : 'changed'}`)
      hit(h.entriesReaching([i], existing), short(d.id))
    }
    for (const [d, i] of baseHere) {
      if (h.byId.has(d.id) || (options.erasedTypes === true && d.kind === 'type')) continue
      impact.problems.push(`${d.kind} ${short(d.id)} was removed`)
      hit(b.entriesReaching([i], existing), short(d.id))
    }
    // Imports and directives are outside every declaration: a name now imported from another module, a side-effect
    // import or a //go:embed of other files changes what the file's unchanged declarations run.
    if (file.status !== 'added' && file.status !== 'deleted' && headerChanged(base.headers?.[oldPath], head.headers?.[file.path])) {
      impact.problems.push(HEADER_CHANGED)
      hit(h.entriesReaching(headHere.map(([, i]) => i), existing), file.path)
    }
    // Routes registered in this file: a different handler or middleware set changes what an existing route runs.
    for (const entry of head.entries) {
      if (entry.file !== file.path) continue
      if (added.has(entry.key)) {
        impact.addedOperations.push(entry.key)
        continue
      }
      const before = options.existing ? undefined : base.entries.find((e) => e.key === entry.key)
      if (before && (b.anchorIds(before) !== h.anchorIds(entry) || before.inline !== entry.inline) && !impact.affected.has(entry.key)) {
        impact.problems.push(`entry point ${entry.key} now runs different code (handler or middlewares)`)
        impact.affected.set(entry.key, 'registration')
        impact.chains.set(entry.key, [file.path])
      }
    }
    for (const entry of options.existing ? [] : base.entries) if (entry.file === oldPath && !headKeys.has(entry.key)) impact.problems.push(`entry point ${entry.key} was removed`)
    result.set(file.path, impact)
  }
  // A route declared in an unchanged file can disappear through a changed registration elsewhere (an include_router
  // or a prefix): it is reported on the files whose registration calls changed, or on every changed file.
  const reportedRemoved = new Set((options.existing ? [] : base.entries).filter((e) => !headKeys.has(e.key) && result.has(e.file)).map((e) => e.key))
  const orphans = (options.existing ? [] : base.entries).filter((e) => !headKeys.has(e.key) && !reportedRemoved.has(e.key)).map((e) => e.key)
  if (orphans.length > 0) {
    const registrationChanged = [...result.keys()].filter((path) => head.decls.some((d) => d.file === path && d.hash !== d.core && b.byId.has(d.id) && b.decl(b.byId.get(d.id) ?? -1).hash !== d.hash))
    for (const path of registrationChanged.length > 0 ? registrationChanged : [...result.keys()]) {
      const impact = result.get(path)
      for (const key of orphans) impact?.problems.push(`entry point ${key} was removed`)
    }
  }
  for (const impact of result.values()) {
    impact.additive = impact.problems.length === 0
    impact.added = sortedUnique(impact.added)
    impact.addedOperations = sortedUnique(impact.addedOperations)
    impact.affected = new Map([...impact.affected.entries()].sort(([x], [y]) => compareStrings(x, y)))
  }
  return result
}
