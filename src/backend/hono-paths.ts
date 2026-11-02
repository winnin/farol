/** `mergePath` of hono 4.13.13 (`dist/utils/url.js`) for two paths. */
export function mergePath(base: string, sub: string): string {
  return `${base.startsWith('/') ? '' : '/'}${base}${sub === '/' ? '' : `${base.endsWith('/') ? '' : '/'}${sub.startsWith('/') ? sub.slice(1) : sub}`}`
}

/** `METHOD path` under a base path. */
export function prefixKey(key: string, base: string): string {
  const space = key.indexOf(' ')
  return `${key.slice(0, space)} ${mergePath(base, key.slice(space + 1))}`
}

/** The path of a `METHOD path` key. */
export const keyPath = (key: string): string => key.slice(key.indexOf(' ') + 1)

/** Path segments; a `{…}` pattern stays in one segment even when it contains `/`. */
function segments(path: string): string[] {
  const out: string[] = []
  let current = ''
  let depth = 0
  for (const ch of path) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (ch === '/' && depth === 0) {
      if (current !== '') out.push(current)
      current = ''
    } else current += ch
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * Whether one request can reach both an endpoint path and a mount's full path: `:param` and `*` segments match any
 * segment, a regular-expression parameter (`:path{.+}`) or a final `*` matches the rest of the path, and an optional
 * parameter (`:name?`) also matches nothing.
 */
export function overlaps(path: string, base: string): boolean {
  const own = segments(path)
  const any = (s: string): boolean => s.includes(':') || s.includes('*')
  for (const [i, seg] of segments(base).entries()) {
    const o = own[i]
    if (o === undefined) return seg.startsWith(':') && seg.endsWith('?')
    if (o.includes('{') || seg.includes('{') || (o === '*' && i === own.length - 1)) return true
    if (o !== seg && !any(o) && !any(seg)) return false
  }
  return true
}

/** Whether a registration on a full path runs for an endpoint path: `/x/*` also covers `/x`, as in Hono. */
export function underPath(path: string, full: string): boolean {
  return overlaps(path, full.endsWith('/*') ? full.slice(0, -2) : full)
}
