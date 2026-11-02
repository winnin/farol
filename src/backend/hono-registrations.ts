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
  // A named handler is middleware when its function takes `next`; one farol cannot find is, on `all` or a wide path.
  const namedNext = (call: AppCall): boolean => {
    const last = call.arguments[call.arguments.length - 1]
    if (!last) return false
    const x = unwrap(last)
    if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return false
    const fn = r.functionOf(last)
    return fn ? hasNextParameter(fn) : call.expression.name.text === 'all' || isWidePath(literal(call.arguments[0]) ?? '*')
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
  /** A middleware argument whose code comes from the callers or can change: a parameter or a variable that is not `const`, also through a property, a call, a condition or a literal. */
  const unknownCode = (arg: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const x = ts.isSpreadElement(arg) ? unwrap(arg.expression) : unwrap(arg)
    if (seen.has(x)) return false
    seen.add(x)
    if (x.kind === ts.SyntaxKind.ThisKeyword) return true
    if (ts.isPropertyAccessExpression(x)) return unknownCode(x.expression, seen) || unknownCode(x.name, seen)
    if (ts.isElementAccessExpression(x) || ts.isCallExpression(x)) return unknownCode(x.expression, seen)
    if (ts.isArrayLiteralExpression(x)) return x.elements.some((e) => unknownCode(e, seen))
    if (ts.isConditionalExpression(x)) return unknownCode(x.whenTrue, seen) || unknownCode(x.whenFalse, seen)
    if (ts.isBinaryExpression(x)) return unknownCode(x.left, seen) || unknownCode(x.right, seen)
    if (ts.isObjectLiteralExpression(x)) return x.properties.some((p) => (ts.isPropertyAssignment(p) ? unknownCode(p.initializer, seen) : ts.isShorthandPropertyAssignment(p) ? unknownCode(p.name, seen) : ts.isSpreadAssignment(p) && unknownCode(p.expression, seen)))
    if (!ts.isIdentifier(x)) return false
    let decl: ts.Node | undefined = r.declOf(x)
    while (decl && ts.isBindingElement(decl)) decl = decl.parent.parent
    if (!decl || decl.getSourceFile().isDeclarationFile) return false
    if (ts.isParameter(decl)) return true
    if (!ts.isVariableDeclaration(decl)) return false
    if (!decl.initializer || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return true
    return unknownCode(decl.initializer, seen)
  }
  return { registrationOf, unknownCode }
}
