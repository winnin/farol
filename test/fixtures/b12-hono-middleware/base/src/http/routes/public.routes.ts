import { Hono } from 'hono'
import { wrap } from '../lib/wrap'

export function createPublicRoutes(): Hono {
  const routes = new Hono()
  routes.get('/items', (c) => c.text(wrap('none')))
  return routes
}
