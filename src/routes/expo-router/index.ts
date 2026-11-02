import { posix } from 'node:path'
import { compareStrings } from '../../output/order.js'
import type { DynamicRoute, RouteAdapter, RouteAdapterInput, RouteEntry, RouteTable } from '../types.js'
import { routeModulePath, routeTable, urlPath } from '../files.js'

const PLATFORMS = new Set(['ios', 'android', 'native', 'web'])
/** Root modules around every screen: server middleware, the deep-link rewriter, the web document. */
const ROOT_MODULES = ['+middleware', '+native-intent', '+html']
/** API routes only run behind the server middleware. */
const API_ROOT_MODULES = ['+middleware']
const API_SUFFIX = '+api'

function has(files: readonly string[], dir: string): boolean {
  return files.some((f) => f.startsWith(`${dir}/`))
}

/**
 * The routes directory. A project (it holds `package.json`) is never one: its `app/` or `src/app/` is. Another directory
 * is the routes directory when it is named `app` or has a root `_layout` (a custom `root`); otherwise its `app/` or
 * `src/app/`. Null when there is none.
 */
function routesDir(input: RouteAdapterInput): string | null {
  const at = (d: string): string => (input.file === '' ? d : `${input.file}/${d}`)
  const isRootLayout = (f: string): boolean => splitPlatform(routeModulePath(input.file, f) ?? '').stem === '_layout'
  const project = input.files.includes(at('package.json'))
  if (!project && (posix.basename(input.file) === 'app' || input.files.some(isRootLayout))) return input.file
  return [at('app'), at('src/app')].find((d) => has(input.files, d)) ?? null
}

/** `about.web` → `about` on `web`: a platform-specific module belongs to the route of its universal module (platform ''). */
function splitPlatform(name: string): { stem: string; platform: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 && PLATFORMS.has(name.slice(dot + 1)) ? { stem: name.slice(0, dot), platform: name.slice(dot + 1) } : { stem: name, platform: '' }
}

function isGroup(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')')
}

/** `[id]` → `:id`, `[...rest]` → `*`; groups `(g)` and `(a,b)` are not part of the URL. */
function urlSegment(segment: string): string {
  if (isGroup(segment)) return ''
  if (segment.startsWith('[...')) return '*'
  if (segment.startsWith('[') && segment.endsWith(']')) return `:${segment.slice(1, -1)}`
  return segment
}

/** The modules of one route, layout or root module, by platform ('' for the universal module). */
type Variants = Map<string, string>

interface Found {
  folder: string[]
  /** Last URL segment (`index` for the folder's own path, `+not-found` for anything unmatched). */
  name: string
  api: boolean
  variants: Variants
}

/** Modules of `variants`: the universal one first, then the platform ones sorted. */
function modulesOf(variants: Variants | undefined): string[] {
  if (variants === undefined) return []
  const universal = variants.get('')
  const platforms = [...variants].filter(([p]) => p !== '').map(([, f]) => f).sort(compareStrings)
  return universal === undefined ? platforms : [universal, ...platforms]
}

/**
 * Expo Router: every module under the routes directory is a screen (`index` is its folder's path), `name+api` an API
 * route at `name`, `+not-found` the screen for unmatched URLs below its folder. The `_layout` of every folder above a
 * screen renders it; `+middleware`, `+native-intent` and `+html` at the root run before every screen. Platform modules
 * (`about.ios.tsx`) are part of the route of `about.tsx`.
 */
function extract(input: RouteAdapterInput): RouteTable {
  const dir = routesDir(input)
  if (dir === null) return routeTable([], [{ file: input.file === '' ? '.' : input.file, line: 1, detail: `no Expo Router routes directory found: expected app/ or src/app/ in ${input.file === '' ? 'the project' : input.file}, or set routes.dir to it` }], [])
  const dynamic: DynamicRoute[] = []
  const layoutsIn = new Map<string, Variants>()
  const root = new Map<string, Variants>()
  const found = new Map<string, Found>()
  // Expo Router refuses two modules of one name on the same platform (`index.ts` and `index.tsx`).
  const add = (variants: Variants, platform: string, file: string, name: string): void => {
    const prev = variants.get(platform)
    if (prev === undefined) variants.set(platform, file)
    else dynamic.push({ file, line: 1, detail: `${name} is defined twice: ${prev} and ${file}` })
  }
  const variantsOf = (map: Map<string, Variants>, key: string): Variants => {
    const variants = map.get(key) ?? new Map<string, string>()
    map.set(key, variants)
    return variants
  }
  for (const file of input.files) {
    const rel = routeModulePath(dir, file)
    if (rel === null) continue
    const folder = rel.split('/')
    const { stem, platform } = splitPlatform(folder.pop() ?? '')
    const api = stem.endsWith(API_SUFFIX)
    if (stem === '_layout') add(variantsOf(layoutsIn, folder.join('/')), platform, file, `layout /${folder.join('/')}`)
    else if (folder.length === 0 && platform === '' && ROOT_MODULES.includes(stem)) add(variantsOf(root, stem), platform, file, stem)
    else if (api && platform !== '') dynamic.push({ file, line: 1, detail: 'Expo Router API routes cannot have platform extensions' })
    else if ((stem.startsWith('+') && stem !== '+not-found' && !api) || isGroup(stem)) dynamic.push({ file, line: 1, detail: `${stem} is not an Expo Router route name` })
    else {
      // Expo Router's own route key: the folder path with groups and `index`, so groups that share a URL stay apart.
      const key = `/${[...folder, stem].join('/')}`
      const route = found.get(key) ?? { folder, name: api ? stem.slice(0, -API_SUFFIX.length) : stem, api, variants: new Map<string, string>() }
      found.set(key, route)
      add(route.variants, platform, file, `route ${key}`)
    }
  }
  // Expo Router refuses a platform module without the universal one next to it.
  const needsFallback = (variants: Variants): void => {
    if (!variants.has('')) for (const f of modulesOf(variants)) dynamic.push({ file: f, line: 1, detail: `${posix.basename(f)} has no module without a platform extension next to it` })
  }
  for (const variants of layoutsIn.values()) needsFallback(variants)
  const rootModules = (names: readonly string[]): string[] => names.flatMap((n) => modulesOf(root.get(n)))
  const routes: RouteEntry[] = []
  for (const [key, r] of found) {
    needsFallback(r.variants)
    const layouts = rootModules(r.api ? API_ROOT_MODULES : ROOT_MODULES)
    if (!r.api) for (let i = 0; i <= r.folder.length; i++) layouts.push(...modulesOf(layoutsIn.get(r.folder.slice(0, i).join('/'))))
    const modules = modulesOf(r.variants)
    const index = r.name === 'index'
    const last = r.name === '+not-found' ? ['*'] : index ? [] : [r.name]
    routes.push({ key, path: urlPath([...r.folder, ...last].map(urlSegment)), index, entry: modules[0] ?? null, modules: [...modules].sort(compareStrings), layouts })
  }
  if (routes.length === 0) dynamic.push({ file: dir === '' ? '.' : dir, line: 1, detail: `no Expo Router route found: expected route modules under ${dir === '' ? 'the project' : dir}` })
  return routeTable(routes, dynamic, routes.flatMap((r) => [...r.modules, ...r.layouts]))
}

export const expoRouterAdapter: RouteAdapter = { name: 'expo-router', source: 'directory', extract }
