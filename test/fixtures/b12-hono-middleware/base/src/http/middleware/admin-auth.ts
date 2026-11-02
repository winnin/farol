import type { MiddlewareHandler } from 'hono'

export function createAdminAuth(_opts?: { strict: boolean }): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header('x-admin') === undefined) return c.text('denied', 401)
    await next()
  }
}
