import type { MiddlewareHandler } from 'hono'

export function bodyLimitGuard(max: number): MiddlewareHandler {
  return async (c, next) => {
    if (Number(c.req.header('content-length') ?? 0) > max) return c.text('too large', 413)
    await next()
  }
}
