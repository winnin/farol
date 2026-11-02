import type { Context } from 'hono'

export function spaPage(c: Context): Response {
  return c.text('spa')
}
