import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Output } from '../../src/output/schema.js'
import { runCli } from '../helpers/cli.js'
import { BASE_API_DIR, createRepo, createScenarioRepo } from '../helpers/repo.js'
import { analyzeVariant, type Change } from '../helpers/variant.js'

const cleanups: (() => void)[] = []
afterAll(() => {
  for (const c of cleanups) c()
})

const JOB_FILE = 'src/jobs/drain.job.ts'
const JOB = `JOB ${JOB_FILE}`
const CONFIG = JSON.stringify({ surface: 'backend', backend: { entries: { JOB: ['src/jobs/*.job.ts'] } } })
const job = (body: string, imports = ''): string => `${imports}export function drain(limit: number) {
  const items = [1, 2, 3].slice(0, limit)
  const total = items.reduce((sum, item) => sum + item, 0)
  const label = 'drained'
  ${body}
  return { label, total }
}
`

/** A base with a job in `backend.entries` that runs job → a → b. */
const withJob: Change = (repo) => {
  repo.write('farol.config.json', CONFIG)
  repo.write('src/lib/b.ts', "export const b = () => 'b'\n")
  repo.write('src/lib/a.ts', "import { b } from './b'\nexport const a = () => b()\n")
  repo.write(JOB_FILE, job('a()', "import { a } from '../lib/a'\n"))
}

const pr = (change: Change, setup: Change = withJob): Promise<Output> => analyzeVariant('b7-rest', cleanups, change, setup)
const codes = (o: Output): string[] => o.reasons.map((r) => r.code)
const routeKeys = (stdout: string): string[] => (JSON.parse(stdout) as { routes: { key: string }[] }).routes.map((r) => r.key)

describe('entry points named in backend.entries', () => {
  it('a change to code a job runs lists the job, with the chain from what it uses', async () => {
    const o = await pr((repo) => { repo.write('src/lib/b.ts', "export const b = () => 'c'\n") })
    expect(o.classification).toBe('touches-existing')
    expect(o.routes.affected.map((r) => [r.key, r.via.map((v) => v.chain)])).toEqual([[JOB, [['src/lib/a.ts', 'src/lib/b.ts']]]])
  })

  it('a PR that only adds a job and its helper is isolated, with the job as a new entry point', async () => {
    const NEW = 'src/jobs/probe.job.ts'
    const o = await pr((repo) => {
      repo.write('src/lib/probe.ts', 'export const probe = () => 1\n')
      repo.write(NEW, "import { probe } from '../lib/probe'\nexport const run = () => probe()\n")
    })
    expect(o.classification).toBe('isolated')
    expect(o.routes.added.map((r) => r.key)).toEqual([`JOB ${NEW}`])
    expect(o.routes.affected).toEqual([])
  })

  it('a new helper in an existing job changes that job: it is not a new entry point', async () => {
    const o = await pr((repo) => {
      repo.write('src/lib/helper.ts', 'export const helper = () => 1\n')
      repo.write(JOB_FILE, job('a(); helper()', "import { a } from '../lib/a'\nimport { helper } from '../lib/helper'\n"))
    })
    expect(o.classification).toBe('touches-existing')
    expect(o.routes.added).toEqual([])
    expect(o.routes.affected.map((r) => r.key)).toEqual([JOB])
  })

  it('a renamed and edited job stays an existing entry point', async () => {
    const MOVED = 'src/jobs/drain-all.job.ts'
    const o = await pr((repo) => {
      repo.remove(JOB_FILE)
      repo.write(MOVED, job('a(); a()', "import { a } from '../lib/a'\n"))
    })
    expect(codes(o)).toContain('existing-file-renamed')
    expect(o.routes.added).toEqual([])
    expect(o.routes.affected.map((r) => r.key)).toEqual([`JOB ${MOVED}`])
  })

  describe('an edit of the file named as an entry point', () => {
    const SIDE = 'export const s = (() => 1)()\n'
    const entries = (globs: Record<string, string[]>): Change => (repo) => {
      withJob(repo)
      repo.write('farol.config.json', JSON.stringify({ surface: 'backend', backend: { entries: globs } }))
      repo.write('src/lib/side.ts', SIDE)
    }
    const RE_EXPORT = "export { s } from '../lib/side'\n"
    const SERVER = "import express from 'express'\nconst port = 1\nexport const app = express()\napp.get('/x', async () => port)\n"

    it('is a change when the file is a barrel', async () => {
      const BARREL = 'src/jobs/index.ts'
      const o = await pr((repo) => { repo.write(BARREL, `export { a } from '../lib/a'\n${RE_EXPORT}`) }, (repo) => {
        entries({ JOB: [BARREL] })(repo)
        repo.write(BARREL, "export { a } from '../lib/a'\n")
      })
      expect(o.classification).toBe('touches-existing')
      expect(o.routes.affected.map((r) => r.key)).toEqual([`JOB ${BARREL}`])
    })

    it('is a change when the file has REST handlers and only gains a re-export', async () => {
      const FILE = 'src/rest/server.ts'
      const o = await pr((repo) => { repo.write(FILE, `${SERVER}${RE_EXPORT}`) }, (repo) => {
        entries({ RUN: [FILE] })(repo)
        repo.write(FILE, SERVER)
      })
      expect(o.classification).toBe('touches-existing')
      expect(o.routes.affected.map((r) => r.key)).toContain(`RUN ${FILE}`)
    })

    it('lists the entry point beside the endpoints of its file', async () => {
      const FILE = 'src/rest/server.ts'
      const o = await pr((repo) => { repo.write(FILE, SERVER.replace('port = 1', 'port = 2')) }, (repo) => {
        entries({ RUN: [FILE] })(repo)
        repo.write(FILE, SERVER)
      })
      expect(o.routes.affected.map((r) => r.key)).toEqual(['GET /x', `RUN ${FILE}`])
    })

    it('is a change when a plain job gains a Hono app that runs its code', async () => {
      const HONO = "import { Hono } from 'hono'\nexport function run() { return 1 }\nexport const app = new Hono()\napp.get('/x', (c) => c.text(String(run())))\n"
      const o = await pr((repo) => { repo.write(JOB_FILE, HONO) }, (repo) => {
        entries({ JOB: [JOB_FILE] })(repo)
        repo.write(JOB_FILE, 'export function run() { return 1 }\n')
      })
      expect(o.classification).toBe('touches-existing')
      expect(o.routes.affected.map((r) => r.key)).toContain(JOB)
    })

    it('counts the entry point in the risk of its file', async () => {
      const FILE = 'src/rest/server.ts'
      const o = await pr((repo) => { repo.write(FILE, `// note\n${SERVER}`) }, (repo) => {
        entries({ RUN: [FILE] })(repo)
        repo.write(FILE, SERVER)
      })
      const risk = o.risk.files.find((f) => f.path === FILE)
      expect(risk?.change).toBe('modified')
      expect(risk?.routesReached).toBeGreaterThan(0)
    })

    it('reads only as a change: no reason calls the edit additive', async () => {
      const BARREL = 'src/jobs/index.ts'
      const o = await pr((repo) => { repo.write(BARREL, `export { a } from '../lib/a'\n${RE_EXPORT}`) }, (repo) => {
        entries({ JOB: [BARREL] })(repo)
        repo.write(BARREL, "export { a } from '../lib/a'\n")
      })
      expect(codes(o)).toContain('existing-file-modified')
      expect(codes(o)).not.toContain('barrel-additive')
    })

    it('changes nothing at runtime when the file only declares types', async () => {
      const PORT = 'src/jobs/port.ts'
      const o = await pr((repo) => { repo.write(PORT, 'export type A = number\nexport type B = string\n') }, (repo) => {
        entries({ JOB: [PORT] })(repo)
        repo.write(PORT, 'export type A = number\n')
      })
      expect(o.classification).toBe('isolated')
      expect(codes(o)).toContain('type-only-change')
      expect(o.routes.affected).toEqual([])
    })

    it('changes nothing at runtime when the file is a barrel of types only', async () => {
      const BARREL = 'src/jobs/index.ts'
      const o = await pr((repo) => { repo.write(BARREL, "export type { A } from './a'\nexport type { B } from './b'\n") }, (repo) => {
        entries({ JOB: [BARREL] })(repo)
        repo.write('src/jobs/a.ts', 'export type A = number\n')
        repo.write('src/jobs/b.ts', 'export type B = number\n')
        repo.write(BARREL, "export type { A } from './a'\n")
      })
      expect(o.classification).toBe('isolated')
      expect(o.routes.affected).toEqual([])
    })
  })

  describe('what a job runs', () => {
    const USE_CASE = 'src/lib/use-case.ts'
    const useCase = (value: number): string => `export class UseCase {\n  execute() { return ${value} }\n}\n`

    it('does not include a class the job only names as a type', async () => {
      const o = await pr((repo) => { repo.write(USE_CASE, useCase(2)) }, (repo) => {
        withJob(repo)
        repo.write(USE_CASE, useCase(1))
        repo.write(JOB_FILE, job('', "import type { UseCase } from '../lib/use-case'\nexport const keep = (u: UseCase) => u\n"))
      })
      expect(o.classification).toBe('touches-existing')
      expect(o.routes.affected).toEqual([])
    })

    it('includes a class the job imports as a type and calls', async () => {
      const o = await pr((repo) => { repo.write(USE_CASE, useCase(2)) }, (repo) => {
        withJob(repo)
        repo.write(USE_CASE, useCase(1))
        repo.write(JOB_FILE, job('', "import type { UseCase } from '../lib/use-case'\nexport const run = (u: UseCase) => u.execute()\n"))
      })
      expect(o.routes.affected.map((r) => r.key)).toEqual([JOB])
    })

    it('includes a module the job re-exports', async () => {
      const o = await pr((repo) => { repo.write('src/lib/b.ts', "export const b = () => 'c'\n") }, (repo) => {
        withJob(repo)
        repo.write(JOB_FILE, "export { a } from '../lib/a'\n")
      })
      expect(o.routes.affected.map((r) => r.key)).toEqual([JOB])
    })
  })

  it('a test file that matches a glob is not an entry point', () => {
    const s = createScenarioRepo('b7-rest')
    cleanups.push(() => { s.repo.cleanup(); })
    s.repo.write('farol.config.json', JSON.stringify({ surface: 'backend', backend: { entries: { JOB: ['src/jobs/*.ts'] } }, roles: { test: ['**/*.test.ts'] } }))
    s.repo.write('src/jobs/drain.job.ts', 'export const drain = () => 1\n')
    s.repo.write('src/jobs/drain.job.test.ts', 'export const check = () => 1\n')
    const head = s.repo.commit('jobs')
    expect(routeKeys(runCli(['--cwd', s.repo.dir, 'routes', '--ref', head]).stdout).filter((k) => k.startsWith('JOB'))).toEqual(['JOB src/jobs/drain.job.ts'])
  })

  it('routes lists entry points in order, and impact finds them', () => {
    const s = createScenarioRepo('b7-rest')
    cleanups.push(() => { s.repo.cleanup(); })
    withJob(s.repo)
    s.repo.write('farol.config.json', JSON.stringify({ surface: 'backend', backend: { entries: { RUN: ['src/scripts/*.ts'], JOB: ['src/jobs/*.job.ts'] } } }))
    s.repo.write('src/scripts/seed.ts', "import { b } from '../lib/b'\nb()\n")
    const head = s.repo.commit('entries')
    const routes = runCli(['--cwd', s.repo.dir, 'routes', '--ref', head])
    expect(routes.code).toBe(0)
    expect(routeKeys(routes.stdout).filter((k) => /^(JOB|RUN) /.test(k))).toEqual([JOB, 'RUN src/scripts/seed.ts'])
    expect(routeKeys(runCli(['--cwd', s.repo.dir, 'impact', 'src/lib/b.ts', '--ref', head]).stdout)).toEqual([JOB, 'RUN src/scripts/seed.ts'])
  })

  it('globs are relative to the project in a monorepo, and keys to the repository', () => {
    const repo = createRepo()
    cleanups.push(() => { repo.cleanup(); })
    cpSync(BASE_API_DIR, join(repo.dir, 'services/x'), { recursive: true })
    repo.write('services/x/farol.config.json', CONFIG)
    repo.write(`services/x/${JOB_FILE}`, 'export const drain = () => 1\n')
    repo.write(`services/y/${JOB_FILE}`, 'export const drain = () => 1\n')
    const head = repo.commit('base')
    const r = runCli(['--cwd', join(repo.dir, 'services/x'), 'routes', '--ref', head])
    expect(r.code).toBe(0)
    expect(routeKeys(r.stdout).filter((k) => k.startsWith('JOB'))).toEqual([`JOB services/x/${JOB_FILE}`])
  })
})
