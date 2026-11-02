import ts from 'typescript'
import { isStaticValue, unwrap } from '../project/parse.js'

export const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'options', 'head', 'all'])

/** Receivers that register routes; with any other receiver (`http.post(url, body)`) only an inline function is a handler. */
const SERVERS = new Set(['app', 'fastify', 'server', 'router', 'instance', 'api', 'routes', 'express', 'srv'])

function receiverName(call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined
  let target: ts.Expression = call.expression.expression
  while (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) target = target.expression.expression
  return ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : undefined
}

function isHandler(node: ts.Node | undefined, call: ts.CallExpression): node is ts.Expression {
  if (node === undefined || call.typeArguments) return false
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true
  return (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && SERVERS.has(receiverName(call) ?? '')
}

/** A function with a second parameter, also through a rest parameter: Hono passes `next` there. */
export const hasNextParameter = (fn: ts.SignatureDeclaration): boolean => fn.parameters.length >= 2 || fn.parameters.some((p) => p.dotDotDotToken !== undefined)

/** An inline function that takes `next`. */
export function takesNext(a: ts.Expression): boolean {
  const x = unwrap(a)
  return (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) && hasNextParameter(x)
}

/** A path that serves many requests (`*`, or a `{…}` pattern): a named handler there is treated as middleware. */
export const isWidePath = (path: string): boolean => path.includes('*') || path.includes('{')

export function literal(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
}

function objectProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name) && p.name.text === name) return p as unknown as ts.Expression
  }
  return undefined
}

/** A REST handler registration; `receiver` is the expression the method is called on (`routes` in `routes.get(…)`). */
export interface RestNode {
  key: string
  node: ts.CallExpression
  value: ts.Node
  receiver: ts.Expression
  /** Middleware arguments before the handler: they run for this route only. */
  guards: ts.Expression[]
}

/**
 * REST endpoints registered in a file (Fastify and Express styles): `app.get('/path', handler)`,
 * `router.route('/path').post(handler)` and `fastify.route({ method, url, handler })`. Prefixes added by
 * `register(…, { prefix })` or `app.use('/api', router)` are not applied: paths are as written.
 */
export function restNodes(sf: ts.SourceFile): RestNode[] {
  const out: RestNode[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const args = node.arguments
      const last = args[args.length - 1]
      if (METHODS.has(method) && args.length >= 2 && isHandler(last, node)) {
        const path = literal(args[0])
        if (path !== undefined && (path.startsWith('/') || path === '*')) out.push({ key: `${method === 'del' ? 'DELETE' : method.toUpperCase()} ${path}`, node, value: last, receiver: node.expression.expression, guards: args.slice(1, -1) })
        // router.route('/path').get(handler)
        const target = node.expression.expression
        if (path === undefined && ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === 'route') {
          const routePath = literal(target.arguments[0])
          if (routePath !== undefined) out.push({ key: `${method.toUpperCase()} ${routePath}`, node, value: last, receiver: node.expression.expression, guards: args.slice(0, -1) })
        }
      } else if (METHODS.has(method) && args.length === 1 && isHandler(args[0], node)) {
        const target = node.expression.expression
        if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === 'route') {
          const routePath = literal(target.arguments[0])
          if (routePath !== undefined) out.push({ key: `${method.toUpperCase()} ${routePath}`, node, value: args[0], receiver: node.expression.expression, guards: [] })
        }
      } else if (method === 'route' && args.length === 1 && args[0] && ts.isObjectLiteralExpression(args[0])) {
        const methods = objectProp(args[0], 'method')
        const url = literal(objectProp(args[0], 'url')) ?? literal(objectProp(args[0], 'path'))
        const handler = objectProp(args[0], 'handler')
        const names = methods && ts.isArrayLiteralExpression(methods) ? methods.elements.map((e) => literal(e)) : [literal(methods)]
        if (url !== undefined && handler) for (const m of names) if (m !== undefined) out.push({ key: `${m.toUpperCase()} ${url}`, node, value: handler, receiver: node.expression.expression, guards: [args[0]] })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** `a`, `this`, `a.b.c`: a reference that runs no code. */
function nameChain(e: ts.Expression): boolean {
  return ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword || (ts.isPropertyAccessExpression(e) && nameChain(e.expression))
}

/** An argument of a registration that runs no code: a static value, or a function (a handler is only defined). */
function plainArgument(e: ts.Expression): boolean {
  const x = unwrap(e)
  return ts.isArrowFunction(x) || ts.isFunctionExpression(x) || isStaticValue(x, 0, false)
}

/** A mount target that runs no code: a name, or a call of a named function with static arguments (no calls). */
export function plainTarget(e: ts.Expression): boolean {
  const x = unwrap(e)
  if (nameChain(x)) return true
  return ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.arguments.every((a) => !ts.isSpreadElement(a) && isStaticValue(a, 0, false))
}

/**
 * A receiver that runs no code besides registrations: a name, or handler registrations and `route()` calls on one,
 * with static or function arguments (`app.get('/a', h).route('/b', sub)`). `app.use(mw).get(…)` is not plain.
 */
export function plainChain(e: ts.Expression): boolean {
  const x = unwrap(e)
  if (nameChain(x)) return true
  if (!ts.isCallExpression(x) || !ts.isPropertyAccessExpression(x.expression) || !plainChain(x.expression.expression)) return false
  const name = x.expression.name.text
  const [prefix, target] = x.arguments
  if (name === 'route' && x.arguments.length === 2 && prefix && target) return plainArgument(prefix) && plainTarget(target)
  return (METHODS.has(name) || name === 'route') && x.arguments.every((a) => !ts.isSpreadElement(a) && plainArgument(a))
}

/** Anchor of a REST handler: its file and its path as written (one handler, whatever the mounts above it). */
export function restAnchor(file: string, key: string): string {
  return `${file} ${key}`
}
