import { afterAll, describe, expect, it } from 'vitest'
import type { Output } from '../../src/output/schema.js'
import { analyzeRepo } from '../helpers/analyze.js'
import { createScenarioRepo, type TestRepo } from '../helpers/repo.js'

const cleanups: (() => void)[] = []
afterAll(() => {
  for (const c of cleanups) c()
})

const SERVER = 'src/http/server.ts'
const INDEX = 'src/http/routes/index.ts'
const ADMIN = 'src/http/routes/admin.routes.ts'
const PROMPTS = 'src/http/routes/admin/prompts.routes.ts'
const PUBLIC = 'src/http/routes/public.routes.ts'
const HELPER = 'src/http/errors/admin-errors.ts'
const AUTH = 'src/http/middleware/admin-auth.ts'

const PROMPT_KEYS = ['GET /admin/api/prompts', 'GET /admin/api/prompts/:key', 'POST /admin/api/prompts']
// `GET /admin/*` can call next, and an unknown `/admin/api/x` reaches it after the admin middleware.
const ADMIN_KEYS = ['GET /admin/*', 'GET /admin/api/prompts', 'GET /admin/api/prompts/:key', 'GET /admin/api/whoami', 'POST /admin/api/prompts']
const HELPER_KEYS = ['GET /admin/*', 'GET /admin/api/prompts', 'GET /admin/api/prompts/:key', 'GET /admin/api/whoami', 'GET /public/items', 'POST /admin/api/prompts']
// The Fastify endpoints of the base API (`GET /health`, `POST /webhooks/stripe`) are never under a Hono app.
const ALL_HONO = ['ALL /secure/*', 'GET /admin/*', 'GET /admin/api/prompts', 'GET /admin/api/prompts/:key', 'GET /admin/api/whoami', 'GET /files', 'GET /files/:name', 'GET /healthz', 'GET /public/items', 'GET /secure/report', 'POST /admin/api/prompts']

type Change = (repo: TestRepo) => void

function edit(repo: TestRepo, file: string, from: string, to: string): void {
  const code = repo.read(file)
  if (!code.includes(from)) throw new Error(`${file} does not contain: ${from}`)
  repo.write(file, code.replace(from, to))
}

/** A PR that applies `change` on the base; `setup` first changes the base itself. */
async function analyze(change: Change, setup?: Change): Promise<Output> {
  const { repo } = createScenarioRepo('b12-hono-middleware')
  cleanups.push(() => { repo.cleanup(); })
  repo.git('checkout', '-q', 'main')
  setup?.(repo)
  repo.commit('setup')
  repo.git('checkout', '-q', '-B', 'feature')
  change(repo)
  repo.commit('variant')
  return (await analyzeRepo(repo)).output
}

const affected = (o: Output): string[] => o.routes.affected.map((r) => r.key)

async function expectAffected(keys: string[], change: Change, setup?: Change): Promise<void> {
  const o = await analyze(change, setup)
  expect(o.classification).toBe('touches-existing')
  expect(affected(o)).toEqual(keys)
}

describe('Hono middleware and error handlers', () => {
  describe('a change to code installed on an app lists the endpoints that run it', () => {
    it.each([
      ['use(\'*\') on a mounted app: under the mount, nested apps too', AUTH, 'denied', 'refused', ADMIN_KEYS],
      ['use(\'*\') on the root app: every Hono endpoint', 'src/http/middleware/request-logger.ts', "'request'", "'req'", ALL_HONO],
      ['use(\'/x/*\'): at and under /x only', 'src/http/middleware/serve-files.ts', "'on'", "'off'", ['GET /files', 'GET /files/:name']],
      ['onError on the root app: every Hono endpoint', 'src/http/middleware/error-handler.ts', "'root'", "'top'", ALL_HONO],
      ['a named handler that can call next: under its path', 'src/http/middleware/secure-guard.ts', 'locked', 'closed', ['ALL /secure/*', 'GET /secure/report']],
      ['an inline handler that can call next: under its path', 'src/http/lib/spa-page.ts', "'spa'", "'page'", ADMIN_KEYS],
      ['a guard before the handler: only the route that passes it', 'src/http/middleware/body-limit.ts', 'too large', 'over the limit', ['POST /admin/api/prompts']],
    ])('%s', async (_name, file, from, to, keys) => {
      const o = await analyze((repo) => { edit(repo, file, from, to) })
      expect(o.classification).toBe('touches-existing')
      expect(affected(o)).toEqual(keys)
      expect(o.reasons.filter((r) => r.file === file).map((r) => r.code)).toEqual(['existing-file-modified'])
    })

    it('on(method, path, handler): under its path', async () => {
      const MW = 'src/http/middleware/on-guard.ts'
      await expectAffected(['ALL /secure/*', 'GET /secure/report'], (repo) => { edit(repo, MW, "'on'", "'off'") }, (repo) => {
        repo.write(MW, "import type { MiddlewareHandler } from 'hono'\n\nexport const onGuard: MiddlewareHandler = async (c, next) => {\n  c.header('x-on', 'on')\n  await next()\n}\n")
        edit(repo, INDEX, "import { secureGuard }", "import { onGuard } from '../middleware/on-guard'\nimport { secureGuard }")
        edit(repo, INDEX, "  app.all('/secure/*'", "  app.on('POST', '/secure/*', onGuard)\n  app.all('/secure/*'")
      })
    })

    it('a helper that receives the app places its onError on that app; importers of the helper are still reached', async () => {
      await expectAffected(HELPER_KEYS, (repo) => { edit(repo, HELPER, "'admin'", "'operator'") })
    })

    it('a module the helper uses is reached through the helper', async () => {
      await expectAffected(HELPER_KEYS, (repo) => { edit(repo, 'src/http/errors/format-error.ts', 'failed', 'broken') })
    })
  })

  describe('middleware held in a variable of the same file', () => {
    const replaceUse = (lines: string): Change => (repo) => { edit(repo, ADMIN, "routes.use('*', createAdminAuth())", lines) }
    it.each([
      ['another variable', replaceUse("const auth = createAdminAuth()\n  const mw = auth\n  routes.use('*', mw)")],
      ['an array', replaceUse("const mw = [createAdminAuth()]\n  routes.use('*', ...mw)")],
      ['a destructured value', (repo: TestRepo) => {
        repo.write('src/http/middleware/build-auth.ts', "import { createAdminAuth } from './admin-auth'\n\nexport function buildAuth() {\n  return { mw: createAdminAuth() }\n}\n")
        edit(repo, ADMIN, "import { createPromptRoutes }", "import { buildAuth } from '../middleware/build-auth'\nimport { createPromptRoutes }")
        replaceUse("const { mw } = buildAuth()\n  routes.use('*', mw)")(repo)
      }],
    ])('%s', async (_name, setup) => {
      await expectAffected(ADMIN_KEYS, (repo) => { edit(repo, AUTH, 'denied', 'refused') }, setup)
    })
  })

  describe('an edit in a file that holds an app lists every endpoint under that app', () => {
    it.each<[string, Change, Change?]>([
      ['a changed use() line', (repo) => { edit(repo, ADMIN, 'createAdminAuth())', 'createAdminAuth({ strict: true }))') }],
      ['a removed use() line', (repo) => { edit(repo, ADMIN, "  routes.use('*', createAdminAuth())\n", '') }],
      ['a removed call of a helper that receives the app', (repo) => { edit(repo, ADMIN, '  installAdminErrorHandler(routes)\n', '') }],
      ['a changed import path', (repo) => {
        repo.write('src/http/middleware/admin-auth-v2.ts', repo.read(AUTH))
        edit(repo, ADMIN, "'../middleware/admin-auth'", "'../middleware/admin-auth-v2'")
      }],
      ['a guard defined in the file', (repo) => { edit(repo, ADMIN, "'guarded'", "'checked'") }, (repo) => {
        edit(repo, ADMIN, 'export function createAdminRoutes', "const guard: MiddlewareHandler = async (c, next) => {\n  c.header('x-guard', 'guarded')\n  await next()\n}\n\nexport function createAdminRoutes")
        edit(repo, ADMIN, "import { Hono } from 'hono'", "import { Hono, type MiddlewareHandler } from 'hono'")
        edit(repo, ADMIN, "routes.get('/whoami', (c)", "routes.get('/whoami', guard, (c)")
      }],
      ['a chained use() whose argument changes', (repo) => { edit(repo, ADMIN, 'createAdminAuth())', 'createAdminAuth({ strict: true }))') }, (repo) => {
        edit(repo, ADMIN, "routes.use('*', createAdminAuth())\n  routes.get('/whoami'", "routes.use(createAdminAuth()).get('/whoami'")
      }],
    ])('%s', async (_name, change, setup) => {
      await expectAffected(ADMIN_KEYS, change, setup)
    })

    it('a new use() in a factory is not additive and lists the endpoints under its app', async () => {
      const o = await analyze((repo) => {
        edit(repo, PROMPTS, "  routes.get('/', (c)", "  routes.use('*', async (_c, next) => {\n    await next()\n  })\n  routes.get('/', (c)")
      })
      expect(o.classification).toBe('touches-existing')
      expect(affected(o)).toEqual(['GET /admin/*', ...PROMPT_KEYS])
    })

    it('a guard exported by a handler file: the routes of other files that use it are listed', async () => {
      await expectAffected(['GET /admin/*', ...PROMPT_KEYS, 'POST /public/items'], (repo) => { edit(repo, PROMPTS, "'shared'", "'common'") }, (repo) => {
        edit(repo, PROMPTS, 'export function createPromptRoutes', "export const promptGuard: MiddlewareHandler = async (c, next) => {\n  c.header('x-guard', 'shared')\n  await next()\n}\n\nexport function createPromptRoutes")
        edit(repo, PROMPTS, "import { Hono } from 'hono'", "import { Hono, type MiddlewareHandler } from 'hono'")
        edit(repo, PUBLIC, "import { wrap }", "import { promptGuard } from './admin/prompts.routes'\nimport { wrap }")
        edit(repo, PUBLIC, "  return routes", "  routes.post('/items', promptGuard, (c) => c.text('ok'))\n  return routes")
      })
    })
  })

  describe('a file without handlers that installs middleware', () => {
    it.each<[string, Change]>([
      ['a narrower use() path lists the endpoints that lost the middleware', (repo) => { edit(repo, SERVER, "app.use('*'", "app.use('/api/*'") }],
      ['a removed use() lists endpoints, not zero', (repo) => { edit(repo, SERVER, "  app.use('*', requestLogger())\n", '') }],
      ['a removed onError lists endpoints, not zero', (repo) => { edit(repo, SERVER, '  app.onError(createErrorHandler())\n', '') }],
    ])('%s', async (_name, change) => {
      await expectAffected(ALL_HONO, change)
    })

    it('removing the only onError of a helper whose app parameter stays', async () => {
      await expectAffected(HELPER_KEYS, (repo) => { edit(repo, HELPER, "  app.onError((err, c) => c.json({ error: formatError(err), source: 'admin' }, 500))\n", '') })
    })

    it('removing the app parameter and the hono import of a helper leaves no app to place it on: every Hono endpoint', async () => {
      await expectAffected(ALL_HONO, (repo) => {
        edit(repo, HELPER, "import type { Hono } from 'hono'\n", '')
        edit(repo, HELPER, "export function installAdminErrorHandler(app: Hono): void {\n  app.onError((err, c) => c.json({ error: formatError(err), source: 'admin' }, 500))\n}", "export function installAdminErrorHandler(): string {\n  return formatError(new Error('none'))\n}")
      })
    })

    const MAIN_MW = 'src/http/middleware/main-only.ts'
    const inMain: Change = (repo) => {
      repo.write(MAIN_MW, "import type { MiddlewareHandler } from 'hono'\n\nexport const mainOnly: MiddlewareHandler = async (c, next) => {\n  c.header('x-main', 'on')\n  await next()\n}\n")
      edit(repo, 'src/main.ts', "import { registerRoutes } from './http/routes'", "import { registerRoutes } from './http/routes'\nimport { mainOnly } from './http/middleware/main-only'")
      edit(repo, 'src/main.ts', 'registerRoutes(app)', "app.use('*', mainOnly)\nregisterRoutes(app)")
    }

    it('a use() on an app from a factory: its module lists every endpoint of the app', async () => {
      await expectAffected(ALL_HONO, (repo) => { edit(repo, MAIN_MW, "'on'", "'off'") }, inMain)
    })

    it('removing a use() on an app from a factory lists endpoints, not zero', async () => {
      await expectAffected(ALL_HONO, (repo) => { edit(repo, 'src/main.ts', "app.use('*', mainOnly)\n", '') }, inMain)
    })
  })

  describe('a change the line-by-line comparison would call additive', () => {
    const MAIN = 'src/main.ts'
    const withUse: Change = (repo) => {
      edit(repo, MAIN, "import { registerRoutes } from './http/routes'", "import { registerRoutes } from './http/routes'\nimport { requestLogger } from './http/middleware/request-logger'")
      edit(repo, MAIN, 'registerRoutes(app)', "app.use('*', requestLogger())\nregisterRoutes(app)")
    }

    it('moving a use() after the routes in a file without handlers is a change', async () => {
      await expectAffected(ALL_HONO, (repo) => { edit(repo, MAIN, "app.use('*', requestLogger())\nregisterRoutes(app)", "registerRoutes(app)\napp.use('*', requestLogger())") }, withUse)
    })

    it('moving a use() after the routes in a file with handlers is a change', async () => {
      await expectAffected(['GET /main', ...ALL_HONO].sort(), (repo) => { edit(repo, MAIN, "app.use('*', requestLogger())\nregisterRoutes(app)", "registerRoutes(app)\napp.use('*', requestLogger())") }, (repo) => {
        withUse(repo)
        edit(repo, MAIN, "app.use('*'", "app.get('/main', (c) => c.text('main'))\napp.use('*'")
      })
    })

    it('a new property of an options object that middleware receives is a change', async () => {
      await expectAffected(ALL_HONO, (repo) => { edit(repo, SERVER, "{ level: 'a' }", "{ level: 'a', extra: true }") }, (repo) => {
        edit(repo, SERVER, 'export function createHttpApp', "const opts = { level: 'a' }\n\nexport function createHttpApp")
        edit(repo, SERVER, 'requestLogger()', 'requestLogger(opts)')
      })
    })

    it('a new property of an options object in a file with handlers is a change', async () => {
      await expectAffected(['GET /main', ...ALL_HONO].sort(), (repo) => { edit(repo, MAIN, "{ level: 'a' }", "{ level: 'a', extra: true }") }, (repo) => {
        edit(repo, MAIN, "import { registerRoutes } from './http/routes'", "import { registerRoutes } from './http/routes'\nimport { requestLogger } from './http/middleware/request-logger'")
        edit(repo, MAIN, 'registerRoutes(app)', "const opts = { level: 'a' }\napp.use('*', requestLogger(opts))\napp.get('/main', (c) => c.text('main'))\nregisterRoutes(app)")
      })
    })

    it('an edit after // inside a template string is not a comment', async () => {
      await expectAffected(ALL_HONO, (repo) => { edit(repo, SERVER, '//old', '//new') }, (repo) => {
        edit(repo, SERVER, 'export function createHttpApp', "const host = 'a'\nconst url = `${host}//old`\n\nexport function createHttpApp")
        edit(repo, SERVER, 'requestLogger()', 'requestLogger(url)')
      })
    })

    it('a comment in a file that holds an app changes nothing', async () => {
      const o = await analyze((repo) => { edit(repo, SERVER, 'export function createHttpApp', '// builds the app\nexport function createHttpApp') })
      expect(o.classification).toBe('isolated')
      expect(affected(o)).toEqual([])
    })
  })

  describe('a file whose app comes from a factory', () => {
    const MAIN = 'src/main.ts'
    it('an edit of a handler that can call next lists the endpoints under the app', async () => {
      await expectAffected(['ALL /api/*', 'GET /api/x', ...ALL_HONO].sort(), (repo) => { edit(repo, MAIN, "'before'", "'after'") }, (repo) => {
        edit(repo, MAIN, 'registerRoutes(app)', "app.all('/api/*', async (c, next) => {\n  c.header('x-main', 'before')\n  await next()\n})\napp.get('/api/x', (c) => c.text('x'))\nregisterRoutes(app)")
      })
    })

    it('removing its only use() while the file creates another app still lists the endpoints of the first', async () => {
      await expectAffected(['GET /other', ...ALL_HONO].sort(), (repo) => { edit(repo, MAIN, "app.use('*', requestLogger())\n", '') }, (repo) => {
        edit(repo, MAIN, "import { registerRoutes } from './http/routes'", "import { Hono } from 'hono'\nimport { registerRoutes } from './http/routes'\nimport { requestLogger } from './http/middleware/request-logger'")
        edit(repo, MAIN, 'registerRoutes(app)', "app.use('*', requestLogger())\nregisterRoutes(app)\nexport const other = new Hono()\nother.get('/', (c) => c.text('other'))\napp.route('/other', other)")
      })
    })
  })

  it('an edit of a guard that can call next before a named handler lists the endpoints under its app', async () => {
    await expectAffected(['GET /mid', ...ALL_HONO].sort(), (repo) => { edit(repo, INDEX, "'before'", "'after'") }, (repo) => {
      edit(repo, INDEX, "  app.get('/files', (c)", "  app.get('/mid', async (c, next) => {\n    c.header('x-mid', 'before')\n    await next()\n  }, spaPage)\n  app.get('/files', (c)")
    })
  })

  it('a source file with no app and no handler keeps its plain reach', async () => {
    const o = await analyze((repo) => { edit(repo, 'src/http/lib/wrap.ts', '${text}', '${text}!') })
    expect(affected(o)).toEqual(['GET /public/items'])
  })
})
