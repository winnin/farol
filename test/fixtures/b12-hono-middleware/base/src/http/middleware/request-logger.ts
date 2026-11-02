import type { MiddlewareHandler } from 'hono'

export function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    console.log('request', c.req.path)
    await next()
  }
}
