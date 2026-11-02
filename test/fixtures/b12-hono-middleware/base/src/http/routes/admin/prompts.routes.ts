import { Hono } from 'hono'
import { bodyLimitGuard } from '../../middleware/body-limit'

export function createPromptRoutes(): Hono {
  const routes = new Hono()
  routes.get('/', (c) => c.json([]))
  routes.get('/:key', (c) => c.json({ key: c.req.param('key') }))
  routes.post('/', bodyLimitGuard(1024), async (c) => c.json(await c.req.json(), 201))
  return routes
}
