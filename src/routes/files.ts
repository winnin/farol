import { posix } from 'node:path'
import { compareStrings } from '../output/order.js'
import type { DynamicRoute, RouteEntry, RouteTable } from './types.js'

/** Extensions of route modules in file-system routers (Next.js `pageExtensions` default, TanStack Router, Expo Router). */
export const ROUTE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js']

/** Tests, stories, mocks and declaration files never define routes, even inside a routes directory. */
export function isNonRouteFile(file: string): boolean {
  const name = posix.basename(file)
  if (name.endsWith('.d.ts') || /\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(name)) return true
  return file.split('/').some((part) => part === '__tests__' || part === '__mocks__')
}

/** `dir/a/b.tsx` → `a/b` when the file is a route module under `dir` (repo-relative, '' for the root); null otherwise. */
export function routeModulePath(dir: string, file: string): string | null {
  const prefix = dir === '' ? '' : `${dir}/`
  if (!file.startsWith(prefix) || isNonRouteFile(file)) return null
  const ext = ROUTE_EXTENSIONS.find((e) => file.endsWith(e))
  if (ext === undefined) return null
  return file.slice(prefix.length, -ext.length)
}

/** `/a//b/` → `/a/b`, `` → `/`. */
export function urlPath(segments: readonly string[]): string {
  return `/${segments.filter((s) => s !== '').join('/')}`
}

/** Builds the table: routes sorted by key, one dynamic entry per key defined twice (the router would refuse it). */
export function routeTable(routes: RouteEntry[], dynamic: DynamicRoute[], sources: Iterable<string>): RouteTable {
  const byKey = new Map<string, RouteEntry>()
  for (const r of routes) {
    const prev = byKey.get(r.key)
    if (prev === undefined) byKey.set(r.key, r)
    else dynamic.push({ file: r.entry ?? prev.entry ?? '', line: 1, detail: `route ${r.path} is defined twice: ${prev.entry ?? '?'} and ${r.entry ?? '?'}` })
  }
  return {
    routes: [...byKey.values()].sort((a, b) => compareStrings(a.key, b.key) || compareStrings(a.path, b.path)),
    dynamic: dynamic.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.detail, b.detail)),
    sources: [...new Set(sources)].sort(compareStrings),
  }
}
