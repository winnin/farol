import ts from 'typescript'
import { compareStrings, sortedUnique } from '../output/order.js'
import { parseIsolated, unwrap } from '../project/parse.js'
import { mountNodes } from './hono.js'
import { importsHono, isHonoModule } from './hono-resolver.js'
import { plainChain, restNodes, takesNext, type RestNode } from './rest.js'

/** One resolver of a resolver map: `Type.field` and the code that implements it. */
export interface ResolverEntry {
  key: string
  file: string
  line: number
  /** Normalized source text of the resolver (to compare base and head). */
  text: string
}

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  return undefined
}

function normalized(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, ' ').trim()
}

/** The text of a handler's registration without the handler: its chain and its other arguments. */
const registrationText = (n: RestNode, sf: ts.SourceFile): string => normalized(n.node, sf).replace(normalized(n.value, sf), '')

/** Field name marking an enum in the type-fields map: its resolver maps internal values. */
export const ENUM_MARKER = '__values'

/** Resolver members every type may have besides its fields. */
const META_FIELDS = new Set(['__resolveReference', '__resolveType', '__isTypeOf'])

/**
 * The value node of each `Type: { field: … }` member of resolver maps found anywhere in a file. A member counts only
 * when it names a field of that type in the schema, so registries keyed by type names (loaders) are not resolvers.
 */
export function resolverNodes(sf: ts.SourceFile, typeFields: ReadonlyMap<string, ReadonlySet<string>>): { key: string; node: ts.Node; value: ts.Node }[] {
  const out: { key: string; node: ts.Node; value: ts.Node }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const type = propName(prop.name)
        const inner = unwrap(prop.initializer)
        const fields = type === undefined ? undefined : typeFields.get(type)
        // Enum value maps (`Status: { ACTIVE: 1 }` or `Status: STATUS_VALUES`) resolve the whole enum.
        if (fields?.has(ENUM_MARKER)) {
          out.push({ key: `${type ?? ''}.${ENUM_MARKER}`, node: prop, value: prop.initializer })
          continue
        }
        if (fields === undefined || !ts.isObjectLiteralExpression(inner)) continue
        for (const member of inner.properties) {
          const field = member.name ? propName(member.name) : undefined
          if (field === undefined || (!fields.has(field) && !META_FIELDS.has(field))) continue
          const value = ts.isPropertyAssignment(member) ? member.initializer : ts.isShorthandPropertyAssignment(member) ? member.name : member
          out.push({ key: `${type}.${field}`, node: member, value })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Entry points defined in a file: GraphQL resolvers (`Type.field`) and REST handlers (`GET /path`). */
export function entryNodes(sf: ts.SourceFile, typeFields: ReadonlyMap<string, ReadonlySet<string>>, rest: boolean): ({ key: string; node: ts.Node; value: ts.Node } | RestNode)[] {
  return [...resolverNodes(sf, typeFields), ...(rest ? restNodes(sf) : [])]
}

/** `module.exports`, `module.exports.x`, `exports.x`: assigning there only exports. */
function isExportTarget(e: ts.Expression): boolean {
  const chain = ts.isPropertyAccessExpression(e) ? accessChain(e) : []
  return chain[0] === 'exports' || (chain[0] === 'module' && chain[1] === 'exports')
}

/**
 * Whether evaluating a node runs code when the file loads: a call, `new`, a tagged template, `await`, a decorator, an
 * assignment or static class code, outside function bodies. `require('x')`, `gql` templates and `new Hono()` of a hono
 * package do not count; nor do instance fields (they run when an object is built).
 */
export function runsCode(node: ts.Node, honoNames: ReadonlySet<string>): boolean {
  const runs = (n: ts.Node | undefined): boolean => n !== undefined && runsCode(n, honoNames)
  // `class A extends mixin()` evaluates its base class (an `ExpressionWithTypeArguments`, which is also a type node).
  if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent) && node.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(node.parent.parent)) return runs(node.expression)
  if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return false
  if (ts.isDecorator(node) || ts.isClassStaticBlockDeclaration(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isDeleteExpression(node)) return true
  if (ts.isFunctionLike(node)) return (ts.canHaveDecorators(node) && (ts.getDecorators(node) ?? []).length > 0) || (node.name !== undefined && ts.isComputedPropertyName(node.name) && runs(node.name.expression))
  if (ts.isPropertyDeclaration(node)) return (ts.getDecorators(node) ?? []).length > 0 || (ts.isComputedPropertyName(node.name) && runs(node.name.expression)) || (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static ? runs(node.initializer) : false)
  if (ts.isCallExpression(node)) return !(ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1 && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0]))
  if (ts.isNewExpression(node)) return !(ts.isIdentifier(node.expression) && honoNames.has(node.expression.text)) || (node.arguments ?? []).some(runs)
  if (ts.isTaggedTemplateExpression(node)) return !(ts.isIdentifier(node.tag) && (node.tag.text === 'gql' || node.tag.text === 'graphql')) || runs(node.template)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return !(node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isExportTarget(node.left)) || runs(node.right)
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return true
  return ts.forEachChild(node, (child) => (runs(child) ? true : undefined)) ?? false
}

/** A REST handler that can pass a request on (`next`), so it runs for other endpoints: inline with two parameters, or not inline on `all` or a `*` path. */
function middlewareLike(n: RestNode): boolean {
  const call = n.node
  if (!ts.isCallExpression(call)) return false
  if (call.arguments.some(takesNext)) return true
  const x = unwrap(n.value as ts.Expression)
  if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return false
  return n.key.startsWith('ALL ') || n.key.includes('*')
}

/** A Hono mount of a file version: its prefix as written and whether adding it runs no other code. */
export interface MountEntry {
  id: string
  prefix: string
  plain: boolean
}

/**
 * Resolver entries of a file, parsed on its own (used for the base and the head of changed files). Mounts are read when
 * the file imports hono or `hono` says the program uses Hono there.
 */
export function resolverEntries(
  file: string,
  code: string,
  typeFields: ReadonlyMap<string, ReadonlySet<string>>,
  withRest = true,
  hono = false,
): { entries: ResolverEntry[]; rest: string[]; loadCode: string[]; imports: Set<string>; mounts: Map<string, MountEntry>; impure: Map<string, string>; middleware: Set<string>; properties: string[] } {
  const { sourceFile: sf } = parseIsolated(file, code)
  const nodes = entryNodes(sf, typeFields, withRest)
  const entries = nodes.map(({ key, node }) => ({ key, file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: normalized(node, sf) }))
  // Everything outside the resolver members (helpers, module-level code), for "did anything else change". Imports are
  // compared as bindings: adding one is not a change to what existed.
  const imports = new Set<string>()
  // `new Hono()` builds an app and runs nothing else.
  const honoNames = new Set<string>()
  // Hono mounts are compared on their own (`mountId` → prefix as written), like the handlers.
  const mounts = withRest && (hono || importsHono(sf)) ? mountNodes(sf, file) : []
  const removed: [number, number][] = [...nodes, ...mounts].map(({ node }) => [node.getStart(sf), node.end])
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      const spec = statement.moduleSpecifier.text
      if (!clause) imports.add(`${spec}|`)
      if (clause?.name) imports.add(`${spec}|default as ${clause.name.text}`)
      const named = clause?.namedBindings
      if (named && ts.isNamespaceImport(named)) imports.add(`${spec}|* as ${named.name.text}`)
      if (named && ts.isNamedImports(named)) for (const el of named.elements) imports.add(`${spec}|${(el.propertyName ?? el.name).text} as ${el.name.text}`)
      if (named && ts.isNamedImports(named) && isHonoModule(spec)) for (const el of named.elements) if ((el.propertyName ?? el.name).text === 'Hono') honoNames.add(el.name.text)
      removed.push([statement.getStart(sf), statement.end])
    }
  }
  // The rest of the file as comparable items: every top-level statement, and every property of top-level object
  // literals on its own, with the resolver members blanked out. Adding a property or a statement is not a change.
  const blank = (node: ts.Node): string => {
    let text = code.slice(node.getStart(sf), node.end)
    const offset = node.getStart(sf)
    const inside = removed.filter(([a, b]) => a >= offset && b <= node.end)
    const outer = inside.filter(([a, b]) => !inside.some(([c, d]) => c <= a && d >= b && (c !== a || d !== b)))
    for (const [start, end] of outer.sort((a, b) => b[0] - a[0])) text = text.slice(0, start - offset) + text.slice(end - offset)
    return stripComments(text, file).replace(/\s+/g, ' ').replace(/,(\s*,)+/g, ',').replace(/\{\s*,/g, '{').replace(/,\s*\}/g, '}').trim()
  }
  const items: string[] = []
  const properties: string[] = []
  // Top-level code that is not a declaration, an inert value, a handler or a mount runs when the file loads
  // (`app.use(mw)`, `const db = connect()`): adding some is a change.
  const loadCode: string[] = []
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) continue
    const object = topLevelObject(statement)
    if (!object) {
      const text = blank(statement)
      items.push(text)
      if (runsCode(statement, honoNames) && text.replace(/;$/, '') !== '') loadCode.push(text)
      continue
    }
    for (const prop of object.properties) {
      items.push(blank(prop))
      properties.push(blank(prop))
      if (runsCode(prop, honoNames)) loadCode.push(blank(prop))
    }
    items.push(blank(statement).replace(blank(object), '{}'))
  }
  // Handlers whose registration runs other code (`app.use(mw).get(…)`, `get('/x', rateLimit(), h)`), with the text of the
  // registration without the handler: the chain and the arguments are blanked with the handler. Handlers that can call
  // `next` run for other endpoints.
  const rest = nodes.filter((n): n is RestNode => 'receiver' in n)
  const impure = new Map(rest.filter((n) => !plainChain(n.receiver) || (ts.isCallExpression(n.node) && n.node.arguments.some((a) => runsCode(a, honoNames)))).map((n) => [n.key, registrationText(n, sf)]))
  const middleware = new Set(rest.filter(middlewareLike).map((n) => n.key))
  return { entries: entries.sort((a, b) => compareStrings(a.key, b.key)), rest: items, loadCode, imports, mounts: new Map(mounts.map((m) => [m.id, { id: m.id, prefix: m.prefix, plain: m.plain }])), impure, middleware, properties }
}

/** The comments between two tokens, as ranges of `code`. */
function commentRanges(code: string, start: number, end: number): [number, number][] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code, undefined, start, end - start)
  const out: [number, number][] = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) out.push([scanner.getTokenStart(), scanner.getTokenEnd()])
  }
  return out
}

/**
 * Code without comments (they never change behavior). Comments are read only between the tokens of the parsed code:
 * `//` in a template string or a regular expression is code, and code the parser skips stays in the result.
 */
export function stripComments(code: string, file = 'code.ts'): string {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const comments = new Map<number, number>()
  const visit = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return
    const children = node.getChildren(sf)
    if (children.length === 0) for (const [start, end] of commentRanges(code, node.getFullStart(), node.getStart(sf))) comments.set(start, end)
    children.forEach(visit)
  }
  visit(sf)
  let out = ''
  let at = 0
  for (const [start, end] of [...comments].sort((a, b) => a[0] - b[0])) {
    out += code.slice(at, start)
    at = end
  }
  return out + code.slice(at)
}

/** The object literal a top-level statement defines (`const X = {…}`, `export default {…}`, `module.exports = {…}`). */
function topLevelObject(statement: ts.Statement): ts.ObjectLiteralExpression | undefined {
  let value: ts.Expression | undefined
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) value = statement.declarationList.declarations[0]?.initializer
  else if (ts.isExportAssignment(statement)) value = statement.expression
  else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) value = statement.expression.right
  const inner = value ? unwrap(value) : undefined
  return inner && ts.isObjectLiteralExpression(inner) ? inner : undefined
}

const isBlank = (item: string): boolean => item.replace(/;$/, '') === ''

/**
 * Whether a file with a Hono app changed in a way the item comparison calls additive: items that stayed changed order
 * (`app.use(mw)` after the routes no longer runs for them), or an object has a new property (`use(cors(options))`).
 */
export function appCodeChanged(base: ReturnType<typeof resolverEntries>, head: ReturnType<typeof resolverEntries>): boolean {
  const kept = (items: readonly string[], other: readonly string[]): string[] => items.filter((i) => !isBlank(i) && other.includes(i))
  return kept(base.rest, head.rest).join('\n') !== kept(head.rest, base.rest).join('\n') || head.properties.some((p) => !isBlank(p) && !base.rest.includes(p))
}

export interface ResolverChanges {
  added: string[]
  removed: string[]
  changed: string[]
  /** Code outside the resolver members changed (imports, helpers, module-level code): every resolver may be affected. */
  restChanged: boolean
  /** A change that can reach every endpoint of the file's apps: module code, new load code, or a chain or handler that runs for others. */
  wide: boolean
  /** Hono mounts the head adds (a changed mount is removed and added). */
  addedMounts: MountEntry[]
  /** What is not additive besides entries: removed or changed mounts, new code that runs when the file loads or on a handler's chain. */
  problems: string[]
}

/** Resolver-level comparison of a changed resolver file: only resolvers whose own code changed are affected. */
export function diffResolvers(base: ReturnType<typeof resolverEntries>, head: ReturnType<typeof resolverEntries>): ResolverChanges {
  const before = new Map(base.entries.map((e) => [e.key, e.text]))
  const after = new Map(head.entries.map((e) => [e.key, e.text]))
  const added = [...after.keys()].filter((k) => !before.has(k)).sort(compareStrings)
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort(compareStrings)
  const changed = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k)).sort(compareStrings)
  const restChanged = base.rest.some((item) => !head.rest.includes(item)) || [...base.imports].some((i) => !head.imports.has(i))
  const newLoadCode = head.loadCode.filter((c) => !base.rest.includes(c))
  const newSideEffects = [...head.imports].filter((i) => i.endsWith('|') && !base.imports.has(i))
  const runsForOthers = (k: string): boolean => base.impure.get(k) !== head.impure.get(k) || base.middleware.has(k) || head.middleware.has(k)
  return {
    added,
    removed,
    changed,
    restChanged,
    wide: restChanged || newLoadCode.length > 0 || newSideEffects.length > 0 || [...added, ...removed, ...changed].some(runsForOthers),
    addedMounts: [...head.mounts.values()].filter((m) => !base.mounts.has(m.id)).sort((a, b) => compareStrings(a.id, b.id)),
    problems: sortedUnique([
      ...[...base.mounts.values()].filter((m) => !head.mounts.has(m.id)).map((m) => `mount ${m.prefix} was removed`),
      ...newLoadCode.map((c) => `code that runs when the file loads was added: ${c.length > 80 ? `${c.slice(0, 77)}...` : c}`),
      ...newSideEffects.map((i) => `side-effect import ${i.slice(0, -1)} was added: it runs that module when the file loads`),
      ...[...head.impure.keys()].filter((k) => !before.has(k)).map((k) => `endpoint ${k} was added with code that runs when it is registered (a call in its chain or arguments)`),
      ...[...head.middleware].filter((k) => !before.has(k)).map((k) => `endpoint ${k} was added as middleware (it can call next): it runs for other endpoints`),
    ]),
  }
}

/** `a.b.c` → ['a', 'b', 'c'] (empty when the chain does not start with an identifier or `this`). */
export function accessChain(node: ts.PropertyAccessExpression): string[] {
  const parts: string[] = []
  let current: ts.Expression = node
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text)
    current = current.expression
  }
  if (ts.isIdentifier(current)) parts.unshift(current.text)
  else if (current.kind === ts.SyntaxKind.ThisKeyword) parts.unshift('this')
  else return []
  return parts
}

const TYPE_ONLY = new Set([ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.PropertySignature, ts.SyntaxKind.MethodSignature, ts.SyntaxKind.TypeParameter, ts.SyntaxKind.TypeLiteral])

/**
 * Project modules a resolver uses: every identifier in its code resolved with the type checker to its declaration
 * (through imports and re-exports), following functions declared in the same file. Free identifiers that name a
 * global set with `global.X = …` count as uses of the module that sets it.
 */
export function resolverAnchors(
  value: ts.Node,
  checker: ts.TypeChecker,
  isProjectFile: (fileName: string) => boolean,
  rel: (fileName: string) => string,
  globals: ReadonlyMap<string, string>,
  context: (chain: readonly string[]) => readonly string[] = () => [],
): string[] {
  const own = value.getSourceFile()
  const modules = new Set<string>()
  const seen = new Set<ts.Node>()
  const visit = (node: ts.Node): void => {
    // Types never run: annotations and type-only declarations are not uses.
    if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return
    // `loaders.Brand.byId(…)`: a context property injected at runtime, mapped by the configuration.
    if (ts.isPropertyAccessExpression(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
      for (const m of context(accessChain(node))) modules.add(m)
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      // JS expando assignments (`process.env.X = …` somewhere) are not declarations of the identifier.
      const decls = (target?.declarations ?? []).filter((d) => !TYPE_ONLY.has(d.kind) && !ts.isBinaryExpression(d) && !ts.isPropertyAccessExpression(d) && !ts.isElementAccessExpression(d) && !ts.isIdentifier(d))
      if (decls.every((d) => d.getSourceFile().isDeclarationFile) && globals.has(node.text)) {
        modules.add(globals.get(node.text) ?? '')
        return
      }
      for (const d of decls) {
        const sf = d.getSourceFile()
        if (sf === own) {
          // A helper of the same file: its code is part of the resolver.
          const body = ts.isFunctionDeclaration(d) ? d : ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? d.initializer : undefined
          if (body && !seen.has(body)) {
            seen.add(body)
            visit(body)
          }
        } else if (isProjectFile(sf.fileName)) {
          modules.add(rel(sf.fileName))
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  seen.add(value)
  visit(value)
  return sortedUnique(modules)
}
