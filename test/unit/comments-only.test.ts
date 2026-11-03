import { describe, expect, it } from 'vitest'
import { isCommentsOnlyChange } from '../../src/classify/additive.js'

describe('comments-only changes', () => {
  it('ignores comments and formatting, in TS and JSX', () => {
    const base = 'export function f(a: number) {\n  return a + 1\n}\n'
    expect(isCommentsOnlyChange('a.ts', base, '/** Adds one. */\nexport function f(a: number) {\n  // the next value\n  return a+1\n}\n')).toBe(true)
    expect(isCommentsOnlyChange('C.tsx', 'export const C = () => <p>hi</p>\n', 'export const C = () => /* greeting */ <p>hi</p>\n')).toBe(true)
  })

  it('sees any change to the code, including JSX text that looks like a comment', () => {
    expect(isCommentsOnlyChange('a.ts', 'export const x = 1\n', 'export const x = 2 // was 1\n')).toBe(false)
    expect(isCommentsOnlyChange('C.tsx', 'export const C = () => <p>a // b</p>\n', 'export const C = () => <p>a // c</p>\n')).toBe(false)
    expect(isCommentsOnlyChange('a.ts', "const s = '// x'\n", "const s = '// y'\n")).toBe(false)
  })

  it('treats comments that change emitted or bundled code as code', () => {
    expect(isCommentsOnlyChange('C.tsx', '/** @jsxImportSource react */\nexport const C = () => <p />\n', '/** @jsxImportSource preact */\nexport const C = () => <p />\n')).toBe(false)
    expect(isCommentsOnlyChange('a.ts', 'export const x = make()\n', 'export const x = /* #__PURE__ */ make()\n')).toBe(false)
    expect(isCommentsOnlyChange('a.ts', "const m = import('./m')\n", "const m = import(/* webpackChunkName: 'm' */ './m')\n")).toBe(false)
  })

  it('is never true for a file that does not parse, or that is not a script', () => {
    expect(isCommentsOnlyChange('a.ts', 'export const x = (\n', 'export const x = ( // oops\n')).toBe(false)
    expect(isCommentsOnlyChange('a.css', 'a {}\n', '/* x */ a {}\n')).toBe(false)
  })
})
