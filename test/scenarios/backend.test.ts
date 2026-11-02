import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Output } from '../../src/output/schema.js'
import { analyzeRepo, analyzeScenario, normalizeOutput } from '../helpers/analyze.js'
import { runCli } from '../helpers/cli.js'
import { createScenarioRepo, FIXTURES_DIR } from '../helpers/repo.js'

const cleanups: (() => void)[] = []
afterAll(() => {
  for (const c of cleanups) c()
})

const BRAND_OPS = ['Mutation.renameBrand', 'Query.brand', 'Query.brands']

/** Expected class and affected operations per backend scenario; the full output is a golden file. */
const SCENARIOS: Record<string, { classification: Output['classification']; affected: string[]; check?: (o: Output) => void }> = {
  'b1-new-query': {
    classification: 'isolated',
    affected: [],
    check: (o) => {
      expect(o.routes.added.map((r) => r.key)).toEqual(['Query.topBrands'])
      expect(o.files.map((f) => [f.path, f.role, f.additive])).toEqual([
        ['src/resolvers/brand.ts', 'resolvers', true],
        ['src/schema/types.graphql', 'schema', true],
        ['src/services/top.ts', 'source', undefined],
      ])
    },
  },
  // A service used only by Query.me: the brand operations are untouched.
  'b2-service-changed': { classification: 'touches-existing', affected: ['Query.me'] },
  // Brand.name changed type: every operation that can return a Brand.
  'b3-schema-changed': { classification: 'touches-existing', affected: BRAND_OPS },
  // Only the Brand.posts resolver changed: operations returning Brand run it; Query.me does not.
  'b4-resolver-changed': { classification: 'touches-existing', affected: BRAND_OPS },
  // loaders.Post… is injected through the context: mapped by backend.context to src/loaders/post.ts.
  'b5-loader-changed': { classification: 'touches-existing', affected: BRAND_OPS },
  // lib/db.js is reached through the Core global (global.Core = …) used by services/legacy.js. Across modules the unit
  // is the module: renameBrand uses services/brands.ts, which loads legacy.js, so it is listed too (conservative).
  'b6-global-changed': { classification: 'touches-existing', affected: ['Mutation.renameBrand', 'Query.brands'] },
  'b7-rest': { classification: 'touches-existing', affected: ['POST /webhooks/stripe'] },
  // A value import of git-ignored generated code (Prisma client) under "generated": reach as usual, not unknown.
  'b10-generated-code': {
    classification: 'touches-existing',
    affected: ['POST /webhooks/stripe'],
    check: (o) => {
      expect(o.reasons.map((r) => r.code)).not.toContain('unresolved-import')
    },
  },
  // Contracts (graphql-js rules): a required argument on Query.brand, Post.title removed (every operation returning a
  // Brand reaches Post), an optional argument on Query.brands (dangerous for graphql-js).
  'b9-schema-breaking': {
    classification: 'touches-existing',
    affected: BRAND_OPS,
    check: (o) => {
      expect(o.contracts?.entries.map((e) => [e.key, e.level, e.changes.map((x) => x.detail)])).toEqual([
        ['Mutation.renameBrand', 'breaking', ['Post.title was removed.']],
        ['Query.brand', 'breaking', ['Post.title was removed.', 'A required arg locale on Query.brand was added.']],
        ['Query.brands', 'breaking', ['Post.title was removed.', 'An optional arg first on Query.brands was added.']],
      ])
    },
  },
  // A schema description is documentation: no behavior change.
  'b8-schema-description': { classification: 'isolated', affected: [] },
  // Hono: the prompts factory is mounted once, under /admin/api/prompts; the other factories' GET / are untouched.
  'b11-hono': { classification: 'touches-existing', affected: ['GET /admin/api/prompts'] },
  // A Kafka handler named in backend.entries calls a use case it only imports as a type.
  'b13-entries': { classification: 'touches-existing', affected: ['CONSUMER src/consumers/signal.handler.ts'] },
}

describe('backend scenarios (GraphQL and REST)', () => {
  for (const [scenario, spec] of Object.entries(SCENARIOS)) {
    it(scenario, async () => {
      const { output, cleanup } = await analyzeScenario(scenario)
      cleanups.push(cleanup)
      expect(output.surface).toBe('backend')
      expect(output.classification).toBe(spec.classification)
      expect(output.routes.affected.map((r) => r.key)).toEqual(spec.affected)
      spec.check?.(output)
      const golden = join(FIXTURES_DIR, scenario, 'expected.json')
      const actual = `${JSON.stringify(normalizeOutput(output), null, 2)}\n`
      if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) writeFileSync(golden, actual)
      expect(actual).toBe(readFileSync(golden, 'utf8'))
    })
  }

  it('lists GraphQL operations and REST endpoints with routes', () => {
    const s = createScenarioRepo('b1-new-query')
    cleanups.push(() => { s.repo.cleanup(); })
    const r = runCli(['--cwd', s.repo.dir, 'routes', '--ref', s.base])
    expect(r.code).toBe(0)
    const table = JSON.parse(r.stdout) as { routes: { key: string; modules: string[] }[] }
    expect(table.routes.map((x) => x.key)).toEqual(['GET /health', 'Mutation.renameBrand', 'POST /webhooks/stripe', 'Query.brand', 'Query.brands', 'Query.me'])
    expect(table.routes.find((x) => x.key === 'Query.me')?.modules).toEqual(['src/lib/format.ts', 'src/services/users.ts'])
  })
})

describe('Hono mounts', () => {
  const ADMIN = 'src/http/routes/admin.routes.ts'
  const READ = 'src/http/routes/admin/read-resource.routes.ts'
  const INDEX = 'src/http/routes/index.ts'
  const STATUS = 'src/http/routes/admin/status.routes.ts'
  const AUDIT = 'src/http/routes/admin/audit.routes.ts'
  const AUDIT_CODE = "import { Hono } from 'hono'\n\nexport function createAuditRoutes(): Hono {\n  const routes = new Hono()\n  routes.use('*', async (_c, next) => {\n    await next()\n  })\n  routes.get('/audit', (c) => c.json([]))\n  return routes\n}\n"

  const details = (o: Output, file: string): string[] => o.reasons.filter((r) => r.file === file).map((r) => r.detail)
  const expectText = (text: string): unknown => expect.stringContaining(text)

  /** b11-hono with the feature branch replaced by one commit that applies `change` to the base. */
  async function variant(change: (repo: ReturnType<typeof createScenarioRepo>['repo']) => void): Promise<Output> {
    const s = createScenarioRepo('b11-hono')
    cleanups.push(() => { s.repo.cleanup(); })
    s.repo.git('reset', '-q', '--hard', s.base)
    change(s.repo)
    s.repo.commit('variant')
    return (await analyzeRepo(s.repo)).output
  }

  it('lists one entry per mount with the full path; Fastify paths stay as written', () => {
    const s = createScenarioRepo('b11-hono')
    cleanups.push(() => { s.repo.cleanup(); })
    const r = runCli(['--cwd', s.repo.dir, 'routes', '--ref', s.base])
    expect(r.code).toBe(0)
    const table = JSON.parse(r.stdout) as { routes: { key: string }[]; dynamicRoutes: unknown[] }
    expect(table.routes.map((x) => x.key).filter((k) => k.includes(' '))).toEqual([
      'GET /admin/*',
      'GET /admin/api/issues',
      'GET /admin/api/issues/:id',
      'GET /admin/api/prompts',
      'GET /admin/api/prompts/:key',
      'GET /admin/api/signals',
      'GET /admin/api/signals/:id',
      'GET /admin/api/tasks',
      'GET /admin/api/tasks/:id',
      'GET /admin/api/whoami',
      'GET /health',
      'GET /healthz',
      'POST /admin/api/prompts',
      'POST /webhooks/stripe',
    ])
    expect(table.dynamicRoutes).toEqual([])
  })

  it('a change to a factory mounted three times affects the three endpoints, named in full', async () => {
    const o = await variant((repo) => { repo.write(READ, repo.read(READ).replace('must be an integer', 'must be a whole number')) })
    expect(o.classification).toBe('touches-existing')
    expect(o.routes.affected.map((r) => r.key)).toEqual(['GET /admin/api/issues/:id', 'GET /admin/api/signals/:id', 'GET /admin/api/tasks/:id'])
    expect(details(o, READ)).toContainEqual(expectText('endpoint GET /admin/api/issues/:id, GET /admin/api/signals/:id, GET /admin/api/tasks/:id changed'))
  })

  it('a new factory and its mount are new endpoints', async () => {
    const o = await variant((repo) => {
      repo.write('src/http/routes/admin/status.routes.ts', "import { Hono } from 'hono'\n\nexport function createStatusRoutes(): Hono {\n  const routes = new Hono()\n  routes.get('/', (c) => c.json({ up: true }))\n  return routes\n}\n")
      repo.write(ADMIN, repo.read(ADMIN).replace("import { createReadResourceRoutes }", "import { createStatusRoutes } from './admin/status.routes'\nimport { createReadResourceRoutes }").replace("\n\n  return routes", "\n  routes.route('/status', createStatusRoutes())\n\n  return routes"))
    })
    expect(o.classification).toBe('isolated')
    expect(o.routes.added.map((r) => r.key)).toEqual(['GET /admin/api/status'])
    expect(o.routes.affected).toEqual([])
  })

  it('a new mount whose path covers existing endpoints touches them (its middleware runs for them)', async () => {
    const o = await variant((repo) => {
      repo.write(AUDIT, AUDIT_CODE)
      repo.write(ADMIN, repo.read(ADMIN).replace("import { createReadResourceRoutes }", "import { createAuditRoutes } from './admin/audit.routes'\nimport { createReadResourceRoutes }").replace("\n\n  return routes", "\n  routes.route('/', createAuditRoutes())\n\n  return routes"))
    })
    expect(o.classification).toBe('touches-existing')
    expect(o.routes.added.map((r) => r.key)).toEqual(['GET /admin/api/audit'])
    expect(o.routes.affected.map((r) => r.key)).toContain('GET /admin/api/whoami')
    expect(o.routes.affected.map((r) => r.key)).not.toContain('GET /healthz')
    expect(details(o, ADMIN)).toContainEqual(expectText("mount '/' covers existing endpoints"))
  })

  it('a mount added in a file that does not import hono is compared too', async () => {
    const o = await variant((repo) => {
      repo.write(AUDIT, AUDIT_CODE)
      repo.write('src/main.ts', `${repo.read('src/main.ts').replace("import { ListPrompts }", "import { createAuditRoutes } from './http/routes/admin/audit.routes'\nimport { ListPrompts }")}app.route('/', createAuditRoutes())\n`)
    })
    expect(o.classification).toBe('touches-existing')
    expect(o.routes.affected.map((r) => r.key)).toContain('GET /healthz')
    expect(details(o, 'src/main.ts')).toContainEqual(expectText("mount '/' covers existing endpoints"))
  })

  it('a new mount with middleware under an existing wildcard route touches it', async () => {
    const o = await variant((repo) => {
      repo.write(STATUS, "import { Hono } from 'hono'\n\nexport function createStatusRoutes(): Hono {\n  const routes = new Hono()\n  routes.use('*', async (_c, next) => {\n    await next()\n  })\n  routes.get('/', (c) => c.json({ up: true }))\n  return routes\n}\n")
      repo.write(INDEX, repo.read(INDEX).replace("import { createHealthRoutes }", "import { createStatusRoutes } from './admin/status.routes'\nimport { createHealthRoutes }").replace("  app.get('/admin/*'", "  app.route('/admin/status', createStatusRoutes())\n  app.get('/admin/*'"))
    })
    expect(o.classification).toBe('touches-existing')
    expect(o.routes.affected.map((r) => r.key)).toEqual(['GET /admin/*'])
  })

  it('a new file whose mount has a call in its arguments is a change', async () => {
    const o = await variant((repo) => {
      repo.write(STATUS, "import { Hono } from 'hono'\n\nfunction load(): string {\n  return 'x'\n}\n\nfunction sub(flag: string): Hono {\n  const r = new Hono()\n  r.get('/', (c) => c.text(flag))\n  return r\n}\n\nexport function createStatusRoutes(): Hono {\n  const routes = new Hono()\n  routes.route('/x', sub(load()))\n  return routes\n}\n")
      repo.write(ADMIN, repo.read(ADMIN).replace("import { createReadResourceRoutes }", "import { createStatusRoutes } from './admin/status.routes'\nimport { createReadResourceRoutes }").replace("\n\n  return routes", "\n  routes.route('/status', createStatusRoutes())\n\n  return routes"))
    })
    expect(o.classification).toBe('touches-existing')
    expect(details(o, STATUS)).toContainEqual(expectText("mount '/x' was added with a call in its arguments"))
  })

  it('a new mount with a call in its arguments is a change (that code is not compared)', async () => {
    const o = await variant((repo) => {
      repo.write('src/http/routes/admin/status.routes.ts', "import { Hono } from 'hono'\n\nexport function createStatusRoutes(flags: string[]): Hono {\n  const routes = new Hono()\n  routes.get('/', (c) => c.json({ flags }))\n  return routes\n}\n")
      repo.write(ADMIN, repo.read(ADMIN).replace("import { createReadResourceRoutes }", "import { createStatusRoutes } from './admin/status.routes'\nimport { createReadResourceRoutes }").replace("\n\n  return routes", "\n  routes.route('/status', createStatusRoutes(loadFlags()))\n\n  return routes").replace("export function createAdminRoutes", "function loadFlags(): string[] {\n  return []\n}\n\nexport function createAdminRoutes"))
    })
    expect(o.classification).toBe('touches-existing')
    expect(details(o, ADMIN)).toContainEqual(expectText("mount '/status' was added with a call in its arguments"))
  })

  it('a renamed mount prefix is a change to existing endpoints', async () => {
    const o = await variant((repo) => { repo.write(ADMIN, repo.read(ADMIN).replace("routes.route('/signals'", "routes.route('/signal'")) })
    expect(o.classification).toBe('touches-existing')
    expect(details(o, ADMIN)).toContainEqual(expectText("mount '/signals' was removed"))
    expect(o.routes.added.map((r) => r.key)).toEqual(['GET /admin/api/signal', 'GET /admin/api/signal/:id'])
  })

  it('a prefix farol cannot read makes every PR unknown', async () => {
    const o = await variant((repo) => { repo.write(ADMIN, repo.read(ADMIN).replace("routes.route('/tasks'", "const TASKS = '/tasks'\n  routes.route(TASKS")) })
    expect(o.classification).toBe('unknown')
    expect(o.reasons.filter((r) => r.code === 'dynamic-route').map((r) => [r.file, r.detail])).toEqual([[ADMIN, 'line 23: Hono route() prefix is not a string literal']])
  })
})
