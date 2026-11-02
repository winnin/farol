import { describe, expect, it } from 'vitest'
import { baseDecls } from '../../src/project/decls.js'
import { codeTokens, parseIsolated } from '../../src/project/parse.js'

const tokens = (code: string, file = 'a.ts'): string[] => {
  const { sourceFile: sf } = parseIsolated(file, code)
  return codeTokens(sf, sf)
}
const same = (a: string, b: string, file = 'a.ts'): boolean => tokens(a, file).join(' ') === tokens(b, file).join(' ')

describe('tokens that change what code does', () => {
  it.each([
    ['a hole at the end of an array', 'const a = [1,,]', 'const a = [1,]'],
    ['an empty body of an if', 'if (a) ;\nb()', 'if (a) b()'],
    ['the parts of a for loop', 'for (a;;b) c()', 'for (a;b;) c()'],
  ])('%s counts', (_name, a, b) => {
    expect(same(a, b)).toBe(false)
  })
})

describe('JSX text, as React reads it', () => {
  it.each([
    ['a space before text', '<p>{a} items</p>', '<p>{a}items</p>'],
    ['a space between expressions', '<p>{a} {b}</p>', '<p>{a}{b}</p>'],
    ['a space after text', '<p>items {a}</p>', '<p>items{a}</p>'],
    ['spaces inside a line', '<p>a  b</p>', '<p>a b</p>'],
  ])('%s is a change', (_name, a, b) => {
    expect(same(`const x = ${a}`, `const x = ${b}`, 'a.tsx')).toBe(false)
  })

  it.each([
    ['a line break around text', '<p>\n  items\n</p>', '<p>items</p>'],
    ['indent between lines', '<p>\n  a\n      b\n</p>', '<p>\n  a\n  b\n</p>'],
    ['lines React joins with a space', '<p>\n  a\n  b\n</p>', '<p>a b</p>'],
    ['a line break between tags', '<div>\n  <b />\n</div>', '<div><b /></div>'],
  ])('%s is formatting', (_name, a, b) => {
    expect(same(`const x = ${a}`, `const x = ${b}`, 'a.tsx')).toBe(true)
  })
})

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
    ['a trailing comma in an array', 'const a = [1, 2,]', 'const a = [1, 2]'],
    ['an empty statement', 'f();;\ng()', 'f();\ng()'],
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
