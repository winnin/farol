import type { Context, Next } from 'hono'

export async function secureGuard(c: Context, next: Next): Promise<Response | void> {
  if (c.req.header('x-key') === undefined) return c.text('locked', 401)
  await next()
}
