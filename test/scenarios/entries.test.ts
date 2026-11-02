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

  it('a test file that matches a glob is not an entry point', () => {
    const s = createScenarioRepo('b7-rest')
    cleanups.push(() => { s.repo.cleanup(); })
    s.repo.write('farol.config.json', JSON.stringify({ surface: 'backend', backend: { entries: { JOB: ['src/jobs/*.ts'] } }, roles: { test: ['**/*.test.ts'] } }))
    s.repo.write('src/jobs/drain.job.ts', 'export const drain = () => 1\n')
    s.repo.write('src/jobs/drain.job.test.ts', 'export const check = () => 1\n')
    const head = s.repo.commit('jobs')
    const table = JSON.parse(runCli(['--cwd', s.repo.dir, 'routes', '--ref', head]).stdout) as { routes: { key: string }[] }
    expect(table.routes.map((r) => r.key).filter((k) => k.startsWith('JOB'))).toEqual(['JOB src/jobs/drain.job.ts'])
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
    const keys = (JSON.parse(routes.stdout) as { routes: { key: string }[] }).routes.map((r) => r.key)
    expect(keys.filter((k) => /^(JOB|RUN) /.test(k))).toEqual([JOB, 'RUN src/scripts/seed.ts'])
    const impact = JSON.parse(runCli(['--cwd', s.repo.dir, 'impact', 'src/lib/b.ts', '--ref', head]).stdout) as { routes: { key: string }[] }
    expect(impact.routes.map((r) => r.key)).toEqual([JOB, 'RUN src/scripts/seed.ts'])
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
    const keys = (JSON.parse(r.stdout) as { routes: { key: string }[] }).routes.map((x) => x.key)
    expect(keys.filter((k) => k.startsWith('JOB'))).toEqual([`JOB services/x/${JOB_FILE}`])
  })
})
