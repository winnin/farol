import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FIXED_DATE } from '../helpers/analyze.js'
import { BASE_APP_DIR, createRepo, type TestRepo } from '../helpers/repo.js'
import { analyzeVariant, type Change } from '../helpers/variant.js'
import { loadContext } from '../../src/cli/context.js'
import { runAnalyze } from '../../src/cli/analyze.js'
import { OutputSchema, type Output } from '../../src/output/schema.js'

const cleanups: (() => void)[] = []
afterAll(() => {
  for (const c of cleanups) c()
})

const ORPHAN = 'export function orphan(n: number) {\n  const doubled = n * 2\n  const label = `value ${doubled}`\n  return label.toUpperCase()\n}\n'
const codes = (o: Output): string[] => o.reasons.map((r) => r.code)
const app = (change: Change, setup?: Change): Promise<Output> => analyzeVariant('17-test-only', cleanups, change, setup)
/** Git reads the same content at a new path as a rename. */
const mv = (from: string, to: string): Change => (repo) => {
  repo.write(to, repo.read(from))
  repo.remove(from)
}
const withFile = (path: string, content = ORPHAN): Change => (repo) => { repo.write(path, content) }
const config = (repo: TestRepo, extra: Record<string, unknown>): void => {
  repo.write('farol.config.json', JSON.stringify({ ...(JSON.parse(repo.read('farol.config.json')) as object), ...extra }))
}

describe('a rename out of production code', () => {
  it.each([
    ['a test path', 'src/lib/orphan.test.ts'],
    ['a story path', 'src/lib/orphan.stories.tsx'],
    ['an excluded path', 'src/mocks/orphan.ts'],
  ])('is a change of existing code when a source file moves to %s', async (_name, to) => {
    const o = await app(mv('src/lib/orphan.ts', to), withFile('src/lib/orphan.ts'))
    expect(o.classification).toBe('touches-existing')
    expect(o.reasons).toContainEqual(expect.objectContaining({ code: 'existing-file-renamed', file: to }))
  })

  it('does not report an existing test when a source file moves to a test path', async () => {
    const o = await app(mv('src/lib/orphan.ts', 'src/lib/orphan.test.ts'), withFile('src/lib/orphan.ts'))
    expect(codes(o)).not.toContain('tests-modified')
    expect(o.signals.testsModified.files).toEqual([])
  })

  it('is a change of existing code when a global file moves to a test path', async () => {
    const o = await app(mv('src/main.tsx', 'src/main.test.tsx'))
    expect(o.classification).toBe('touches-existing')
    expect(o.reasons).toContainEqual(expect.objectContaining({ code: 'existing-file-renamed', file: 'src/main.test.tsx' }))
  })

  it('is a change of existing code when a source file moves to an ignored path', async () => {
    const o = await app(mv('src/lib/orphan.ts', 'src/legacy/orphan.ts'), (repo) => {
      config(repo, { ignore: ['src/legacy/**'] })
      withFile('src/lib/orphan.ts')(repo)
    })
    expect(o.classification).toBe('touches-existing')
    expect(codes(o)).toContain('existing-file-renamed')
  })

  it('leaves a file that moves to an ignored path out of the signals', async () => {
    const o = await app(mv('src/lib/a.test.ts', 'src/legacy/a.test.ts'), (repo) => {
      config(repo, { ignore: ['src/legacy/**'] })
      withFile('src/lib/a.test.ts')(repo)
    })
    expect(o.signals.testsModified.files).toEqual([])
    expect(o.ignoredFiles).toEqual(['src/legacy/a.test.ts'])
  })

  it('reads a file that moves to an ignored path only as a rename out', async () => {
    const o = await app(mv('src/pkg/package.json', 'src/legacy/package.json'), (repo) => {
      config(repo, { ignore: ['src/legacy/**'] })
      repo.write('src/pkg/package.json', JSON.stringify({ name: 'pkg', version: '1.0.0', dependencies: { lodash: '4.17.21' } }, null, 2))
    })
    expect(o.classification).toBe('touches-existing')
    expect(o.reasons).toContainEqual(expect.objectContaining({ code: 'existing-file-renamed', file: 'src/legacy/package.json' }))
    expect(codes(o)).not.toContain('manifest-changed')
  })

  it('leaves out a rename when both of its paths are ignored', async () => {
    const o = await app(mv('src/legacy/a.ts', 'src/legacy/b.ts'), (repo) => {
      config(repo, { ignore: ['src/legacy/**'] })
      withFile('src/legacy/a.ts')(repo)
    })
    expect(o.files.map((f) => f.path)).not.toContain('src/legacy/b.ts')
    expect(o.files.map((f) => f.path)).not.toContain('src/legacy/a.ts')
    expect(o.classification).toBe('isolated')
    expect(codes(o)).not.toContain('existing-file-renamed')
  })

  it('is a change of existing code when a Go file moves to a test file', async () => {
    // Any Go scenario: analyzeVariant starts from its base (`_base-go`) and drops its head.
    const o = await analyzeVariant('g2-service-changed', cleanups, mv('internal/service/brands.go', 'internal/service/brands_test.go'))
    // `cmd/api` calls the moved code, so a check of removed declarations may also give `unknown` later.
    expect(o.classification).not.toBe('isolated')
    expect(codes(o)).toContain('existing-file-renamed')
  })

  it('is a change of existing code when a file moves out of the project in a monorepo', async () => {
    const repo = createRepo()
    cleanups.push(() => { repo.cleanup() })
    cpSync(BASE_APP_DIR, join(repo.dir, 'services/x'), { recursive: true })
    repo.write('services/x/src/lib/orphan.ts', ORPHAN)
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feature')
    mv('services/x/src/lib/orphan.ts', 'services/y/orphan.ts')(repo)
    repo.commit('feature')
    const ctx = await loadContext({ config: 'farol.config.json', cwd: `${repo.dir}/services/x`, verbose: false })
    const { output } = await runAnalyze(ctx, { base: 'main', head: 'feature' }, { now: () => FIXED_DATE, clock: () => 0, env: {} })
    OutputSchema.parse(output)
    expect(output.classification).toBe('touches-existing')
    expect(codes(output)).toContain('existing-file-renamed')
  }, 60_000)

  it.each([
    ['test', 'src/lib/a.test.ts', 'src/lib/b.test.ts'],
    ['story', 'src/lib/A.stories.tsx', 'src/lib/B.stories.tsx'],
    ['excluded', 'src/mocks/a.ts', 'src/mocks/b.ts'],
  ])('stays isolated when a %s file moves to a path of the same role', async (_role, from, to) => {
    const o = await app(mv(from, to), withFile(from))
    expect(o.classification).toBe('isolated')
    expect(codes(o)).not.toContain('existing-file-renamed')
  })
})

describe('an import written with the extension of the emitted file', () => {
  const user = (specifier: string): string => `import { orphan } from '${specifier}'\nexport const user = () => orphan(1)\n`
  const remove = (path: string): Change => (repo) => { repo.remove(path) }

  it.each([
    ['renamed', 'src/lib/a.ts', './a.js', mv('src/lib/a.ts', 'src/lib/a.test.ts')],
    ['deleted', 'src/lib/a.ts', './a.js', remove('src/lib/a.ts')],
    ['deleted', 'src/lib/a.tsx', './a.js', remove('src/lib/a.tsx')],
    ['deleted', 'src/lib/a.mts', './a.mjs', remove('src/lib/a.mts')],
    ['deleted', 'src/lib/a.ts', './a.jsx', remove('src/lib/a.ts')],
    ['deleted', 'src/lib/a.js', './a.jsx', remove('src/lib/a.js')],
  ])('breaks when its target is %s (%s as %s)', async (_how, target, specifier, change) => {
    const o = await app(change, (repo) => {
      repo.write(target, ORPHAN)
      repo.write('src/lib/user.ts', user(specifier))
    })
    expect(o.classification).toBe('unknown')
    expect(o.reasons).toContainEqual(expect.objectContaining({ code: 'unresolved-import', file: 'src/lib/user.ts' }))
  })

  it.each([
    ['a file of another kind with the same name', 'src/lib/gen.css', './gen.js'],
    ['a folder index of the same name', 'src/lib/lib/index.ts', './lib.js'],
  ])('does not break when the PR removes %s', async (_name, removed, specifier) => {
    const o = await app(remove(removed), (repo) => {
      repo.write(removed, removed.endsWith('.css') ? '.a { color: red; }\n' : ORPHAN)
      repo.write('src/lib/user.ts', user(specifier))
    })
    expect(codes(o)).toContain('existing-file-deleted')
    expect(o.classification).not.toBe('unknown')
  })

  it.each([
    ['./a.js', 'src/lib/a.d.ts'],
    ['./a', 'src/lib/a.d.ts'],
    ['./a.mjs', 'src/lib/a.d.mts'],
  ])('breaks when the declaration file %s points at is deleted (%s)', async (specifier, declaration) => {
    const o = await app(remove(declaration), (repo) => {
      repo.write(declaration, 'export declare function orphan(n: number): string\n')
      repo.write('src/lib/user.ts', user(specifier))
    })
    expect(o.classification).toBe('unknown')
    expect(o.reasons).toContainEqual(expect.objectContaining({ code: 'unresolved-import', file: 'src/lib/user.ts' }))
  })
})
