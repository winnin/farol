import { Hono } from 'hono'
import { installAdminErrorHandler } from '../errors/admin-errors'
import { createAdminAuth } from '../middleware/admin-auth'
import { createPromptRoutes } from './admin/prompts.routes'

export function createAdminRoutes(): Hono {
  const routes = new Hono()
  installAdminErrorHandler(routes)
  routes.use('*', createAdminAuth())
  routes.get('/whoami', (c) => c.json({ name: 'operator' }))
  routes.route('/prompts', createPromptRoutes())
  return routes
}
