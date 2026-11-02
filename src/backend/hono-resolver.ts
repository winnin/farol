import ts from 'typescript'
import { unwrap } from '../project/parse.js'
import { METHODS } from './rest.js'

/** App methods that return the app itself: a chained call stays on the same app. */
const SAME_APP = new Set([...METHODS, 'route', 'use', 'on', 'onError', 'notFound'])

/** A Hono app: a `new Hono()` expression or a parameter typed `Hono`. */
export type App = ts.NewExpression | ts.ParameterDeclaration

export type AppResolver = ReturnType<typeof appResolver>

export const isHonoModule = (spec: string): boolean => spec === 'hono' || spec.startsWith('hono/') || spec.startsWith('@hono/')

/** Whether a file imports or re-exports from a hono package (syntax only). */
export function importsHono(sf: ts.SourceFile): boolean {
  return sf.statements.some((s) => (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier !== undefined && ts.isStringLiteral(s.moduleSpecifier) && isHonoModule(s.moduleSpecifier.text))
}

/** Expression returned by a function: every `return` of its own body (nested functions skipped), or an arrow's body. */
function returnsOf(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!fn.body) return []
  if (!ts.isBlock(fn.body)) return [fn.body]
  const out: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) out.push(node.expression)
      return
    }
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn.body, visit)
  return out
}

/** Resolution of expressions to Hono apps with the type checker (works without node_modules: names are read on imports). */
export function appResolver(checker: ts.TypeChecker) {
  const declOf = (id: ts.MemberName): ts.Declaration | undefined => {
    const symbol = ts.isShorthandPropertyAssignment(id.parent) ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id)
    const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    return target?.valueDeclaration ?? target?.declarations?.[0]
  }
  /** `Hono` of a hono package, also through project re-exports (`export { Hono } from 'hono'`), `import type` and `as`. */
  const isHonoName = (id: ts.Node): boolean => {
    let symbol = ts.isIdentifier(id) ? checker.getSymbolAtLocation(id) : undefined
    for (let depth = 0; symbol && depth < 10; depth++) {
      const decl = symbol.declarations?.[0]
      if (!decl || !(ts.isImportSpecifier(decl) || ts.isExportSpecifier(decl))) return false
      const spec = ts.isImportSpecifier(decl) ? decl.parent.parent.parent.moduleSpecifier : decl.parent.parent.moduleSpecifier
      if (spec && ts.isStringLiteral(spec) && isHonoModule(spec.text)) return (decl.propertyName ?? decl.name).text === 'Hono'
      symbol = checker.getImmediateAliasedSymbol(symbol)
    }
    return false
  }
  /** A file that imports from hono, or from a project module that re-exports it. */
  const usesHono = (sf: ts.SourceFile): boolean =>
    importsHono(sf) ||
    sf.statements.some((s) => {
      const module = ts.isImportDeclaration(s) ? checker.getSymbolAtLocation(s.moduleSpecifier)?.valueDeclaration : undefined
      return module !== undefined && ts.isSourceFile(module) && importsHono(module)
    })
  const isHonoParam = (p: ts.ParameterDeclaration): boolean => p.type !== undefined && ts.isTypeReferenceNode(p.type) && isHonoName(p.type.typeName)
  const functionOf = (callee: ts.Expression): ts.FunctionLikeDeclaration | undefined => {
    const e = unwrap(callee)
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e
    const d = ts.isIdentifier(e) ? declOf(e) : ts.isPropertyAccessExpression(e) ? declOf(e.name) : undefined
    if (!d || d.getSourceFile().isDeclarationFile) return undefined
    if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) return d
    const init = ts.isVariableDeclaration(d) && d.initializer ? unwrap(d.initializer) : undefined
    return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined
  }
  const appOf = (expr: ts.Expression, seen = new Set<ts.Node>()): App | undefined => {
    const e = unwrap(expr)
    if (seen.has(e)) return undefined
    seen.add(e)
    if (ts.isNewExpression(e)) return isHonoName(e.expression) ? e : undefined
    if (ts.isIdentifier(e)) {
      const d = declOf(e)
      if (d && ts.isParameter(d)) return isHonoParam(d) ? d : undefined
      if (d && ts.isVariableDeclaration(d) && d.initializer) return appOf(d.initializer, seen)
      return d && ts.isExportAssignment(d) ? appOf(d.expression, seen) : undefined
    }
    if (!ts.isCallExpression(e)) return undefined
    if (ts.isPropertyAccessExpression(e.expression) && SAME_APP.has(e.expression.name.text)) {
      const app = appOf(e.expression.expression, seen)
      if (app) return app
    }
    const fn = functionOf(e.expression)
    const apps = fn ? returnsOf(fn).map((r) => appOf(r, new Set(seen))) : []
    return apps.length > 0 && apps.every((a) => a !== undefined && a === apps[0]) ? apps[0] : undefined
  }
  return { declOf, usesHono, isHonoParam, functionOf, appOf }
}
