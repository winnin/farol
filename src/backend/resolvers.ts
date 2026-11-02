import ts from 'typescript'
import { compareStrings, sortedUnique } from '../output/order.js'
import { codeText, parseIsolated, unwrap } from '../project/parse.js'
import { callOrder, isBlank, type Call } from './call-order.js'
import { mountNodes } from './hono.js'
import { importsHono, isHonoModule } from './hono-resolver.js'
import { isWidePath, plainChain, restNodes, takesNext, type RestNode } from './rest.js'
import { GQL_TAGS } from './schema.js'

/** One resolver of a resolver map: `Type.field` and the code that implements it. */
export interface ResolverEntry {
  key: string
  file: string
  line: number
  /** The tokens of the resolver (to compare base and head). */
  text: string
}

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  return undefined
}

/** The text of a handler's registration without the handler: its chain and its other arguments. */
const registrationText = (n: RestNode, sf: ts.SourceFile): string => codeText(n.node, sf, [[n.value.getStart(sf), n.value.end]])

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

const isRequire = (e: ts.Expression): boolean => ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require' && e.arguments.length === 1 && e.arguments[0] !== undefined && ts.isStringLiteral(e.arguments[0])

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
  // A `require('x')` that keeps no value only runs that module, like a side-effect import.
  if (ts.isExpressionStatement(node) && isRequire(unwrap(node.expression))) return true
  if (ts.isDecorator(node) || ts.isClassStaticBlockDeclaration(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isDeleteExpression(node) || ts.isThrowStatement(node)) return true
  if (ts.isFunctionLike(node)) return (ts.canHaveDecorators(node) && (ts.getDecorators(node) ?? []).length > 0) || (node.name !== undefined && ts.isComputedPropertyName(node.name) && runs(node.name.expression))
  if (ts.isPropertyDeclaration(node)) return (ts.getDecorators(node) ?? []).length > 0 || (ts.isComputedPropertyName(node.name) && runs(node.name.expression)) || (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static ? runs(node.initializer) : false)
  if (ts.isCallExpression(node)) return !isRequire(node)
  if (ts.isNewExpression(node)) return !(ts.isIdentifier(node.expression) && honoNames.has(node.expression.text)) || (node.arguments ?? []).some(runs)
  if (ts.isTaggedTemplateExpression(node)) return !(ts.isIdentifier(node.tag) && GQL_TAGS.has(node.tag.text)) || runs(node.template)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return !(node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isExportTarget(node.left)) || runs(node.right)
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return true
  return ts.forEachChild(node, (child) => (runs(child) ? true : undefined)) ?? false
}

/** A REST handler that can pass a request on (`next`), so it runs for other endpoints: inline with two parameters, or not inline on `all` or a wide path. */
function middlewareLike(n: RestNode): boolean {
  if (n.node.arguments.some(takesNext)) return true
  const x = unwrap(n.value as ts.Expression)
  if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return false
  return n.key.startsWith('ALL ') || isWidePath(n.key)
}

/** A Hono mount of a file version: its prefix as written and whether adding it runs no other code. */
export interface MountEntry {
  id: string
  prefix: string
  plain: boolean
}

/** The comparable parts of one file version. */
export interface FileEntries {
  entries: ResolverEntry[]
  rest: string[]
  loadCode: string[]
  imports: Set<string>
  mounts: Map<string, MountEntry>
  impure: Map<string, string>
  middleware: Set<string>
  properties: string[]
  /** Calls in source order, with the place they run. */
  calls: Call[]
}

/** The SDL of `gql` templates, compared on its own, member by member. Interpolated code is module code. */
function schemaTemplates(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && GQL_TAGS.has(node.tag.text)) {
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) out.push(node)
      else out.push(node.template.head, ...node.template.templateSpans.map((s) => s.literal))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Texts per key in source order: two apps can register the same path as written. */
function textsByKey(items: readonly { key: string; text: string }[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const { key, text } of items) out.set(key, out.has(key) ? `${out.get(key) ?? ''}\n${text}` : text)
  return out
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
): FileEntries {
  const { sourceFile: sf } = parseIsolated(file, code)
  const nodes = entryNodes(sf, typeFields, withRest)
  const entries = nodes.map(({ key, node }) => ({ key, file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: codeText(node, sf) }))
  // Everything outside the resolver members (helpers, module-level code), for "did anything else change". Imports are
  // compared as bindings: adding one is not a change to what existed.
  const imports = new Set<string>()
  // `new Hono()` builds an app and runs nothing else.
  const honoNames = new Set<string>()
  // Hono mounts are compared on their own (`mountId` → prefix as written), like the handlers.
  const readsHono = withRest && (hono || importsHono(sf))
  const mounts = readsHono ? mountNodes(sf, file) : []
  const removed: [number, number][] = [...nodes, ...mounts, ...schemaTemplates(sf).map((node) => ({ node }))].map(({ node }) => [node.getStart(sf), node.end])
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
  const blank = (node: ts.Node): string => codeText(node, sf, removed)
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
      if (runsCode(statement, honoNames) && !isBlank(text)) loadCode.push(text)
      continue
    }
    for (const prop of object.properties) {
      const text = blank(prop)
      items.push(text)
      properties.push(text)
      if (runsCode(prop, honoNames) && !isBlank(text)) loadCode.push(text)
    }
    items.push(blank(statement).replace(blank(object), '{}'))
  }
  // Handlers whose registration runs other code (`app.use(mw).get(…)`, `get('/x', rateLimit(), h)`), with the text of the
  // registration without the handler: the chain and the arguments are blanked with the handler. Handlers that can call
  // `next` run for other endpoints.
  const rest = nodes.filter((n): n is RestNode => 'receiver' in n)
  const impure = textsByKey(rest.filter((n) => !plainChain(n.receiver) || n.node.arguments.some((a) => runsCode(a, honoNames))).map((n) => ({ key: n.key, text: registrationText(n, sf) })))
  const middleware = new Set(rest.filter(middlewareLike).map((n) => n.key))
  const calls = withRest ? callOrder(sf, blank, new Set(rest.map((n) => n.node))) : []
  return { entries: entries.sort((a, b) => compareStrings(a.key, b.key)), rest: items, loadCode, imports, mounts: new Map(mounts.map((m) => [m.id, { id: m.id, prefix: m.prefix, plain: m.plain }])), impure, middleware, properties, calls }
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

/** Tokens as text for a message. */
const readable = (tokens: string): string => tokens.replace(/\s*([.,;()])\s*/g, '$1').replace(/,/g, ', ')

/** Items of `items` the base does not have, a copy of one counted as new. */
function newItems(items: readonly string[], base: readonly string[]): string[] {
  const left = new Map<string, number>()
  for (const b of base) left.set(b, (left.get(b) ?? 0) + 1)
  return items.filter((i) => {
    const n = left.get(i) ?? 0
    left.set(i, n - 1)
    return n <= 0
  })
}

export interface ResolverChanges {
  added: string[]
  removed: string[]
  changed: string[]
  /** Code outside the resolver members changed (imports, helpers, module-level code, the order of calls): every resolver may be affected. */
  restChanged: boolean
  /** A change that can reach every endpoint of the file's apps: module code, new load code, or a chain or handler that runs for others. */
  wide: boolean
  /** Hono mounts the head adds (a changed mount is removed and added). */
  addedMounts: MountEntry[]
  /** What is not additive besides entries: removed or changed mounts, new code that runs when the file loads or on a handler's chain. */
  problems: string[]
}

/** Resolver-level comparison of a changed resolver file: only resolvers whose own code changed are affected. */
export function diffResolvers(base: FileEntries, head: FileEntries): ResolverChanges {
  const before = textsByKey(base.entries)
  const after = textsByKey(head.entries)
  const added = [...after.keys()].filter((k) => !before.has(k)).sort(compareStrings)
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort(compareStrings)
  const changed = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k)).sort(compareStrings)
  const restChanged = base.rest.some((item) => !head.rest.includes(item)) || [...base.imports].some((i) => !head.imports.has(i))
  const newLoadCode = newItems(head.loadCode, base.rest)
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
      ...newLoadCode.map(readable).map((c) => `code that runs when the file loads was added: ${c.length > 80 ? `${c.slice(0, 77)}...` : c}`),
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
