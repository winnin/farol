import ts from 'typescript'
import { unwrap } from '../project/parse.js'
import type { AppResolver } from './hono-resolver.js'
import { hasNextParameter, isWidePath, literal, METHODS, takesNext } from './rest.js'

export type AppCall = ts.CallExpression & { expression: ts.PropertyAccessExpression }

/** Hono's `on(method, path, ...handlers)` has three arguments or more (`process.on(event, fn)` has two); `onError` has one. */
export function installsOnApp(call: AppCall): boolean {
  const name = call.expression.name.text
  return name === 'use' || (name === 'on' && call.arguments.length >= 3) || (name === 'onError' && call.arguments.length === 1)
}

/** How a call installs code on an app, and whether farol can find a middleware argument's code. */
export function registrationReader(r: AppResolver) {
  // A named handler on `all` or a `*` path is middleware when its function takes `next`, or when farol cannot find it.
  const namedNext = (call: AppCall): boolean => {
    const last = call.arguments[call.arguments.length - 1]
    if (!last || (call.expression.name.text !== 'all' && !isWidePath(literal(call.arguments[0]) ?? '*'))) return false
    const x = unwrap(last)
    if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return false
    const fn = r.functionOf(last)
    return fn ? hasNextParameter(fn) : true
  }
  /** Path and code of a call that installs code on its app; a path farol cannot read covers the whole app. */
  const registrationOf = (call: AppCall): { path: string; args: ts.Expression[] } | undefined => {
    const name = call.expression.name.text
    if (name === 'onError') return installsOnApp(call) ? { path: '*', args: [...call.arguments] } : undefined
    if (name === 'on') return installsOnApp(call) ? { path: literal(call.arguments[1]) ?? '*', args: call.arguments.slice(2) } : undefined
    if (name !== 'use' && !(METHODS.has(name) && (call.arguments.some(takesNext) || namedNext(call)))) return undefined
    const path = literal(call.arguments[0])
    return { path: path ?? '*', args: path === undefined ? [...call.arguments] : call.arguments.slice(1) }
  }
  /** A middleware argument whose code comes from the callers: a parameter, also through a property, a call or a variable. */
  const unknownCode = (arg: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const x = ts.isSpreadElement(arg) ? unwrap(arg.expression) : unwrap(arg)
    if (seen.has(x)) return false
    seen.add(x)
    if (x.kind === ts.SyntaxKind.ThisKeyword) return true
    if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x) || ts.isCallExpression(x)) return unknownCode(x.expression, seen)
    if (!ts.isIdentifier(x)) return false
    let decl: ts.Node | undefined = r.declOf(x)
    while (decl && ts.isBindingElement(decl)) decl = decl.parent.parent
    if (!decl || decl.getSourceFile().isDeclarationFile) return false
    if (ts.isParameter(decl)) return true
    if (!ts.isVariableDeclaration(decl)) return false
    return decl.initializer ? unknownCode(decl.initializer, seen) : true
  }
  return { registrationOf, unknownCode }
}
