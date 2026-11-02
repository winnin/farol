import { describe, expect, it } from 'vitest'
import { baseDecls } from '../../src/project/decls.js'
import { codeTokens, parseIsolated } from '../../src/project/parse.js'

const tokens = (code: string, file = 'a.ts'): string[] => {
  const { sourceFile: sf } = parseIsolated(file, code)
  return codeTokens(sf, sf)
}
const same = (a: string, b: string, file = 'a.ts'): boolean => tokens(a, file).join(' ') === tokens(b, file).join(' ')

describe('the tokens of parsed code', () => {
  it.each([
    ['a line comment', 'const a = 1 // note\n', 'const a = 1\n'],
    ['a block comment', 'f(/* note */ a)', 'f(a)'],
    ['a doc comment', '/** note */\nconst a = 1', 'const a = 1'],
    ['a doc comment at the end of a file', 'const a = 1\n// x\n/** y */\n', 'const a = 1\n'],
    ['formatting', "f( 'a',b )", "f('a', b)"],
    ['a semicolon', 'const a = 1;', 'const a = 1'],
    ['a trailing comma in a call', 'f(a,)', 'f(a)'],
    ['a trailing comma in an object', 'const a = { b: 1, }', 'const a = { b: 1 }'],
  ])('%s does not count', (_name, a, b) => {
    expect(same(a, b)).toBe(true)
  })

  it.each([
    ['// in a template tail', 'const a = `${b}//c`', 'const a = `${b}//d`'],
    ['/* in a template tail', 'const a = `${b}/*c*/`', 'const a = `${b}/*d*/`'],
    ['// in a regular expression', 'const a = /b\\/\\/c/', 'const a = /b\\/\\/d/'],
    ['// in a string', "const a = '//b'", "const a = '//c'"],
    ['spaces in a string', "const a = 'b c'", "const a = 'b  c'"],
    ['a line break in a template', 'const a = `b c`', 'const a = `b\nc`'],
    ['commas in a string', "const a = 'b,,c'", "const a = 'b,c'"],
    ['a line break after return', 'function f() {\n  return\n  1\n}', 'function f() {\n  return 1\n}'],
    ['a line break before ++', 'a\n++b', 'a++\nb'],
    ['a hole in an array', 'const a = [b,,c]', 'const a = [b,c]'],
    ['code the parser skips', ') ) const a = 1', ') ) ) const a = 1'],
  ])('%s counts', (_name, a, b) => {
    expect(same(a, b)).toBe(false)
  })

  it('// in JSX text counts', () => {
    expect(same('const a = <p>// b</p>', 'const a = <p>// c</p>', 'a.tsx')).toBe(false)
  })
})

describe('declaration hashes', () => {
  const hash = (code: string): string => baseDecls('a.tsx', code).map((d) => d.hash).join()

  it.each([
    ['// in a template tail', 'export const u = (x: string) => `${x}// v1`', 'export const u = (x: string) => `${x}// v2`'],
    ['// in JSX text', 'export const u = () => <p>// v1</p>', 'export const u = () => <p>// v2</p>'],
    ['a URL in JSX text', 'export const u = () => <p>https://old.example</p>', 'export const u = () => <p>https://new.example</p>'],
  ])('an edit after %s changes the hash', (_name, a, b) => {
    expect(hash(a)).not.toBe(hash(b))
  })

  it('a comment does not change the hash', () => {
    expect(hash('export const u = 1 // a')).toBe(hash('export const u = 1 // b'))
  })
})
