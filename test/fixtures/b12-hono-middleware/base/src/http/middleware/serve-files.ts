import type { MiddlewareHandler } from 'hono'

export function serveFiles(): MiddlewareHandler {
  return async (c, next) => {
    c.header('x-files', 'on')
    await next()
  }
}
