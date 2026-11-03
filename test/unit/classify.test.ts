import { describe, expect, it } from 'vitest'
import { classify, type ClassifyInput } from '../../src/classify/classify.js'
import type { ChangedFile } from '../../src/git/types.js'
import type { ImportGraph } from '../../src/project/graph.js'
import type { RouteTable } from '../../src/routes/types.js'

const emptyGraph: ImportGraph = { nodes: [], edges: [], unresolved: [], parseErrors: [], reexportOnly: [] }
const table: RouteTable = { routes: [{ key: '/', path: '/', index: false, entry: 'src/Home.tsx', modules: ['src/Home.tsx'], layouts: [] }], dynamic: [], sources: [] }

function file(path: string, status: ChangedFile['status'], extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status, added: [], removed: [], binary: false, ...extra }
}

function run(partial: Partial<ClassifyInput>): ReturnType<typeof classify> {
  return classify({
    files: [],
    isIgnored: () => false,
    roleOf: (p) => (p.startsWith('../') || p.startsWith('other/') ? 'outside' : p.endsWith('.test.ts') ? 'test' : p.startsWith('src/mocks/') ? 'excluded' : p.endsWith('.json') ? 'i18n' : 'source'),
    graph: { ...emptyGraph, nodes: ['src/Home.tsx', 'other/shared.ts'], edges: [{ from: 'src/Home.tsx', to: 'other/shared.ts', kind: 'static' }] },
    manifests: [],
    otherManifests: [],
    routesFile: 'src/routes.tsx',
    headRoutes: table,
    baseRoutes: null,
    baseText: new Map(),
    headText: new Map(),
    isGenerated: () => false,
    ...partial,
  })
}

describe('classify', () => {
  it('ignores files outside the project unless the project imports them', () => {
    const r = run({ files: [file('other/app.ts', 'modified'), file('other/shared.ts', 'modified')] })
    expect(r.files.map((f) => [f.path, f.role])).toEqual([
      ['other/app.ts', 'excluded'],
      ['other/shared.ts', 'source'],
    ])
    expect(r.classification).toBe('touches-existing')
    expect(r.routes.affected).toEqual([{ key: '/', path: '/', hasChildren: false, via: [{ file: 'other/shared.ts', chain: ['src/Home.tsx', 'other/shared.ts'] }] }])
  })

  it('lists excluded files and keeps the PR isolated', () => {
    const r = run({ files: [file('src/mocks/a.ts', 'modified')] })
    expect(r.classification).toBe('isolated')
    expect(r.reasons.map((x) => x.code)).toEqual(['file-excluded', 'no-existing-code-touched'])
  })

  it('treats a modified file outside the graph as touches-existing (unreachable)', () => {
    const r = run({ files: [file('src/README.md', 'modified')] })
    expect(r.classification).toBe('touches-existing')
    expect(r.reasons[0]).toEqual({ code: 'existing-file-unreachable', file: 'src/README.md', detail: 'modified, and it is not part of the import graph' })
  })

  it('applies the i18n rule only to JSON files', () => {
    const r = run({ files: [file('src/locales/pt.ts', 'modified')], roleOf: () => 'i18n', baseText: new Map([['src/locales/pt.ts', 'x']]), headText: new Map([['src/locales/pt.ts', 'y']]) })
    expect(r.reasons[0]?.detail).toBe('the i18n rule only applies to JSON files')
    expect(r.classification).toBe('touches-existing')
  })

  it('makes the PR unknown when an unchanged file imports a file the PR deleted', () => {
    const graph: ImportGraph = { ...emptyGraph, nodes: ['src/Home.tsx'], unresolved: [{ file: 'src/Home.tsx', specifier: './gone', line: 3, reason: 'not-found', target: 'src/gone' }] }
    const r = run({ graph, files: [file('src/gone.tsx', 'deleted')] })
    expect(r.classification).toBe('unknown')
    expect(r.reasons[0]).toEqual({ code: 'unresolved-import', file: 'src/Home.tsx', detail: 'line 3: cannot resolve "./gone"' })
  })

  describe('imports of generated code (git-ignored, "generated" globs)', () => {
    const generatedImport = (target: string): ImportGraph => ({ ...emptyGraph, nodes: ['src/Home.tsx'], unresolved: [{ file: 'src/Home.tsx', specifier: '../generated/x', line: 2, reason: 'not-found', target }] })
    const isGenerated = (p: string): boolean => p.startsWith('src/generated/') || p === 'src/generated'

    it.each(['src/generated/prisma/client.js', 'src/generated/proto'])('does not make a changed importer of %s unknown', (target) => {
      expect(run({ graph: generatedImport(target), files: [file('src/Home.tsx', 'modified')], isGenerated }).reasons.map((r) => r.code)).not.toContain('unresolved-import')
    })

    it('makes a changed importer unknown when its target is not generated', () => {
      expect(run({ graph: generatedImport('src/lib/gone.js'), files: [file('src/Home.tsx', 'modified')], isGenerated }).classification).toBe('unknown')
    })

    it('still makes the PR unknown when it deletes a committed file that an unchanged file imports', () => {
      const r = run({ graph: generatedImport('src/generated/x'), files: [file('src/generated/x.ts', 'deleted')], isGenerated })
      expect(r.classification).toBe('unknown')
      expect(r.reasons[0]?.code).toBe('unresolved-import')
    })
  })

  it('ignores pre-existing unresolved imports that do not involve changed files', () => {
    const graph: ImportGraph = { ...emptyGraph, unresolved: [{ file: 'src/Old.tsx', specifier: './x', line: 1, reason: 'not-found', target: 'src/x' }] }
    expect(run({ graph, files: [file('src/new.ts', 'added')] }).classification).toBe('isolated')
  })

  it('global wins over unknown, unknown over touches-existing', () => {
    const graph: ImportGraph = { ...emptyGraph, parseErrors: [{ file: 'src/a.ts', line: 1, message: 'x' }] }
    expect(run({ graph, files: [file('src/a.ts', 'modified')] }).classification).toBe('unknown')
    expect(run({ graph, files: [file('src/a.ts', 'modified'), file('package.json', 'modified')], roleOf: (p) => (p === 'package.json' ? 'global' : 'source') }).classification).toBe('global')
  })

  it('a deleted test is reported but keeps the PR isolated', () => {
    const r = run({ files: [file('src/a.test.ts', 'deleted', { removed: [{ line: 1, text: 'x' }] })] })
    expect(r.classification).toBe('isolated')
    expect(r.reasons[0]).toEqual({ code: 'tests-modified', file: 'src/a.test.ts', detail: 'existing test deleted, 1 line(s) removed' })
  })
})
