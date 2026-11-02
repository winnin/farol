import { describe, expect, it } from 'vitest'
import { buildBackendTable } from '../../src/backend/entrypoints.js'
import { mountNodes, UNRESOLVED_APP } from '../../src/backend/hono.js'
import { mergePath, overlaps } from '../../src/backend/hono-paths.js'
import { diffResolvers, resolverEntries } from '../../src/backend/resolvers.js'
import { parseIsolated } from '../../src/project/parse.js'
import { memoryProject, ROOT } from '../helpers/memory.js'

function table(files: Record<string, string>) {
  return buildBackendTable({ project: memoryProject(files, 'src/main.ts'), repoRoot: ROOT, files: Object.keys(files), read: (f) => files[f], isOrigin: () => true, graphql: false, rest: true, context: {} })
}

const keys = (files: Record<string, string>): string[] => table(files).operations.map((o) => o.key)
const dynamic = (files: Record<string, string>): string[] => table(files).dynamic.map((d) => `${d.file}:${d.line} ${d.detail}`)

const items = `import { Hono } from 'hono'
export function createItems() {
  const routes = new Hono()
  routes.get('/', (c) => {
    return c.json([])
  })
  routes.get('/:id', (c) => c.json({}))
  return routes
}
`

describe('Hono middleware placement', () => {
  const app = (body: string) => `import { Hono } from 'hono'\nimport { deps } from './deps'\nimport { mw } from './mw'\nexport const app = new Hono()\n${body}\n`
  const base = { 'src/deps.ts': "import type { Hono } from 'hono'\nexport const deps = {} as { app: Hono }\n", 'src/mw.ts': 'export const mw = async (_c: unknown, next: () => Promise<void>) => { await next() }\n' }

  it('an onError on an app farol cannot follow is a dynamic route', () => {
    expect(dynamic({ ...base, 'src/main.ts': app('deps.app.onError(mw)') })).toEqual(['src/main.ts:5 Hono onError() is on an app farol cannot follow: its middleware cannot be placed'])
  })

  it('a parameter as middleware is a dynamic route: its code comes from the callers', () => {
    expect(dynamic({ ...base, 'src/main.ts': app("export function install(handler: never) {\n  app.use('*', handler)\n}") })).toEqual(['src/main.ts:6 Hono middleware comes from a parameter or a variable that can change: farol cannot find its code'])
  })

  it('a parameter as a guard before the handler is a dynamic route', () => {
    expect(dynamic({ ...base, 'src/main.ts': app("export function install(guard: never) {\n  app.post('/x', guard, (c) => c.text('ok'))\n}") })).toEqual(['src/main.ts:6 Hono middleware comes from a parameter or a variable that can change: farol cannot find its code'])
  })

  it.each([
    ['a property of a parameter', 'deps: { auth: never }', "app.use('*', deps.auth)"],
    ['a destructured parameter', '{ auth }: { auth: never }', "app.use('*', auth)"],
    ['a spread parameter', 'mws: never[]', "app.use('*', ...mws)"],
    ['a variable set from a parameter', 'auth: never', "const held = auth\n  app.use('*', held)"],
    ['a call of a parameter', 'make: () => never', "app.use('*', make())"],
    ['a variable with no initial value', '', "let held: never\n  app.use('*', held)"],
    ['a branch of a conditional', 'mw: never, on: boolean', "app.use('*', on ? mw : other)"],
    ['an operand of ??', 'mw: never', "app.use('*', mw ?? other)"],
    ['an operand of ||', 'mw: never', "app.use('*', mw || other)"],
    ['a guard in a conditional', 'mw: never, on: boolean', "app.post('/x', on ? mw : other, (c) => c.text('ok'))"],
    ['a spread conditional', 'mws: never[], on: boolean', "app.use('*', ...(on ? mws : []))"],
    ['a property of a local object', 'mw: never', "const held = { m: mw }\n  app.use('*', held.m)"],
    ['a shorthand property of a local object', 'mw: never', "const held = { mw }\n  app.use('*', held.mw)"],
    ['a property of a destructured local object', 'mw: never', "const { m } = { m: mw }\n  app.use('*', m)"],
    ['a variable that is set again', 'mw: never, on: boolean', "let held = other\n  if (on) held = mw\n  app.use('*', held)"],
    ['the last argument of a handler call', 'h: never', "app.get('/x', h)"],
    ['a spread last argument of a handler call', 'hs: never[]', "app.get('/x', ...hs)"],
  ])('%s as middleware is a dynamic route', (_name, params, body) => {
    const details = table({ ...base, 'src/main.ts': app(`const other = (c: never) => c\nexport function install(${params}) {\n  ${body}\n}`) }).dynamic.map((d) => d.detail)
    expect(details).toEqual(['Hono middleware comes from a parameter or a variable that can change: farol cannot find its code'])
  })

  it.each([
    ['a const handler', "const h = (c: never) => c\n  app.get('/x', h)"],
    ['a conditional between known functions', "const a = (c: never) => c\n  const b = (c: never) => c\n  app.use('*', Math.random() ? a : b)"],
    ['a call of a known function with a parameter', "const make = (o: unknown) => (c: never) => (o, c)\n  app.use('*', make(opt))"],
  ])('%s is not a dynamic route', (_name, body) => {
    expect(table({ ...base, 'src/main.ts': app(`export function install(opt: unknown) {\n  ${body}\n}`) }).dynamic).toEqual([])
  })

  it('an imported function called on its module keeps the mount above the app it receives', () => {
    const files = {
      'src/main.ts': "import { Hono } from 'hono'\nimport * as routes from './routes'\nexport const app = new Hono()\nconst api = new Hono()\napp.route('/api', api)\nroutes.register(api)\n",
      'src/routes.ts': "import type { Hono } from 'hono'\nexport function register(app: Hono) {\n  app.get('/users', (c) => c.text('u'))\n}\n",
    }
    expect(keys(files)).toEqual(['GET /api/users'])
    expect(dynamic(files)).toEqual([])
  })

  it('an app passed to a project function whose parameter is not typed Hono is a dynamic route', () => {
    expect(dynamic({
      'src/main.ts': "import { Hono } from 'hono'\nimport { install } from './install'\nexport const app = new Hono()\ninstall(app)\n",
      'src/install.ts': 'export function install(target: any) {\n  target.use(() => undefined)\n}\n',
    })).toEqual(['src/main.ts:4 Hono app is passed to a parameter not typed Hono: farol cannot place what the function installs'])
  })

  it('an app passed to a library function is not a dynamic route', () => {
    expect(dynamic({ 'src/main.ts': "import { Hono } from 'hono'\nimport { serve } from '@hono/node-server'\nexport const app = new Hono()\nserve(app)\n" })).toEqual([])
  })

  it('Fastify options in route({ … }) are modules of that route', () => {
    const t = table({
      'src/main.ts': "import { auth } from './auth'\nfastify.route({ method: 'POST', url: '/a', preHandler: auth, handler: async () => 'a' })\n",
      'src/auth.ts': 'export const auth = () => undefined\n',
    })
    expect(t.operations.map((o) => [o.key, o.modules])).toEqual([['POST /a', ['src/auth.ts']]])
  })

  it('a handler held in a variable of the same file reaches what the variable uses', () => {
    const t = table({
      'src/main.ts': "import express from 'express'\nimport { create } from './create'\nconst app = express()\nconst handler = create()\napp.get('/a', handler)\n",
      'src/create.ts': 'export const create = () => () => undefined\n',
    })
    expect(t.operations.map((o) => [o.key, o.modules])).toEqual([['GET /a', ['src/create.ts']]])
  })

  it('an onError in a file without Hono is not a Hono construct', () => {
    expect(dynamic({ 'src/main.ts': "import { consumer } from './consumer'\nconsumer.onError(() => undefined)\n", 'src/consumer.ts': 'export const consumer = { onError: (_f: () => void) => undefined }\n' })).toEqual([])
  })

  it('a guard of an Express route is one of its modules; use() stays unplaced', () => {
    const t = table({
      'src/main.ts': "import express from 'express'\nimport { guard } from './guard'\nimport { logger } from './logger'\nconst app = express()\napp.use(logger)\napp.post('/a', guard, (req, res) => res.send('a'))\napp.get('/b', (req, res) => res.send('b'))\n",
      'src/guard.ts': 'export const guard = () => undefined\n',
      'src/logger.ts': 'export const logger = () => undefined\n',
    })
    expect(t.operations.map((o) => [o.key, o.modules])).toEqual([['GET /b', []], ['POST /a', ['src/guard.ts']]])
  })
})

describe('Hono mounts', () => {
  it('joins prefixes like Hono does', () => {
    expect([mergePath('/api', '/users'), mergePath('/api', '/'), mergePath('/', '/health'), mergePath('/', '/'), mergePath('/api/', '/x'), mergePath('/admin', '/*')]).toEqual(['/api/users', '/api', '/health', '/', '/api/x', '/admin/*'])
  })

  it('gives one entry per mount of a factory, with the full path', () => {
    const files = {
      'src/items.ts': items,
      'src/main.ts': `import { Hono } from 'hono'
import { createItems } from './items'
const app = new Hono()
app.route('/a', createItems())
app.route('/b', createItems()).route('/c', createItems())
app.get('/health', (c) => c.text('ok'))
`,
    }
    expect(keys(files)).toEqual(['GET /a', 'GET /a/:id', 'GET /b', 'GET /b/:id', 'GET /c', 'GET /c/:id', 'GET /health'])
    expect(dynamic(files)).toEqual([])
    expect(table(files).resolverKeys.get('GET /b/:id')).toEqual(new Set(['src/items.ts GET /:id']))
  })

  it('reads a root app received as a parameter (import type), through the callers', () => {
    const files = {
      'src/items.ts': items,
      'src/server.ts': `import { Hono } from 'hono'\nexport function createApp(): Hono {\n  const app = new Hono()\n  return app\n}\n`,
      'src/routes.ts': `import type { Hono as H } from 'hono'
import { createItems } from './items'
export function register(app: H<{ Bindings: {} }>) {
  app.route('/api', createItems())
}
`,
      'src/main.ts': `import { createApp } from './server'\nimport { register } from './routes'\nconst app = createApp()\nregister(app)\n`,
    }
    expect(keys(files)).toEqual(['GET /api', 'GET /api/:id'])
    expect(dynamic(files)).toEqual([])
  })

  it('reads an exported default sub-app and deduplicates the same mount twice', () => {
    const files = {
      'src/books.ts': `import { Hono } from 'hono'\nconst books = new Hono()\nbooks.get('/', (c) => c.json([]))\nexport default books\n`,
      'src/main.ts': `import { Hono } from 'hono'\nimport books from './books'\nconst app = new Hono()\napp.route('/books', books)\napp.route('/books', books)\n`,
    }
    expect(keys(files)).toEqual(['GET /books'])
    expect(table(files).dynamic).toEqual([])
  })

  it('keeps Express and Fastify paths as written', () => {
    expect(keys({ 'src/main.ts': `import express from 'express'\nconst app = express()\napp.get('/users', (req, res) => res.json([]))\n` })).toEqual(['GET /users'])
  })

  it('an unmounted factory with GET / does not merge with another app\'s GET /', () => {
    const files = {
      'src/items.ts': items,
      'src/main.ts': `import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/', (c) => c.text('home'))\n`,
    }
    const t = table(files)
    expect(t.resolverKeys.get('GET /')).toEqual(new Set(['src/items.ts GET /', 'src/main.ts GET /']))
  })

  it.each([
    ['a non-literal prefix', `const PREFIX = '/x'\napp.route(PREFIX, createItems())`, 'src/main.ts:5 Hono route() prefix is not a string literal'],
    ['a factory that returns one of two apps', `function pick(flag: boolean) {\n  const a = new Hono()\n  const b = new Hono()\n  if (flag) return a\n  return b\n}\napp.route('/x', pick(true))`, 'src/main.ts:10 Hono route() target is not an app farol can follow'],
    ['a basePath() chain', `const v1 = app.basePath('/v1')\nv1.get('/x', (c) => c.text(''))`, 'src/main.ts:5 Hono app is not one farol can follow (basePath, alias or property)'],
    ['a mount target that is a parameter', `export function mount(sub: Hono) {\n  app.route('/x', sub)\n}`, 'src/main.ts:5 Hono route() target is a parameter: its apps come from the callers'],
    ['spread route() arguments', `const args = ['/x', createItems()] as const\napp.route(...args)`, 'src/main.ts:5 Hono route() arguments are spread'],
    ['middleware on an app farol cannot follow', `const deps = { app }\ndeps.app.use('*', async (_c, next) => next())`, 'src/main.ts:5 Hono use() is on an app farol cannot follow: its middleware cannot be placed'],
    ['a handler on an app farol cannot follow', `const deps = { app }\ndeps.app.get('/x', (c) => c.text(''))`, 'src/main.ts:5 Hono app is not one farol can follow (basePath, alias or property)'],
  ])('%s is a dynamic route', (_name, code, expected) => {
    const files = { 'src/items.ts': items, 'src/main.ts': `import { Hono } from 'hono'\nimport { createItems } from './items'\nconst app = new Hono()\n${code}\n` }
    expect(dynamic(files)).toEqual([expected])
  })

  it('follows Hono re-exported from a project module', () => {
    const files = {
      'src/lib/hono.ts': "export { Hono } from 'hono'\n",
      'src/items.ts': items.replace("from 'hono'", "from './lib/hono'"),
      'src/main.ts': "import { Hono } from './lib/hono'\nimport { createItems } from './items'\nconst app = new Hono()\napp.route('/a', createItems())\n",
    }
    expect(keys(files)).toEqual(['GET /a', 'GET /a/:id'])
    expect(dynamic(files)).toEqual([])
  })

  it('an app class of another hono package is a dynamic route', () => {
    expect(dynamic({ 'src/main.ts': "import { OpenAPIHono } from '@hono/zod-openapi'\nconst app = new OpenAPIHono()\napp.get('/x', (c) => c.text(''))\n" })).toEqual([`src/main.ts:3 ${UNRESOLVED_APP}`])
  })

  it('a mount of a Hono app on a parent farol cannot follow is a dynamic route, also without a hono import', () => {
    const files = {
      'src/items.ts': items,
      'src/server.ts': "import { Hono } from 'hono'\nexport const app = new Hono()\n",
      'src/main.ts': "import { app } from './server'\nimport { createItems } from './items'\nconst deps = { app }\ndeps.app.route('/', createItems())\n",
    }
    expect(dynamic(files)).toEqual([`src/main.ts:4 ${UNRESOLVED_APP}`])
  })

  it('an event listener in a Hono file is not middleware', () => {
    expect(dynamic({ 'src/main.ts': "import { serve } from '@hono/node-server'\nprocess.on('SIGTERM', () => process.exit(0))\n" })).toEqual([])
  })

  it('a mount path covers an endpoint when one request can reach both (parameters and wildcards match any segment)', () => {
    expect([
      overlaps('/admin/api/x', '/admin/api'),
      overlaps('/admin/apix', '/admin/api'),
      overlaps('/orgs/:orgId/x', '/orgs/:id'),
      overlaps('/admin/*', '/admin/api/models'),
      overlaps('/healthz', '/admin/api'),
      overlaps('/x', '/'),
      overlaps('/admin', '/admin/api'),
    ]).toEqual([true, false, true, true, false, true, false])
  })

  it.each([
    ["routes.route('/x', items)", true],
    ["routes.route('/x', createItems(deps.items, { name: 'x' } as const))", true],
    ["routes.route('/x', createItems(load()))", false],
    ["routes.route('/x', other.use('*', guard))", false],
    ["routes.use('*', guard).route('/x', items)", false],
    ["routes.route('/x', createItems({ [key()]: 1 }))", false],
  ])('mount %s runs no other code: %s', (code, plain) => {
    expect(mountNodes(parseIsolated('src/a.ts', code).sourceFile, 'src/a.ts').map((m) => m.plain)).toEqual([plain])
  })

  it('two mounts with the same text are two mounts', () => {
    const one = "import { Hono } from 'hono'\nconst routes = new Hono()\nroutes.route('/x', items)\n"
    const changes = diffResolvers(resolverEntries('src/a.ts', one, new Map()), resolverEntries('src/a.ts', `${one}routes.route('/x', items)\n`, new Map()))
    expect(changes.addedMounts.map((m) => m.prefix)).toEqual(["'/x'"])
  })

  it('compares the mounts of a file the table marks as Hono, without a hono import', () => {
    const base = "import { app } from './server'\nimport { createItems } from './items'\n"
    const changes = diffResolvers(resolverEntries('src/main.ts', base, new Map(), true, true), resolverEntries('src/main.ts', `${base}app.route('/a', createItems())\n`, new Map(), true, true))
    expect(changes.addedMounts.map((m) => m.prefix)).toEqual(["'/a'"])
    expect(changes.restChanged).toBe(false)
  })

  it('new code that runs when the file loads is a change; a new handler is not', () => {
    const base = "import { Hono } from 'hono'\nexport const ping = new Hono()\nping.get('/ping', (c) => c.text('pong'))\n"
    const diff = (head: string) => diffResolvers(resolverEntries('src/ping.ts', base, new Map()), resolverEntries('src/ping.ts', head, new Map()))
    expect(diff(`${base}ping.use('*', async (c) => c.text('no', 401))\n`).problems).toEqual([expect.stringContaining('runs when the file loads')])
    expect(diff(`${base}ping.get('/pong', (c) => c.text('ping'))\n`).problems).toEqual([])
  })

  it.each([
    ['a parameter held in an array and spread into use()', "import { Hono } from 'hono'\nexport const app = new Hono()\nexport function install(guard: never) {\n  const mws = [guard]\n  app.use('*', ...mws)\n}\n", 'parameter'],
    ['an app spread into a parameter typed Hono', "import { Hono } from 'hono'\nconst api = new Hono()\nfunction register(app: Hono) {\n  app.get('/users', (c) => c.text('u'))\n}\nconst root = new Hono()\nroot.route('/api', api)\nregister(...[api] as const)\nexport { root }\n", 'spread'],
  ])('%s is a dynamic route', (_name, code, word) => {
    expect(dynamic({ 'src/main.ts': code }).join()).toContain(word)
  })

  it('a new enum resolver is not reported as empty load code', () => {
    const types = new Map([['Status', new Set(['__values'])]])
    const diff = diffResolvers(resolverEntries('src/a.ts', 'export const r = { other: 1 }', types), resolverEntries('src/a.ts', 'export const r = { other: 1, Status: build() }', types))
    expect(diff.problems).toEqual([])
  })

  it('reads route(a, b) calls as mounts only in files that import hono', () => {
    const base = "import { client } from './client'\nexport function setup() {\n  client.ping()\n}\n"
    const head = "import { client } from './client'\nexport function setup() {\n  client.ping()\n  client.route('/a', 'b')\n}\n"
    const changes = diffResolvers(resolverEntries('src/setup.ts', base, new Map()), resolverEntries('src/setup.ts', head, new Map()))
    expect(changes.restChanged).toBe(true)
    expect(changes.addedMounts).toEqual([])
  })
})

