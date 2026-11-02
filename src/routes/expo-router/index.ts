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
 * The routes directory: the configured one when it is named `app` or has a root `_layout`, else its `app/` or `src/app/`
 * when they hold files; null when none does (the project itself is never read as routes).
 */
function routesDir(input: RouteAdapterInput): string | null {
  const at = (d: string): string => (input.file === '' ? d : `${input.file}/${d}`)
  const isRootLayout = (f: string): boolean => splitPlatform(routeModulePath(input.file, f) ?? '').stem === '_layout'
  if (posix.basename(input.file) === 'app' || input.files.some(isRootLayout)) return input.file
  return [at('app'), at('src/app')].find((d) => has(input.files, d)) ?? null
}

/** `about.web` → `about`: a platform-specific module belongs to the route of its universal module. */
function splitPlatform(name: string): { stem: string; platform: boolean } {
  const dot = name.lastIndexOf('.')
  return dot > 0 && PLATFORMS.has(name.slice(dot + 1)) ? { stem: name.slice(0, dot), platform: true } : { stem: name, platform: false }
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

interface Found {
  folder: string[]
  /** Last URL segment (`index` for the folder's own path, `+not-found` for anything unmatched). */
  name: string
  api: boolean
  files: string[]
  /** The module without a platform extension, which Expo Router requires next to platform modules. */
  universal: string | null
}

function push(map: Map<string, string[]>, key: string, file: string): void {
  map.set(key, [...(map.get(key) ?? []), file])
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
  const layoutsIn = new Map<string, string[]>()
  const root = new Map<string, string[]>()
  const found = new Map<string, Found>()
  for (const file of input.files) {
    const rel = routeModulePath(dir, file)
    if (rel === null) continue
    const folder = rel.split('/')
    const { stem, platform } = splitPlatform(folder.pop() ?? '')
    const api = stem.endsWith(API_SUFFIX)
    if (stem === '_layout') push(layoutsIn, folder.join('/'), file)
    else if (folder.length === 0 && ROOT_MODULES.includes(stem)) push(root, stem, file)
    else if (api && platform) dynamic.push({ file, line: 1, detail: 'Expo Router API routes cannot have platform extensions' })
    else if ((stem.startsWith('+') && stem !== '+not-found' && !api) || isGroup(stem)) dynamic.push({ file, line: 1, detail: `${stem} is not an Expo Router route name` })
    else {
      // Expo Router's own route key: the folder path with groups and `index`, so groups that share a URL stay apart.
      const key = `/${[...folder, stem].join('/')}`
      const route = found.get(key) ?? { folder, name: api ? stem.slice(0, -API_SUFFIX.length) : stem, api, files: [], universal: null }
      if (!platform && route.universal !== null) dynamic.push({ file, line: 1, detail: `route ${key} is defined twice: ${route.universal} and ${file}` })
      if (!platform) route.universal ??= file
      route.files.push(file)
      found.set(key, route)
    }
  }
  const rootModules = (names: readonly string[]): string[] => names.flatMap((n) => [...(root.get(n) ?? [])].sort(compareStrings))
  const routes: RouteEntry[] = []
  for (const [key, r] of found) {
    const layouts = rootModules(r.api ? API_ROOT_MODULES : ROOT_MODULES)
    if (!r.api) for (let i = 0; i <= r.folder.length; i++) layouts.push(...[...(layoutsIn.get(r.folder.slice(0, i).join('/')) ?? [])].sort(compareStrings))
    const modules = [...r.files].sort(compareStrings)
    const index = r.name === 'index'
    const last = r.name === '+not-found' ? ['*'] : index ? [] : [r.name]
    routes.push({ key, path: urlPath([...r.folder, ...last].map(urlSegment)), index, entry: r.universal ?? modules[0] ?? null, modules, layouts })
  }
  if (routes.length === 0) dynamic.push({ file: dir === '' ? '.' : dir, line: 1, detail: `no Expo Router route found: expected route modules under ${dir === '' ? 'the project' : dir}` })
  return routeTable(routes, dynamic, routes.flatMap((r) => [...r.modules, ...r.layouts]))
}

export const expoRouterAdapter: RouteAdapter = { name: 'expo-router', source: 'directory', extract }
