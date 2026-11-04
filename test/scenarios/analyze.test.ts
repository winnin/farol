import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { analyzeScenario, normalizeOutput } from '../helpers/analyze.js'
import { FIXTURES_DIR } from '../helpers/repo.js'
import type { Output } from '../../src/output/schema.js'
import { scoreItems } from '../../src/report/merge-score.js'

/** Expected class and key facts per scenario (docs/SPEC.md), checked on top of the golden file. */
const SCENARIOS: Record<string, { classification: Output['classification']; check?: (o: Output) => void }> = {
  '01-new-route': { classification: 'isolated', check: (o) => { expect(o.routes.added.map((r) => r.path)).toEqual(['/reports']); } },
  '02-route-barrel-i18n': {
    classification: 'isolated',
    check: (o) => { expect(o.files.filter((f) => f.additive !== undefined).map((f) => [f.role, f.additive])).toEqual([['barrel', true], ['i18n', true], ['routes', true]]); },
  },
  '03-child-of-layout': { classification: 'isolated', check: (o) => { expect(o.routes.added.map((r) => r.key)).toEqual(['/ > help']); } },
  '04-child-of-modified-layout': { classification: 'touches-existing', check: (o) => { expect(o.routes.affected.map((r) => r.key)).toEqual(['/', '/ > (index)', '/ > about', '/ > products', '/ > settings']); } },
  '05-shared-component': {
    classification: 'touches-existing',
    check: (o) => { expect(o.routes.affected).toEqual([
        { key: '/ > (index)', path: '/', hasChildren: false, via: [{ file: 'src/components/Card.tsx', chain: ['src/pages/HomePage.tsx', 'src/components/Card.tsx'] }] },
        { key: '/ > products', path: '/products', hasChildren: false, via: [{ file: 'src/components/Card.tsx', chain: ['src/pages/ProductsPage.tsx', 'src/components/Card.tsx'] }] },
      ]); },
  },
  '06-optional-prop': { classification: 'touches-existing', check: (o) => { expect(o.routes.affected.map((r) => r.path)).toEqual(['/about', '/products', '/settings']); } },
  '07-route-component-swapped': { classification: 'touches-existing', check: (o) => { expect(o.reasons.map((r) => r.code)).toContain('routes-not-additive'); } },
  '08-i18n-value-changed': { classification: 'touches-existing', check: (o) => { expect(o.reasons.map((r) => r.code)).toContain('i18n-not-additive'); } },
  '09-barrel-export-removed': { classification: 'touches-existing', check: (o) => { expect(o.reasons.map((r) => r.code)).toContain('barrel-not-additive'); } },
  '10-global-css': { classification: 'global' },
  '11-routes-from-map': { classification: 'unknown', check: (o) => { expect(o.diagnostics.dynamicRoutes).toHaveLength(1); } },
  '12-file-deleted': { classification: 'touches-existing', check: (o) => { expect(o.reasons.map((r) => r.code)).toContain('existing-file-deleted'); } },
  '13-file-renamed': { classification: 'touches-existing', check: (o) => { expect(o.reasons.map((r) => r.code)).toContain('existing-file-renamed'); } },
  '14-barrel-precision': { classification: 'touches-existing', check: (o) => { expect(o.routes.affected.map((r) => r.path)).not.toContain('/about'); } },
  '15-alias-and-lazy': { classification: 'touches-existing', check: (o) => { expect(o.routes.affected.map((r) => r.path)).toEqual(['/products', '/settings']); } },
  // Only the Product interface changed: types are erased, so neither the page importing the type nor the page importing
  // a value of the same module (PRODUCT_KINDS, unchanged) runs different code.
  '16-import-type-only': {
    classification: 'isolated',
    check: (o) => {
      expect(o.routes.affected).toEqual([])
      expect(o.reasons.find((r) => r.code === 'declarations-additive')?.detail).toContain('types changed (erased at runtime)')
    },
  },
  '17-test-only': { classification: 'isolated', check: (o) => { expect(o.signals.testsModified.files.map((f) => f.path)).toEqual(['src/components/Button.test.tsx']); } },
  '18-disconnected-file': { classification: 'isolated', check: (o) => { expect(o.routes.disconnectedNewFiles).toEqual(['src/lib/analytics.ts']); } },
  '19-no-trailing-comma': { classification: 'isolated', check: (o) => { expect(o.files.find((f) => f.role === 'routes')?.linesRemoved).toBe(0); } },
  '20-syntax-error': { classification: 'unknown', check: (o) => { expect(o.reasons.map((r) => r.code)).toContain('parse-error'); } },
  // labels.ts exports two functions; only aboutLabel changed, so only the page that calls it is affected (the file
  // graph would list every page importing labels.ts).
  '21-function-precision': {
    classification: 'touches-existing',
    check: (o) => {
      expect(o.routes.affected.map((r) => r.path)).toEqual(['/about'])
      expect(o.reasons.find((r) => r.code === 'existing-file-modified')?.detail).toContain('func src/lib/labels.ts#aboutLabel changed')
    },
  },
  // Only comments changed in a component two pages render: the code that runs is the same, so nothing is affected
  // and the file adds nothing to the merge risk.
  '22-comments-only': {
    classification: 'isolated',
    check: (o) => {
      expect(o.routes.affected).toEqual([])
      expect(o.files.find((f) => f.path === 'src/components/Card.tsx')?.commentsOnly).toBe(true)
      expect(o.reasons.filter((r) => r.file === 'src/components/Card.tsx').map((r) => [r.code, r.detail])).toEqual([['declarations-additive', 'only comments or formatting changed']])
      expect(scoreItems(o).filter((i) => i.file === 'src/components/Card.tsx')).toEqual([])
    },
  },
  // Only comments changed in the routes file and in a barrel: their role rules do not run, and they add no risk.
  '23-comments-only-routes-barrel': {
    classification: 'isolated',
    check: (o) => {
      expect(o.routes.affected).toEqual([])
      expect(o.files.filter((f) => f.commentsOnly === true).map((f) => f.path)).toEqual(['src/components/index.ts', 'src/routes.tsx'])
      expect(o.reasons.filter((r) => r.code !== 'no-existing-code-touched').map((r) => r.code)).toEqual(['declarations-additive', 'declarations-additive'])
      expect(scoreItems(o)).toEqual([])
    },
  },
  // HomePage now imports Card from another module: no declaration of HomePage changed (the declaration graph leaves
  // imports out), but the page runs different code. It is a modification, never comments-only.
  '24-import-swapped': {
    classification: 'touches-existing',
    check: (o) => {
      const page = o.files.find((f) => f.path === 'src/pages/HomePage.tsx')
      expect(page?.commentsOnly).toBeUndefined()
      expect(o.reasons.filter((r) => r.file === 'src/pages/HomePage.tsx').map((r) => r.code)).toEqual(['existing-file-modified'])
      expect(o.routes.affected.map((r) => r.path)).toContain('/')
      expect(scoreItems(o).some((i) => i.file === 'src/pages/HomePage.tsx')).toBe(true)
    },
  },
}

const cleanups: (() => void)[] = []
afterAll(() => {
  for (const c of cleanups) c()
})

describe('analyze golden scenarios', () => {
  const dirs = readdirSync(FIXTURES_DIR).filter((d) => /^\d\d-/.test(d))

  it('has a golden file and an expectation for every classification scenario', () => {
    expect(dirs.filter((d) => /^(0\d|1\d|2\d)-/.test(d))).toEqual(Object.keys(SCENARIOS))
  })

  for (const scenario of Object.keys(SCENARIOS)) {
    it(scenario, async () => {
      const { output, cleanup } = await analyzeScenario(scenario)
      cleanups.push(cleanup)
      const spec = SCENARIOS[scenario]
      expect(output.classification).toBe(spec?.classification)
      spec?.check?.(output)
      const golden = join(FIXTURES_DIR, scenario, 'expected.json')
      const actual = `${JSON.stringify(normalizeOutput(output), null, 2)}\n`
      if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) writeFileSync(golden, actual)
      expect(actual).toBe(readFileSync(golden, 'utf8'))
    })
  }
})
