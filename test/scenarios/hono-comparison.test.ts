import { afterAll, describe, expect, it } from 'vitest'
import type { Output } from '../../src/output/schema.js'
import { analyzeVariant, edit, type Change } from '../helpers/variant.js'

const cleanups: (() => void)[] = []
afterAll(() => {
  for (const c of cleanups) c()
})

const SERVER = 'src/http/server.ts'
const INDEX = 'src/http/routes/index.ts'
const ADMIN = 'src/http/routes/admin.routes.ts'
const PUBLIC = 'src/http/routes/public.routes.ts'
const ADMIN_KEYS = ['GET /admin/*', 'GET /admin/api/prompts', 'GET /admin/api/prompts/:key', 'GET /admin/api/whoami', 'POST /admin/api/prompts']
const ALL_HONO = ['ALL /secure/*', 'GET /admin/*', 'GET /admin/api/prompts', 'GET /admin/api/prompts/:key', 'GET /admin/api/whoami', 'GET /files', 'GET /files/:name', 'GET /healthz', 'GET /public/items', 'GET /secure/report', 'POST /admin/api/prompts']

const analyze = (change: Change, setup?: Change): Promise<Output> => analyzeVariant('b12-hono-middleware', cleanups, change, setup)
const affected = (o: Output): string[] => o.routes.affected.map((r) => r.key)

async function expectAffected(keys: string[], change: Change, setup?: Change): Promise<void> {
  const o = await analyze(change, setup)
  expect(o.classification).toBe('touches-existing')
  expect(affected(o)).toEqual(keys)
}

async function expectIsolated(change: Change, setup?: Change): Promise<void> {
  const o = await analyze(change, setup)
  expect(o.classification).toBe('isolated')
  expect(affected(o)).toEqual([])
}

describe('the order of registrations', () => {
  it('moving use() below the handlers and mounts of its app is a change', async () => {
    await expectAffected(ADMIN_KEYS, (repo) => {
      edit(repo, ADMIN, "  routes.use('*', createAdminAuth())\n", '')
      edit(repo, ADMIN, '  return routes', "  routes.use('*', createAdminAuth())\n  return routes")
    })
  })

  it('swapping two handlers is a change: the first match serves the request', async () => {
    await expectAffected(ALL_HONO, (repo) => {
      edit(repo, INDEX, "  app.get('/files', (c) => c.text('list'))\n  app.get('/files/:name', (c) => c.text('file'))\n", "  app.get('/files/:name', (c) => c.text('file'))\n  app.get('/files', (c) => c.text('list'))\n")
    })
  })

  it('swapping two mounts is a change', async () => {
    await expectAffected(ALL_HONO, (repo) => {
      edit(repo, INDEX, "  app.route('/admin/api', createAdminRoutes())\n  app.route('/public', createPublicRoutes())\n", "  app.route('/public', createPublicRoutes())\n  app.route('/admin/api', createAdminRoutes())\n")
    })
  })

  it('a new handler between others, with the same inner call as another handler, stays additive', async () => {
    await expectIsolated((repo) => { edit(repo, INDEX, "  app.get('/files/:name'", "  app.get('/new', (c) => c.text('list'))\n  app.get('/files/:name'") })
  })
})

describe('code is compared by its tokens', () => {
  it.each<[string, string, string, string, string, string[]]>([
    ['spaces in a string of module code in a file with an app', SERVER, 'requestLogger()', "requestLogger('a  b')", "'a  b'", ALL_HONO],
    ['spaces in a string of a plain handler', INDEX, "c.text('list')", "c.text('li  st')", "'li  st'", ['GET /files']],
    ['spaces in a string of a handler that can call next', INDEX, 'return spaPage(c)', "c.header('x', 'a  b')\n    return spaPage(c)", "'a  b'", ALL_HONO],
  ])('%s is a change', async (_name, file, from, setupTo, literal, keys) => {
    await expectAffected(keys, (repo) => { edit(repo, file, literal, literal.replace('  ', ' ')) }, (repo) => { edit(repo, file, from, setupTo) })
  })

  it.each([
    ['spaces in a string', "const sep = 'a b'", "const sep = 'a  b'"],
    ['commas and a brace in a string', "const sep = '{a,}'", "const sep = '{a}'"],
    ['a line break after return', 'const sep = (() => {\n  return\n  1\n})()', 'const sep = (() => {\n  return 1\n})()'],
  ])('%s of module code in a handler file is a change', async (_name, before, after) => {
    const o = await analyze((repo) => { edit(repo, PUBLIC, before, after) }, (repo) => { edit(repo, PUBLIC, 'export function createPublicRoutes', `${before}\nexport { sep }\n\nexport function createPublicRoutes`) })
    expect(o.classification).toBe('touches-existing')
    expect(affected(o)).toEqual(['GET /public/items'])
  })

  it.each<[string, string, string, string, Change?]>([
    ['formatting of a call', SERVER, "app.use('*', requestLogger())", "app.use( '*',requestLogger() )"],
    ['a semicolon', SERVER, 'const app = new Hono()', 'const app = new Hono();'],
    ['a trailing comma in an object', PUBLIC, "{ level: 'a' }", "{ level: 'a', }", (repo) => { edit(repo, PUBLIC, 'export function createPublicRoutes', "export const opts = { level: 'a' }\n\nexport function createPublicRoutes") }],
    ['a comment in a plain handler', INDEX, '/* a */', '/* b */', (repo) => { edit(repo, INDEX, "(c) => c.text('list')", "(c) => /* a */ c.text('list')") }],
    ['a comment in a handler that can call next', INDEX, '// a', '// b', (repo) => { edit(repo, INDEX, 'await next()', 'await next() // a') }],
    ['a doc comment at the end of a file', SERVER, '/** a */', '/** b */', (repo) => { repo.write(SERVER, `${repo.read(SERVER)}\n/** a */\n`) }],
  ])('%s changes nothing', async (_name, file, from, to, setup) => {
    await expectIsolated((repo) => { edit(repo, file, from, to) }, setup)
  })
})

describe('handlers with the same path as written', () => {
  const twoApps: Change = (repo) => {
    edit(repo, PUBLIC, 'export function createPublicRoutes', "export const other = new Hono()\nother.get('/items', (c) => c.text('first'))\n\nexport function createPublicRoutes")
  }

  it('an edit of the first one is a change, and lists both', async () => {
    await expectAffected(['GET /items', 'GET /public/items'], (repo) => { edit(repo, PUBLIC, "'first'", "'changed'") }, twoApps)
  })

  it('removing a guard that shares its key with the handler after it is a change', async () => {
    const guard = "routes.get('/items', async (c, next) => {\n    if (!c.req.header('t')) return c.text('no', 401)\n    await next()\n  })\n  "
    const o = await analyze((repo) => { edit(repo, PUBLIC, guard, '') }, (repo) => { edit(repo, PUBLIC, "routes.get('/items'", `${guard}routes.get('/items'`) })
    expect(o.classification).toBe('touches-existing')
    expect(affected(o)).toEqual(['GET /public/items'])
  })
})

describe('what makes a file hold an app', () => {
  it('a handler on an imported app: a new property of its options is a change', async () => {
    const o = await analyze((repo) => { edit(repo, 'src/http/extra.ts', "{ level: 'a' }", "{ level: 'a', extra: true }") }, (repo) => {
      repo.write('src/http/core.ts', "import { Hono } from 'hono'\nexport const core = new Hono()\n")
      repo.write('src/http/extra.ts', "import { core } from './core'\nconst opts = { level: 'a' }\ncore.get('/x', (c) => c.json(opts))\n")
    })
    expect(o.classification).toBe('touches-existing')
    expect(affected(o)).toContain('GET /x')
  })

  it('removing the only mount of a file lists endpoints', async () => {
    const o = await analyze((repo) => { edit(repo, 'src/http/wire.ts', "root.route('/x', sub)\n", '') }, (repo) => {
      repo.write('src/http/root.ts', "import { Hono } from 'hono'\nexport const root = new Hono()\nroot.get('/r', (c) => c.text('r'))\n")
      repo.write('src/http/sub.ts', "import { Hono } from 'hono'\nexport const sub = new Hono()\nsub.get('/s', (c) => c.text('s'))\n")
      repo.write('src/http/wire.ts', "import { root } from './root'\nimport { sub } from './sub'\nroot.route('/x', sub)\nexport const wired = true\n")
    })
    expect(o.classification).toBe('touches-existing')
    expect(affected(o).length).toBeGreaterThan(0)
  })
})

describe('a named handler that takes next on a path with a parameter', () => {
  it('an edit of its module lists the endpoints under its path', async () => {
    const GUARD = 'src/http/middleware/param-guard.ts'
    await expectAffected(['GET /p/:id', 'GET /p/health'], (repo) => { edit(repo, GUARD, "'before'", "'after'") }, (repo) => {
      repo.write(GUARD, "export async function paramGuard(c: { header: (a: string, b: string) => void }, next: () => Promise<void>) {\n  c.header('x', 'before')\n  await next()\n}\n")
      edit(repo, INDEX, "import { serveFiles }", "import { paramGuard } from '../middleware/param-guard'\nimport { serveFiles }")
      edit(repo, INDEX, "  app.get('/files', (c)", "  app.get('/p/:id', paramGuard)\n  app.get('/p/health', (c) => c.text('h'))\n  app.get('/files', (c)")
    })
  })
})

describe('new code in a file with handlers', () => {
  it('a new bare require() runs that module, like a side-effect import', async () => {
    const o = await analyze((repo) => { edit(repo, PUBLIC, 'export function createPublicRoutes', "require('./install')\n\nexport function createPublicRoutes") }, (repo) => { repo.write('src/http/routes/install.ts', 'export const ready = true\n') })
    expect(o.classification).toBe('touches-existing')
  })

  it('a new require() held in a variable stays additive', async () => {
    await expectIsolated((repo) => { edit(repo, PUBLIC, 'export function createPublicRoutes', "export const lib = require('./install')\n\nexport function createPublicRoutes") }, (repo) => { repo.write('src/http/routes/install.ts', 'export const ready = true\n') })
  })

  it.each([
    ['a rest parameter', "routes.get('/*', (...a) => a[1]())"],
    ['a pattern that takes the rest of the path', "routes.get('/:p{.+}', guard)"],
  ])('a new handler with %s can call next', async (_name, line) => {
    const o = await analyze((repo) => { edit(repo, PUBLIC, '  return routes', `  ${line}\n  return routes`) }, (repo) => { edit(repo, PUBLIC, 'export function createPublicRoutes', 'const guard = async (c, next) => next()\n\nexport function createPublicRoutes') })
    expect(o.classification).toBe('touches-existing')
    expect(affected(o)).toContain('GET /public/items')
  })
})

describe('a schema file with module code', () => {
  const LIMITS = 'src/schema/limits.ts'
  const withLimit: Change = (repo) => {
    repo.write(LIMITS, "import gql from 'graphql-tag'\n\nexport const typeDefs = gql`\n  type Limits {\n    max: Int\n  }\n`\n\nexport const LIMIT = 10\n")
  }

  it('an edit of its module code is a change', async () => {
    const o = await analyze((repo) => { edit(repo, LIMITS, 'LIMIT = 10', 'LIMIT = 20') }, withLimit)
    expect(o.classification).toBe('touches-existing')
    expect(o.reasons.map((r) => r.code)).toContain('schema-not-additive')
  })

  it('a new field in its gql template stays additive', async () => {
    const o = await analyze((repo) => { edit(repo, LIMITS, 'max: Int', 'max: Int\n    min: Int') }, withLimit)
    expect(o.classification).toBe('isolated')
    expect(o.reasons.map((r) => r.code)).toContain('schema-additive')
  })
})
