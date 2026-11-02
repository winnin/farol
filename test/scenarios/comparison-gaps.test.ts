import { afterAll, describe, expect, it } from 'vitest'
import type { Output } from '../../src/output/schema.js'
import { analyzeVariant, edit, type Change } from '../helpers/variant.js'

const cleanups: (() => void)[] = []
afterAll(() => {
  for (const c of cleanups) c()
})

const PUBLIC = 'src/http/routes/public.routes.ts'
const INDEX = 'src/http/routes/index.ts'
const ITEMS = "routes.get('/items', (c) => c.text(wrap('none')))"
const USE = "routes.use('*', requestLogger())"

const hono = (change: Change, setup?: Change): Promise<Output> => analyzeVariant('b12-hono-middleware', cleanups, change, setup)

/** The public routes file with `body` as its code: `routes` is a top-level app. */
const publicFile = (body: string): Change => (repo) => {
  repo.write(PUBLIC, `import { Hono } from 'hono'
import { wrap } from '../lib/wrap'
import { requestLogger } from '../middleware/request-logger'
const routes = new Hono()
function log() { return 1 }
function withApp(fn: (r: Hono) => void) { fn(routes) }
${body}
export function createPublicRoutes(): Hono { return routes }
`)
}

/** Two factories in one file, mounted at `/public` and `/other`. */
const twoFactories = (first: string, second: string): Change => (repo) => {
  repo.write(PUBLIC, `import { Hono } from 'hono'
const sub = new Hono()
sub.get('/s', (c) => c.text('s'))
export function createPublicRoutes(): Hono {
  const routes = new Hono()
${first}
  return routes
}
export function createOtherRoutes(): Hono {
  const routes = new Hono()
${second}
  return routes
}
`)
}
const mountBoth: Change = (repo) => {
  edit(repo, INDEX, "import { createPublicRoutes } from './public.routes'", "import { createOtherRoutes, createPublicRoutes } from './public.routes'")
  edit(repo, INDEX, "  app.route('/public', createPublicRoutes())\n", "  app.route('/public', createPublicRoutes())\n  app.route('/other', createOtherRoutes())\n")
}
const EXTRA = "  routes.get('/extra', (c) => c.text('extra'))"
const OTHER = "  routes.get('/other', (c) => c.text('other'))"
const ONE = "  routes.get('/one', (c) => c.text('one'))"
const MOUNT = "  routes.route('/sub', sub)"

describe('where a call runs', () => {
  it.each<[string, string, string, string, string]>([
    ['a handler moved to the next function', `${ONE}\n${EXTRA}`, OTHER, ONE, `${EXTRA}\n${OTHER}`],
    ['a mount moved to the next function', `${ONE}\n${MOUNT}`, OTHER, ONE, `${MOUNT}\n${OTHER}`],
  ])('%s is a change', async (_name, first, second, nextFirst, nextSecond) => {
    const o = await hono(twoFactories(nextFirst, nextSecond), (repo) => { twoFactories(first, second)(repo); mountBoth(repo) })
    expect(o.classification).toBe('touches-existing')
  })

  it.each([
    ['from an if block to its else block', `if (log()) {\n  ${ITEMS}\n} else {\n}`, `if (log()) {\n} else {\n  ${ITEMS}\n}`],
    ['between branches with no block', `if (log()) ${ITEMS}\nelse log()`, `if (log()) log()\nelse ${ITEMS}`],
    ['into a loop', `for (const i of [1]) log()\n${ITEMS}`, `for (const i of [1]) ${ITEMS}\nlog()`],
  ])('a handler moved %s is a change', async (_name, before, after) => {
    const o = await hono(publicFile(after), publicFile(before))
    expect(o.classification).toBe('touches-existing')
  })

  it('a reorder inside a function passed to another function is a change', async () => {
    const body = (a: string, b: string): string => `withApp((routes: Hono) => {\n  log()\n  ${a}\n  ${b}\n})`
    const o = await hono(publicFile(body(USE, ITEMS)), publicFile(body(ITEMS, USE)))
    expect(o.classification).toBe('touches-existing')
  })

  it('a new handler in the first of two functions stays additive', async () => {
    const o = await hono(twoFactories(`${ONE}\n${EXTRA}`, OTHER), (repo) => { twoFactories(ONE, OTHER)(repo); mountBoth(repo) })
    expect(o.classification).toBe('isolated')
  })

  it('a new top-level handler above others stays additive', async () => {
    const o = await hono(publicFile(`routes.get('/new', (c) => c.text('new'))\n${ITEMS}`), publicFile(ITEMS))
    expect(o.classification).toBe('isolated')
  })

  it('a new function with the same inner call as an existing one stays additive', async () => {
    const helper = "export function one() { return wrap('x') }"
    const o = await hono(publicFile(`${helper}\nexport function two() { return wrap('x') }\n${ITEMS}`), publicFile(`${helper}\n${ITEMS}`))
    expect(o.classification).toBe('isolated')
  })
})

describe('new top-level code', () => {
  it.each([
    ['a copy of use() above a handler', `${ITEMS}\n${USE}`, `${USE}\n${ITEMS}\n${USE}`],
    ['a copy of use() next to it', `${USE}\n${ITEMS}`, `${USE}\n${USE}\n${ITEMS}`],
    ['a throw that can stop the load', ITEMS, `${ITEMS}\nif (!wrap) throw 'boom'`],
  ])('%s is a change', async (_name, before, after) => {
    const o = await hono(publicFile(after), publicFile(before))
    expect(o.classification).toBe('touches-existing')
  })
})

describe('code in schema templates', () => {
  it('a changed interpolation of a gql template is a change', async () => {
    const o = await analyzeVariant('b7-rest', cleanups, (r) => { edit(r, 'src/schema/user.ts', 'sdlPart(1)', 'sdlPart(2)') }, (r) => {
      edit(r, 'src/schema/user.ts', 'export const userTypeDefs = gql`', "const sdlPart = (n: number) => 'type X' + n + ' { a: Int }'\nexport const userTypeDefs = gql`\n  ${sdlPart(1)}")
    })
    expect(o.classification).toBe('touches-existing')
  })

  it('a new field beside an interpolation stays additive', async () => {
    const o = await analyzeVariant('b7-rest', cleanups, (r) => { edit(r, 'src/schema/user.ts', 'type User {', 'type User {\n    extraField: String') }, (r) => {
      edit(r, 'src/schema/user.ts', 'export const userTypeDefs = gql`', "const part = 'type X { a: Int }'\nexport const userTypeDefs = gql`\n  ${part}")
    })
    expect(o.classification).not.toBe('touches-existing')
  })
})

describe('Express and Fastify files', () => {
  const SERVER = 'src/rest/server.ts'
  const load: Change = (r) => { edit(r, 'src/resolvers/user.ts', "import { maskEmail } from '../lib/format'", "import { maskEmail } from '../lib/format'\nimport '../rest/server'") }
  const express = (body: string): string => `import express from 'express'\nimport { auth } from '../lib/format'\nexport const app = express()\n${body}\n`
  const fastify = (body: string): string => `import { auth } from '../lib/format'\nimport Fastify from 'fastify'\nexport const app = Fastify()\n${body}\n`
  const GET = "app.get('/a', async (req, res) => res.send('a'))"
  const rest = (before: string, after: string): Promise<Output> => analyzeVariant('b7-rest', cleanups, (r) => { r.write(SERVER, after) }, (r) => { r.write(SERVER, before); load(r) })

  it.each([
    ['swapping use() and a handler', express(`app.use(auth)\n${GET}`), express(`${GET}\napp.use(auth)`)],
    ['swapping register() and a handler', fastify(`app.register(auth)\n${GET}`), fastify(`${GET}\napp.register(auth)`)],
    ['a new property of an options object', express(`const opts = { a: 1 }\napp.use(auth(opts))\n${GET}`), express(`const opts = { a: 1, b: 2 }\napp.use(auth(opts))\n${GET}`)],
  ])('%s is a change', async (_name, before, after) => {
    expect((await rest(before, after)).classification).toBe('touches-existing')
  })

  it('a new handler stays additive', async () => {
    const o = await rest(express(`app.use(auth)\n${GET}`), express(`app.use(auth)\n${GET}\napp.get('/b', async () => 'b')`))
    expect(o.classification).toBe('isolated')
  })
})

describe('routes files', () => {
  const TITLE = "export const TITLE = 'a  b'\nexport const router"
  it.each([
    ['spaces in a string', "'a b'"],
    ['a changed string', "'a c'"],
  ])('%s is a change', async (_name, to) => {
    const o = await analyzeVariant('01-new-route', cleanups, (r) => { edit(r, 'src/routes.tsx', "'a  b'", to) }, (r) => { edit(r, 'src/routes.tsx', 'export const router', TITLE) })
    expect(o.classification).toBe('touches-existing')
  })

  it('formatting and a new export stay additive', async () => {
    const o = await analyzeVariant('01-new-route', cleanups, (r) => { edit(r, 'src/routes.tsx', "export const TITLE = 'a  b'", "export const TITLE   =   'a  b'\nexport const OTHER = 1") }, (r) => { edit(r, 'src/routes.tsx', 'export const router', TITLE) })
    expect(o.classification).toBe('isolated')
  })
})
