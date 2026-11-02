import { Hono } from 'hono'

export function createHealthRoutes(): Hono {
  const routes = new Hono()
  routes.get('/healthz', (c) => c.json({ status: 'ok' }))
  return routes
}
