import ts from 'typescript'
import { isDeepStrictEqual } from 'node:util'
import { parseIsolated } from '../project/parse.js'
import type { RouteEntry, RouteTable } from '../routes/types.js'

export interface AdditiveResult {
  additive: boolean
  problems: string[]
}

export interface RouteChange {
  key: string
  path: string
  detail: string
}

function sameSignature(a: RouteEntry, b: RouteEntry): boolean {
  return a.entry === b.entry && isDeepStrictEqual(a.layouts, b.layouts) && isDeepStrictEqual(a.modules, b.modules)
}

function describeDifference(base: RouteEntry, head: RouteEntry): string {
  const parts: string[] = []
  if (base.entry !== head.entry) parts.push(`entry ${base.entry ?? 'none'} → ${head.entry ?? 'none'}`)
  if (!isDeepStrictEqual(base.layouts, head.layouts)) parts.push(`layouts [${base.layouts.join(', ')}] → [${head.layouts.join(', ')}]`)
  if (!isDeepStrictEqual(base.modules, head.modules)) parts.push(`modules [${base.modules.join(', ')}] → [${head.modules.join(', ')}]`)
  return parts.join('; ')
}

/** Base routes that disappeared or changed in the head (same key, entry module, layouts and referenced modules). */
export function compareRouteTables(base: RouteTable, head: RouteTable): RouteChange[] {
  const remaining = [...head.routes]
  const changed: RouteChange[] = []
  for (const route of base.routes) {
    const exact = remaining.findIndex((h) => h.key === route.key && sameSignature(route, h))
    if (exact !== -1) {
      remaining.splice(exact, 1)
      continue
    }
    const sameKey = remaining.find((h) => h.key === route.key)
    changed.push({ key: route.key, path: route.path, detail: sameKey ? `route ${route.path} changed: ${describeDifference(route, sameKey)}` : `route ${route.path} (${route.key}) was removed` })
  }
  return changed
}

/** Bindings of the import declarations of a file, per module specifier. */
function importBindings(sf: ts.SourceFile): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const set = result.get(statement.moduleSpecifier.text) ?? new Set<string>()
    result.set(statement.moduleSpecifier.text, set)
    for (const b of declarationBindings(statement)) set.add(b)
  }
  return result
}

function declarationBindings(decl: ts.ImportDeclaration): string[] {
  const clause = decl.importClause
  if (!clause) return []
  const bindings: string[] = []
  if (clause.name) bindings.push(`default as ${clause.name.text}`)
  const named = clause.namedBindings
  if (named && ts.isNamespaceImport(named)) bindings.push(`* as ${named.name.text}`)
  if (named && ts.isNamedImports(named)) for (const el of named.elements) bindings.push(`${(el.propertyName ?? el.name).text} as ${el.name.text}`)
  return bindings
}

/**
 * Removed lines of a routes file that are not explained by a widened import: a base import declaration whose
 * module is still imported in the head with every one of its bindings (adding `b` to `import { a } from "./m"`
 * rewrites the line without changing anything that existed). Any parse problem leaves every line unexplained.
 */
export function unexplainedRemovedLines(file: string, baseCode: string, headCode: string, removed: readonly number[]): number[] {
  if (removed.length === 0) return []
  const base = parseIsolated(file, baseCode)
  const head = parseIsolated(file, headCode)
  if (base.errors.length > 0 || head.errors.length > 0) return [...removed]
  const headImports = importBindings(head.sourceFile)
  const explained = new Set<number>()
  for (const statement of base.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const headSet = headImports.get(statement.moduleSpecifier.text)
    if (!headSet || !declarationBindings(statement).every((b) => headSet.has(b))) continue
    const first = base.sourceFile.getLineAndCharacterOfPosition(statement.getStart(base.sourceFile)).line + 1
    const last = base.sourceFile.getLineAndCharacterOfPosition(statement.end).line + 1
    for (let line = first; line <= last; line++) explained.add(line)
  }
  return removed.filter((line) => !explained.has(line))
}

function normalizedText(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, ' ').trim()
}

/**
 * What an export declaration exports, one key per binding: `type? <module>:<name> as <alias>`, `<module>:*` or
 * `<module>:* as <ns>` (`<module>` is empty for local exports).
 */
function exportBindings(statement: ts.ExportDeclaration): string[] {
  const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''
  const clause = statement.exportClause
  if (!clause) return [`${statement.isTypeOnly ? 'type ' : ''}${from}:*`]
  if (ts.isNamespaceExport(clause)) return [`${statement.isTypeOnly ? 'type ' : ''}${from}:* as ${clause.name.text}`]
  return clause.elements.map((el) => `${statement.isTypeOnly || el.isTypeOnly ? 'type ' : ''}${from}:${(el.propertyName ?? el.name).text} as ${el.name.text}`)
}

/**
 * Barrel rule: the file only contains export declarations and every binding the base exports is exported by the
 * head the same way (same module, name and type-only flag). Adding a name to an existing list is like adding a
 * declaration: nothing that existed changes.
 */
export function checkBarrelAdditive(file: string, baseCode: string, headCode: string): AdditiveResult {
  const base = parseIsolated(file, baseCode)
  const head = parseIsolated(file, headCode)
  const problems: string[] = []
  if (base.errors.length > 0) problems.push(`the base version does not parse: ${base.errors[0]?.message ?? ''}`)
  if (head.errors.length > 0) problems.push(`the head version does not parse: ${head.errors[0]?.message ?? ''}`)
  if (problems.length > 0) return { additive: false, problems }
  const baseOther = base.sourceFile.statements.find((s) => !ts.isExportDeclaration(s))
  const headOther = head.sourceFile.statements.find((s) => !ts.isExportDeclaration(s))
  const versions = baseOther && headOther ? 'the file contains' : baseOther ? 'the base version contains' : 'the head version contains'
  const other = headOther ? normalizedText(headOther, head.sourceFile) : baseOther ? normalizedText(baseOther, base.sourceFile) : undefined
  if (other !== undefined) problems.push(`${versions} a statement that is not an export declaration (not a pure barrel): "${other.slice(0, 80)}"`)
  const headBindings = new Set(head.sourceFile.statements.flatMap((s) => (ts.isExportDeclaration(s) ? exportBindings(s) : [])))
  for (const s of base.sourceFile.statements) {
    if (ts.isExportDeclaration(s) && !exportBindings(s).every((b) => headBindings.has(b))) problems.push(`export removed or changed: "${normalizedText(s, base.sourceFile)}"`)
  }
  return { additive: problems.length === 0, problems }
}

export class JsonParseError extends Error {}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new JsonParseError(`the ${label} version is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareJson(base: unknown, head: unknown, path: string, problems: string[]): void {
  if (isPlainObject(base)) {
    if (!isPlainObject(head)) {
      problems.push(`${path || '(root)'} is no longer an object`)
      return
    }
    for (const key of Object.keys(base)) {
      const child = path === '' ? key : `${path}.${key}`
      if (!Object.hasOwn(head, key)) problems.push(`key ${child} was removed`)
      else compareJson(base[key], head[key], child, problems)
    }
    return
  }
  if (!isDeepStrictEqual(base, head)) problems.push(`value of ${path || '(root)'} changed`)
}

/** i18n rule: every base key exists in the head with the same value (deep comparison). Throws JsonParseError. */
export function checkI18nAdditive(baseText: string, headText: string): AdditiveResult {
  const base = parseJson(baseText, 'base')
  const head = parseJson(headText, 'head')
  const problems: string[] = []
  compareJson(base, head, '', problems)
  return { additive: problems.length === 0, problems }
}

/**
 * Whether a TS file only declares types (interfaces, type aliases, type-only imports/exports, ambient declarations):
 * emitters erase all of it, so changing it cannot change runtime behavior. Enums and namespaces with values do not count.
 */
export function isTypeOnlyModule(file: string, code: string): boolean {
  if (!/\.(ts|tsx|mts|cts)$/.test(file)) return false
  const { sourceFile: sf, errors } = parseIsolated(file, code)
  if (errors.length > 0) return false
  return sf.statements.every((s) => {
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) return true
    // Bindings imported into a file that only declares types can only be used in type positions: erased. A side-effect
    // import (`import './x'`) runs code, so it does not count.
    if (ts.isImportDeclaration(s)) return s.importClause !== undefined
    if (ts.isExportDeclaration(s)) return s.isTypeOnly || (s.exportClause !== undefined && ts.isNamedExports(s.exportClause) && s.exportClause.elements.every((e) => e.isTypeOnly))
    const modifiers = ts.canHaveModifiers(s) ? (ts.getModifiers(s) ?? []) : []
    return modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) && !ts.isEnumDeclaration(s) && !ts.isVariableStatement(s)
  })
}

const SCRIPT_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
/** Comments that change emitted or bundled code: JSX pragmas, pure annotations, bundler hints. */
const CODE_COMMENT = /@jsx|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|webpack[A-Z]|@vite-ignore/
const PRINTER = ts.createPrinter({ removeComments: true })

/**
 * The comments of a file that change emitted or bundled code, each whole and with the index of the code token it sits
 * before: the same marker before another call or import is a different comment.
 */
function codeComments(sf: ts.SourceFile): string[] {
  const out: string[] = []
  let index = 0
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sf)
    if (children.length > 0) {
      for (const child of children) visit(child)
      return
    }
    // Comments between the previous token and this one: on the previous token's line (trailing) or below it (leading).
    const start = node.getFullStart()
    const ranges = [...(ts.getTrailingCommentRanges(sf.text, start) ?? []), ...(ts.getLeadingCommentRanges(sf.text, start) ?? [])]
    for (const pos of new Set(ranges.map((r) => r.pos))) {
      const r = ranges.find((x) => x.pos === pos)
      const text = r === undefined ? '' : sf.text.slice(r.pos, r.end)
      if (CODE_COMMENT.test(text)) out.push(`${index}\u0000${text}`)
    }
    index++
  }
  visit(sf)
  return out
}

/**
 * Whether a JS/TS file changed only in comments or formatting: both versions print the same with the TypeScript printer
 * (comments removed, layout normalized; JSX text stays text), and the comments that change emitted or bundled code are
 * the same, in the same places. A file that does not parse is never comments-only.
 */
export function isCommentsOnlyChange(file: string, base: string, head: string): boolean {
  if (!SCRIPT_FILE.test(file)) return false
  const parse = (code: string): ts.SourceFile | null => {
    const { sourceFile, errors } = parseIsolated(file, code)
    return errors.length > 0 ? null : sourceFile
  }
  const before = parse(base)
  const after = parse(head)
  if (before === null || after === null || PRINTER.printFile(before) !== PRINTER.printFile(after)) return false
  return isDeepStrictEqual(codeComments(before), codeComments(after))
}
