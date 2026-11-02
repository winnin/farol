import { describe, expect, it } from 'vitest'
import { buildBackendTable } from '../../src/backend/entrypoints.js'
import { mountNodes } from '../../src/backend/hono.js'
import { overlaps } from '../../src/backend/hono-paths.js'
import { mountImpacts } from '../../src/backend/impact.js'
import { diffResolvers, resolverEntries } from '../../src/backend/resolvers.js'
import { parseIsolated } from '../../src/project/parse.js'
import { memoryProject, ROOT } from '../helpers/memory.js'

/** Existing endpoints a new mount of `sub` at '/' touches (`main.ts` has GET /whoami and GET /items/:id). */
function touchedBy(sub: string): string[] {
  const files: Record<string, string> = {
    'src/sub.ts': `import { Hono } from 'hono'\nexport function createSub() {\n  const routes = new Hono()\n${sub}\n  return routes\n}\n`,
    'src/main.ts': "import { Hono } from 'hono'\nimport { createSub } from './sub'\nconst app = new Hono()\napp.get('/whoami', (c) => c.text('me'))\napp.get('/items/:id', (c) => c.text(''))\napp.route('/', createSub())\n",
  }
  const table = buildBackendTable({ project: memoryProject(files, 'src/main.ts'), repoRoot: ROOT, files: Object.keys(files), read: (f) => files[f], isOrigin: () => true, graphql: false, rest: true, context: {} })
  const mount = mountNodes(parseIsolated('src/main.ts', files['src/main.ts'] ?? '').sourceFile, 'src/main.ts')[0]
  if (!mount) throw new Error('no mount in main.ts')
  const baseRest = table.restKeysWithout(new Set([mount.id]), new Set())
  const impact = mountImpacts(table, [{ id: mount.id, prefix: mount.prefix, plain: mount.plain, file: 'src/main.ts' }], baseRest, new Map()).get('src/main.ts')
  return [...(impact?.affected.keys() ?? [])]
}

describe('what a new Hono mount touches', () => {
  it.each([
    ['only new routes', "  routes.get('/audit', (c) => c.json([]))", []],
    ['use()', "  routes.use('*', async (_c, next) => next())", ['GET /items/:id', 'GET /whoami']],
    ['all() that calls next', "  routes.all('*', async (_c, next) => next())", ['GET /items/:id', 'GET /whoami']],
    ['on()', "  routes.on('GET', '/x', (c) => c.text(''))", ['GET /items/:id', 'GET /whoami']],
    ['a parameter route (it only shadows, like a new handler)', "  routes.get('/:slug', (c) => c.text(''))", []],
    ['a handler that calls next', "  routes.get('/audit', async (_c, next) => next())", ['GET /items/:id', 'GET /whoami']],
    ['a route with the key of an existing endpoint', "  routes.get('/whoami', (c) => c.text('other'))", ['GET /whoami']],
    ['an ALL route on the path of an existing endpoint', "  routes.all('/whoami', (c) => c.text('other'))", ['GET /whoami']],
    ['a named handler that calls next on a wildcard', "  const pass = async (_c: unknown, next: () => Promise<void>) => next()\n  routes.all('*', pass)", ['GET /items/:id', 'GET /whoami']],
    ['a named handler without next on a wildcard', "  const page = (c: { text: (s: string) => unknown }) => c.text('')\n  routes.get('*', page)", []],
  ])('a sub-app with %s', (_name, sub, expected) => {
    expect(touchedBy(sub)).toEqual(expected)
  })

  it('a regular-expression parameter can span segments', () => {
    expect([overlaps('/files/:path{.+}', '/files/a/b'), overlaps('/x/:id{[0-9]+}', '/y')]).toEqual([true, false])
  })
})

describe('new code in an existing REST file', () => {
  const base = "import { Hono } from 'hono'\nexport const ping = new Hono()\nping.get('/ping', (c) => c.text('pong'))\n"
  const problems = (head: string): string[] => diffResolvers(resolverEntries('src/ping.ts', base, new Map()), resolverEntries('src/ping.ts', head, new Map())).problems

  it.each([
    ['a handler', "ping.get('/pong', (c) => c.text('ping'))"],
    ['a function', 'export function helper(): number {\n  return 1\n}'],
    ['a static constant', "const LIMITS = { max: 10, names: ['a'] } as const"],
    ['an arrow function constant', 'export const twice = (n: number) => {\n  return n * 2\n}'],
    ['a new Hono app', 'export const pong = new Hono()'],
    ['a type', 'type Id = string'],
    ['a named import', "import { other } from './other'"],
    ['an export to module.exports', 'module.exports.helper = () => 1'],
    ['a class whose instance fields call code', 'class Store {\n  items = load()\n}'],
  ])('%s is additive', (_name, code) => {
    expect(problems(`${base}${code}\n`)).toEqual([])
  })

  it.each([
    ['a top-level call', "ping.use('*', async (c) => c.text('no', 401))"],
    ['a constant built by a call', 'const db = connect()'],
    ['an object built with new', 'const pool = new Pool()'],
    ['a top-level await', 'await warmUp()'],
    ['a side-effect import', "import './instrument'"],
    ['a handler on a chain that runs middleware', "ping.use('*', guard).get('/pong', (c) => c.text('ping'))"],
    ['a handler with a call in its arguments', "ping.get('/pong', rateLimit({ max: 1 }), (c) => c.text('ping'))"],
    ['a default value built by a call', 'const { a = boot() } = config'],
    ['a class built from a call', 'class Store extends mixin() {}'],
    ['an enum member built by a call', 'enum Level {\n  A = compute(),\n}'],
    ['an assignment to a global', 'globalThis.ready = true'],
    ['a class with static code', 'const Cache = class {\n  static shared = init()\n}'],
    ['a new app of another Hono', "import { Hono as Other } from './my-hono'\nexport const pong = new Other()"],
    ['a handler that calls next', "ping.all('*', async (_c, next) => next())"],
    ['a named handler on a wildcard', "ping.get('*', fallback)"],
  ])('%s runs when the file loads', (_name, code) => {
    expect(problems(`${base}${code}\n`)).toEqual([expect.stringMatching(/when the file loads|when it is registered|as middleware/)])
  })
})
