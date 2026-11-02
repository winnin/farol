import ts from 'typescript'
import { sortedUnique } from '../output/order.js'
import { codeText, parseIsolated, unwrap } from '../project/parse.js'
import type { DynamicRoute } from '../routes/types.js'
import { mergePath } from './hono-paths.js'
import { type AppCall, installsOnApp, registrationReader } from './hono-registrations.js'
import { type App, appResolver, type AppResolver, importsHono } from './hono-resolver.js'
import { literal, METHODS, plainChain, plainTarget } from './rest.js'

/** `to` is mounted in `from` (`mount`: its prefix and `MountNode` id), or `to` is a parameter that receives `from`. */
type Edge = { from: App; to: App } & ({ mount: { prefix: string; id: string } } | { mount?: undefined })

/** Code a call installs on an app: `use()`, `on()`, `onError()` or a handler that can call `next`. */
export interface Registration {
  /** The full paths it runs under: its path (`*` when farol cannot read it) under every base path of its app. */
  paths: string[]
  args: ts.Expression[]
}

export interface HonoApps {
  /**
   * Base paths of the app a handler registers on, one per mount path from a root app. `undefined`: the receiver is not
   * a Hono app (Express, Fastify: paths as written). `null`: the file uses Hono but farol cannot follow the receiver.
   * Mounts in `without` are left out (to list the endpoints a PR's new mounts add).
   */
  basesOf: (receiver: ts.Expression, without?: ReadonlySet<string>) => string[] | null | undefined
  /** Files that use Hono (import or re-export it, or mount an app): their mounts are compared. */
  honoFiles: Set<string>
  /** Files with at least one mount: changing them can change endpoint paths. */
  mountFiles: Set<string>
  /** Full paths a mount (`MountNode` id) serves: its sub-app's routes and middleware run under them. Empty: unknown. */
  mountBases: (id: string) => string[]
  /**
   * Whether the sub-app of a mount, or an app mounted or passed under it, registers middleware: `use()`, a handler that
   * takes `next`, or `on()`.
   */
  mountMiddleware: (id: string) => boolean
  /** Base paths of a handler's receiver that go through a mount (`MountNode` id). */
  basesThrough: (receiver: ts.Expression, id: string) => string[]
  registrations: Registration[]
  /** Base paths of the apps a file creates, receives, holds in a variable or registers on; empty when it has none. */
  fileBases: (file: string) => string[]
  dynamic: DynamicRoute[]
}

export const UNRESOLVED_APP = 'Hono app is not one farol can follow (basePath, alias or property)'

const isRouteCall = (n: ts.Node): n is AppCall => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'route'

/** Whether a file version holds a Hono app: `new Hono()`, a parameter typed `Hono`, a mount, or a `use`, `onError` or `on` call (syntax only). */
export function holdsApp(file: string, code: string, usesHono: boolean): boolean {
  const { sourceFile: sf } = parseIsolated(file, code)
  const names = new Set<string>()
  for (const s of sf.statements) {
    const named = ts.isImportDeclaration(s) ? s.importClause?.namedBindings : undefined
    if (named && ts.isNamedImports(named)) for (const el of named.elements) if ((el.propertyName ?? el.name).text === 'Hono') names.add(el.name.text)
  }
  const hono = usesHono || importsHono(sf)
  const isHono = (e: ts.Node | undefined): boolean => e !== undefined && ts.isIdentifier(e) && names.has(e.text)
  const found = (node: ts.Node): boolean => {
    // A two-argument route() is a mount also with no hono import: the mount was how the table knew the file uses Hono.
    if (isRouteCall(node) && node.arguments.length === 2) return true
    if (hono && ts.isNewExpression(node) && isHono(node.expression)) return true
    if (hono && ts.isParameter(node) && node.type && ts.isTypeReferenceNode(node.type) && isHono(node.type.typeName)) return true
    if (hono && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && installsOnApp(node as AppCall)) return true
    return ts.forEachChild(node, (child) => (found(child) ? true : undefined)) ?? false
  }
  return found(sf)
}

/** A Hono mount (`app.route('/prefix', sub)`, two arguments, none spread). */
export interface MountNode {
  /** The statement (or the call inside a chain), blanked out of the module code when files are compared. */
  node: ts.Node
  call: AppCall
  /** Identity across the base and head versions of the file: file, normalized text and, for repeated texts, the occurrence. */
  id: string
  prefixArg: ts.Expression
  target: ts.Expression
  /** The prefix as written. */
  prefix: string
  /** Adding the mount runs no other code (receiver and target are names or factory calls with static arguments). */
  plain: boolean
}

export function mountNodes(sf: ts.SourceFile, file: string): MountNode[] {
  const out: MountNode[] = []
  const seen = new Map<string, number>()
  const visit = (node: ts.Node): void => {
    const [prefixArg, target] = isRouteCall(node) ? node.arguments : []
    if (isRouteCall(node) && node.arguments.length === 2 && prefixArg && target && !ts.isSpreadElement(prefixArg) && !ts.isSpreadElement(target)) {
      const text = `${file} ${codeText(node, sf)}`
      const n = (seen.get(text) ?? 0) + 1
      seen.set(text, n)
      const plain = plainChain(node.expression.expression) && plainTarget(target)
      out.push({ node: ts.isExpressionStatement(node.parent) ? node.parent : node, call: node, id: n === 1 ? text : `${text} #${n}`, prefixArg, target, prefix: prefixArg.getText(sf), plain })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * What the program's calls say about its apps: mount edges (`app.route(prefix, sub)`), argument edges (an app passed to a
 * `Hono` parameter), registrations and the apps of each file. What farol cannot follow in a file that uses Hono, or in a mount whose target is a Hono app, is a dynamic route.
 */
function readApps(files: readonly ts.SourceFile[], honoFiles: ReadonlySet<ts.SourceFile>, r: AppResolver, rel: (fileName: string) => string) {
  const incoming = new Map<App, Edge[]>()
  const mountFiles = new Set<string>()
  const middleware = new Set<App>()
  const registered: { app: App; path: string; args: ts.Expression[] }[] = []
  const fileApps = new Map<string, Set<App>>()
  const recordApp = (node: ts.Node, app: App): void => {
    const file = rel(node.getSourceFile().fileName)
    fileApps.set(file, (fileApps.get(file) ?? new Set<App>()).add(app))
  }
  const dynamic: DynamicRoute[] = []
  const at = (node: ts.Node, detail: string): void => {
    const sf = node.getSourceFile()
    dynamic.push({ file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, detail })
  }
  const addEdge = (edge: Edge): void => {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge])
  }

  const mount = (m: MountNode): void => {
    const sf = m.call.getSourceFile()
    const parent = r.appOf(m.call.expression.expression)
    if (!parent) {
      // A Hono app as the target proves a Hono mount, also in a file without a hono import.
      if (honoFiles.has(sf) || r.appOf(m.target) !== undefined) at(m.call, UNRESOLVED_APP)
      return
    }
    mountFiles.add(rel(sf.fileName))
    recordApp(m.call, parent)
    const prefix = literal(m.prefixArg)
    if (prefix === undefined) {
      at(m.prefixArg, 'Hono route() prefix is not a string literal')
      return
    }
    const target = unwrap(m.target)
    const decl = ts.isIdentifier(target) ? r.declOf(target) : undefined
    if (decl && ts.isParameter(decl)) {
      at(target, 'Hono route() target is a parameter: its apps come from the callers')
      return
    }
    const child = r.appOf(target)
    if (!child) {
      at(target, 'Hono route() target is not an app farol can follow')
      return
    }
    addEdge({ from: parent, to: child, mount: { prefix, id: m.id } })
  }
  const argumentEdges = (call: ts.CallExpression): void => {
    const fn = r.functionOf(call.expression)
    call.arguments.forEach((arg, i) => {
      if (ts.isSpreadElement(arg)) {
        if (fn?.parameters.slice(i).some(r.isHonoParam)) at(arg, 'Hono app is spread into a function: farol cannot follow it')
        return
      }
      const p = fn?.parameters[i]
      if (!p) return
      const from = r.appOf(arg)
      if (r.isHonoParam(p)) {
        if (!from) at(arg, 'Hono app passed to a function is not one farol can follow')
        else if (from !== p) addEdge({ from, to: p })
      } else if (from) at(arg, 'Hono app is passed to a parameter not typed Hono: farol cannot place what the function installs')
    })
  }
  const { registrationOf, unknownCode } = registrationReader(r)
  const middlewareCall = (call: AppCall): void => {
    const name = call.expression.name.text
    const registration = registrationOf(call)
    const guards = METHODS.has(name) ? call.arguments.slice(1, -1) : []
    const app = r.appOf(call.expression.expression)
    if (app && METHODS.has(name) && call.arguments.length >= 2) recordApp(call, app)
    if (!registration && guards.length === 0) return
    if (!app) {
      // A handler on an app farol cannot follow is already a dynamic route (`buildBackendTable`).
      if (registration && !METHODS.has(name) && honoFiles.has(call.getSourceFile())) at(call, `Hono ${name}() is on an app farol cannot follow: its middleware cannot be placed`)
      return
    }
    for (const a of new Set([...(registration?.args ?? []), ...guards])) if (unknownCode(a)) at(a, 'Hono middleware comes from a parameter or a variable with no value: farol cannot find its code')
    if (!registration) return
    // `onError` runs only when a handler throws: a new mount with one adds no code to other endpoints' requests.
    if (name !== 'onError') middleware.add(app)
    recordApp(call, app)
    registered.push({ app, ...registration })
  }
  for (const sf of files) {
    for (const m of mountNodes(sf, rel(sf.fileName))) mount(m)
    const visit = (node: ts.Node): void => {
      if (honoFiles.has(sf) && (ts.isNewExpression(node) || (ts.isVariableDeclaration(node) && node.initializer))) {
        const app = r.appOf(ts.isNewExpression(node) ? node : (node.initializer as ts.Expression))
        if (app) recordApp(node, app)
      }
      if (honoFiles.has(sf) && ts.isParameter(node) && r.isHonoParam(node)) recordApp(node, node)
      if (ts.isCallExpression(node)) argumentEdges(node)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) middlewareCall(node as AppCall)
      if (isRouteCall(node) && node.arguments.some(ts.isSpreadElement) && honoFiles.has(sf)) at(node, 'Hono route() arguments are spread')
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { incoming, mountFiles, middleware, registered, fileApps, dynamic }
}

/**
 * The Hono apps of the program and how they are mounted, from the roots (apps nothing mounts) down. Factories are
 * followed through their single returned app; an app passed to a `Hono` parameter is that parameter's app.
 */
export function honoApps(files: readonly ts.SourceFile[], checker: ts.TypeChecker, rel: (fileName: string) => string): HonoApps {
  const r = appResolver(checker)
  const honoFiles = new Set(files.filter(r.usesHono))
  const { incoming, mountFiles, middleware, registered, fileApps, dynamic } = readApps(files, honoFiles, r, rel)
  const edges = [...incoming.values()].flat()
  const outgoing = new Map<App, Edge[]>()
  for (const e of edges) outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e])
  const hasMiddleware = (app: App, seen: Set<App>): boolean => {
    if (seen.has(app)) return false
    seen.add(app)
    return middleware.has(app) || (outgoing.get(app) ?? []).some((e) => hasMiddleware(e.to, seen))
  }
  // Roots (no incoming edge in the head) have '/'; a mount left out removes its paths, it does not make a root.
  const bases = (app: App, without: ReadonlySet<string> | undefined, stack: readonly App[]): string[] => {
    const edges = incoming.get(app)
    if (!edges) return ['/']
    const path = [...stack, app]
    const kept = edges.filter((e) => !(e.mount && without?.has(e.mount.id)) && !path.includes(e.from))
    return sortedUnique(kept.flatMap((e) => bases(e.from, without, path).map((b) => (e.mount ? mergePath(b, e.mount.prefix) : b))))
  }
  // Base paths of `app` whose path from a root goes through the mount `id`.
  const through = (app: App, id: string, stack: readonly App[]): string[] => {
    const path = [...stack, app]
    return sortedUnique(
      (incoming.get(app) ?? [])
        .filter((e) => !path.includes(e.from))
        .flatMap((e) => (e.mount?.id === id ? bases(e.from, undefined, path) : through(e.from, id, path)).map((b) => (e.mount ? mergePath(b, e.mount.prefix) : b))),
    )
  }
  return {
    basesOf: (receiver, without) => {
      const app = r.appOf(receiver)
      if (app) return bases(app, without, [])
      return honoFiles.has(receiver.getSourceFile()) ? null : undefined
    },
    honoFiles: new Set([...[...honoFiles].map((sf) => rel(sf.fileName)), ...mountFiles]),
    mountFiles,
    mountBases: (id) =>
      sortedUnique(
        edges.flatMap((e) => {
          const prefix = e.mount?.id === id ? e.mount.prefix : undefined
          return prefix === undefined ? [] : bases(e.from, undefined, []).map((b) => mergePath(b, prefix))
        }),
      ),
    mountMiddleware: (id) => edges.some((e) => e.mount?.id === id && hasMiddleware(e.to, new Set())),
    basesThrough: (receiver, id) => {
      const app = r.appOf(receiver)
      return app ? through(app, id, []) : []
    },
    registrations: registered.map((x) => ({ paths: bases(x.app, undefined, []).map((b) => mergePath(b, x.path)), args: x.args })),
    fileBases: (file) => sortedUnique([...(fileApps.get(file) ?? [])].flatMap((app) => bases(app, undefined, []))),
    dynamic,
  }
}
