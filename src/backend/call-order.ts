import ts from 'typescript'
import { codeText } from '../project/parse.js'

/** A call of a file and where it runs: its top-level statement and the block inside it. */
export interface Call {
  scope: string
  text: string
}

/** The code of a statement or a property is blank when it held only registrations. */
export const isBlank = (item: string): boolean => item === '' || item === ';'

/** The code a condition or a loop runs, a block or a `case`. */
function opensScope(node: ts.Node): boolean {
  const parent = node.parent
  return ts.isBlock(node) || ts.isCaseOrDefaultClause(node) || (ts.isIfStatement(parent) && node !== parent.expression) || (ts.isIterationStatement(parent, false) && node === parent.statement)
}

/**
 * Calls of a file in source order. `statementText` is the code of a statement without its registrations, so a new
 * handler does not change where the others run. The arguments of `handlers` are compared with the handler.
 */
export function callOrder(sf: ts.SourceFile, statementText: (s: ts.Statement) => string, handlers: ReadonlySet<ts.Node>): Call[] {
  const out: Call[] = []
  const copies = new Map<string, number>()
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) continue
    const text = statementText(statement)
    const copy = copies.get(text) ?? 0
    copies.set(text, copy + 1)
    const top = isBlank(text) ? '' : `${text}#${copy}`
    let blocks = 0
    const visit = (node: ts.Node, scope: string): void => {
      const here = opensScope(node) ? `${top}/${++blocks}` : scope
      if (ts.isCallExpression(node)) out.push({ scope: here, text: codeText(node, sf) })
      if (ts.isCallExpression(node) && handlers.has(node)) visit(node.expression, here)
      else ts.forEachChild(node, (child) => { visit(child, here) })
    }
    visit(statement, top)
  }
  return out
}

/** Items of `items` that `other` also has keep their order there (`other` may have new ones between them). */
function keepsOrder(items: readonly string[], other: readonly string[]): boolean {
  const kept = items.filter((i) => !isBlank(i) && other.includes(i))
  let at = 0
  for (const item of other) if (item === kept[at]) at++
  return at === kept.length
}

const placed = (c: Call): string => `${c.scope}\n${c.text}`

/** A call the head still has, but not in the place it had in the base. */
function movedCall(base: readonly Call[], head: readonly Call[]): boolean {
  const texts = new Set(head.map((c) => c.text))
  const places = new Set(head.map(placed))
  return base.some((c) => texts.has(c.text) && !places.has(placed(c)))
}

/** The parts of a file version that say where its code runs. */
export interface AppCode {
  rest: string[]
  calls: Call[]
  properties: string[]
}

/**
 * Whether a file with an app or handlers changed in a way the item comparison calls additive: statements or calls that
 * stayed changed order or place (`app.use(mw)` after the routes no longer runs for them; the first matching handler
 * serves a request; a handler moved to another factory has another path), or an object has a new property
 * (`use(cors(options))`).
 */
export function appCodeChanged(base: AppCode, head: AppCode): boolean {
  const texts = (a: AppCode): string[] => a.calls.map((c) => c.text)
  return !keepsOrder(base.rest, head.rest) || !keepsOrder(texts(base), texts(head)) || movedCall(base.calls, head.calls) || head.properties.some((p) => !isBlank(p) && !base.rest.includes(p))
}
