import ts from 'typescript'

/** `import type …` (the `isTypeOnly` flag is deprecated in TypeScript 6 in favor of `phaseModifier`). */
export function isTypeOnlyImport(clause: ts.ImportClause): boolean {
  return clause.phaseModifier === ts.SyntaxKind.TypeKeyword
}

/** `baseUrl` is deprecated in TypeScript 6 but projects still use it, and resolution still honors it. */
export function getBaseUrl(options: ts.CompilerOptions): string | undefined {
  const value = (options as { baseUrl?: unknown }).baseUrl
  return typeof value === 'string' ? value : undefined
}

export interface IsolatedParse {
  sourceFile: ts.SourceFile
  errors: { line: number; message: string }[]
}

export function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS
  if (fileName.endsWith('.json')) return ts.ScriptKind.JSON
  return ts.ScriptKind.TS
}

/** Parses one file on its own (no program), with its syntax errors. */
export function parseIsolated(fileName: string, code: string): IsolatedParse {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, scriptKindFor(fileName))
  // `parseDiagnostics` is where the parser stores syntax errors; it is not in the public typings.
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics === undefined) throw new Error('internal: TypeScript did not expose parse diagnostics for an isolated file')
  const errors = diagnostics.map((d) => ({
    line: d.start === undefined ? 1 : sourceFile.getLineAndCharacterOfPosition(d.start).line + 1,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  }))
  return { sourceFile, errors }
}

/** Statements that can end without a `;`: the parser's reading of a line break must count (`return\n1` is not `return 1`). */
const ENDS_WITH_SEMICOLON = new Set([
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.DebuggerStatement,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
])

/** JSX text as React reads it: lines without their indent, joined by a space. Spaces on one line count, and only spaces and tabs are indent. */
function jsxText(text: string): string {
  const lines = text.split(/\r\n|\n|\r/)
  return lines.map((line, i) => (i === 0 ? line : line.replace(/^[ \t]+/, ''))).map((line, i) => (i === lines.length - 1 ? line : line.replace(/[ \t]+$/, ''))).filter((line) => line !== '').join(' ')
}

/** A closing token whose trailing comma only formats: in an array, a comma after a last hole counts that hole. */
function closesTrailingComma(n: ts.Node, text: string): boolean {
  if (text === ']' && ts.isArrayLiteralExpression(n.parent)) {
    const last = n.parent.elements[n.parent.elements.length - 1]
    return last === undefined || !ts.isOmittedExpression(last)
  }
  return text === '}' || text === ')' || text === ']'
}

/**
 * The code of a node as the parser read it, without comments or formatting: strings, templates, regular expressions
 * and JSX text are one token each, every statement ends with one `;`, a trailing comma in `{}`, `()` or `[]` does not count, and
 * text the parser skipped is kept. Nodes in `removed` (ranges of the file) are left out, with the comma after them.
 */
export function codeTokens(node: ts.Node, sf: ts.SourceFile, removed: readonly (readonly [number, number])[] = []): string[] {
  const out: string[] = []
  let at = node.getStart(sf)
  const isRemoved = (n: ts.Node): boolean => {
    const start = n.getStart(sf)
    return n.end > start && removed.some(([a, b]) => start >= a && n.end <= b)
  }
  const visit = (n: ts.Node): void => {
    const children = n.getChildren(sf).filter((c) => !ts.isJSDoc(c))
    if (children.length === 0) {
      const skipped = sf.text.slice(at, n.pos).trim()
      if (skipped) out.push(skipped)
      const text = n.kind === ts.SyntaxKind.JsxText ? jsxText(sf.text.slice(n.pos, n.end)) : n.getText(sf)
      if (closesTrailingComma(n, text) && out[out.length - 1] === ',') out.pop()
      if (text && !(text === ';' && out[out.length - 1] === ';')) out.push(text)
      at = Math.max(at, n.end)
    }
    children.forEach((child, i) => {
      const previous = children[i - 1]
      if (child.kind === ts.SyntaxKind.CommaToken && previous && isRemoved(previous)) at = child.end
      else if (isRemoved(child)) at = child.end
      else visit(child)
    })
    if (ENDS_WITH_SEMICOLON.has(n.kind) && out[out.length - 1] !== ';') out.push(';')
  }
  if (!isRemoved(node)) visit(node)
  return out
}

/** The tokens of a node as one comparable string. */
export const codeText = (node: ts.Node, sf: ts.SourceFile, removed?: readonly (readonly [number, number])[]): string => codeTokens(node, sf, removed).join(' ')

/** The expression inside parentheses, `as`, `satisfies`, `!` and `<T>x`. */
export function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression
  return e
}

/**
 * An expression that only builds a value: literals, objects and arrays of them, references, `as const`; an arrow
 * function that only returns such a value (`(p) => ({ key: 'x', p })`); a call of a named function with such
 * arguments only, none of them a call (`defineKeys({ … })`, a typed identity wrapper). No other functions, statements or JSX.
 */
export function isStaticValue(e: ts.Expression, depth = 0, calls = true): boolean {
  if (depth > 20) return false
  const value = (x: ts.Expression): boolean => isStaticValue(x, depth + 1, calls)
  if (ts.isArrowFunction(e)) return !ts.isBlock(e.body) && value(e.body)
  // The wrapper takes the declared value: at least one argument, and no call inside its arguments.
  if (ts.isCallExpression(e)) return calls && (ts.isIdentifier(e.expression) || ts.isPropertyAccessExpression(e.expression)) && value(e.expression) && e.arguments.length > 0 && e.arguments.every((a) => !ts.isSpreadElement(a) && isStaticValue(a, depth + 1, false))
  if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isBigIntLiteral(e) || ts.isRegularExpressionLiteral(e)) return true
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) return ts.isIdentifier(e) || value(e.expression)
  if (ts.isPrefixUnaryExpression(e)) return (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) && value(e.operand)
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) return value(e.expression)
  if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => value(s.expression))
  if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => (ts.isSpreadElement(x) ? value(x.expression) : value(x)))
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every((p) => {
      if (ts.isPropertyAssignment(p)) return (!ts.isComputedPropertyName(p.name) || value(p.name.expression)) && value(p.initializer)
      if (ts.isShorthandPropertyAssignment(p)) return true
      if (ts.isSpreadAssignment(p)) return value(p.expression)
      return false
    })
  }
  return false
}
