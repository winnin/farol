import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { isCommentsOnlyChange } from '../../src/classify/additive.js'
import { headerChanged } from '../../src/decls/impact.js'
import { fileHeader } from '../../src/project/decls.js'

const header = (code: string): string[] => fileHeader(ts.createSourceFile('a.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX))
const changed = (before: string, after: string): boolean => headerChanged(header(before), header(after))

describe('file header: what declarations leave out', () => {
  it('counts a name imported from another module, not a name added or removed', () => {
    expect(changed("import { Card } from './components'", "import { Card } from './components/FancyCard'")).toBe(true)
    expect(changed("import { Card } from './a'", "import { Fancy as Card } from './a'")).toBe(true)
    expect(changed("import { Outlet } from 'r'", "import { Link, Outlet } from 'r'")).toBe(false)
    expect(changed("import { Link, Outlet } from 'r'", "import { Outlet } from 'r'")).toBe(false)
  })

  it('ignores type-only imports and counts side-effect imports and re-exports', () => {
    expect(changed("import type { A } from './a'", "import type { A } from './b'")).toBe(false)
    expect(changed('const x = 1', "import './polyfill'\nconst x = 1")).toBe(true)
    expect(changed("export { a } from './a'", "export { a } from './b'")).toBe(true)
  })

  it('counts triple-slash directives and code comments, each in its statement', () => {
    expect(changed('/// <reference path="./a.ts" />\nconst x = 1', '/// <reference path="./b.ts" />\nconst x = 1')).toBe(true)
    expect(changed('const a = /*#__PURE__*/ f()\nconst b = g()', 'const a = f()\nconst b = /*#__PURE__*/ g()')).toBe(true)
    expect(changed('// note\nconst a = 1', '// other note\nconst a = 1')).toBe(false)
  })

  it('fails closed when one side has no header', () => {
    expect(headerChanged(undefined, [])).toBe(true)
    expect(headerChanged(undefined, undefined)).toBe(false)
  })

  it('never reads a changed triple-slash directive as comments-only', () => {
    expect(isCommentsOnlyChange('a.ts', '/// <reference path="./a.ts" />\nexport const x = 1\n', '/// <reference path="./b.ts" />\nexport const x = 1\n')).toBe(false)
    expect(isCommentsOnlyChange('a.ts', '/// note\nexport const x = 1\n', '/// other note\nexport const x = 1\n')).toBe(true)
  })
})
