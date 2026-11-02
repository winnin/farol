import type { Context } from 'hono'

export function createErrorHandler(): (err: Error, c: Context) => Response {
  return (err, c) => c.json({ error: err.message, source: 'root' }, 500)
}
