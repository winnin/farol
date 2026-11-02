import type { Hono } from 'hono'
import { spaPage } from '../lib/spa-page'
import { secureGuard } from '../middleware/secure-guard'
import { serveFiles } from '../middleware/serve-files'
import { createAdminRoutes } from './admin.routes'
import { createHealthRoutes } from './health.routes'
import { createPublicRoutes } from './public.routes'

export function registerRoutes(app: Hono): void {
  app.use('/files/*', serveFiles())
  app.route('/', createHealthRoutes())
  app.route('/admin/api', createAdminRoutes())
  app.route('/public', createPublicRoutes())
  app.get('/files', (c) => c.text('list'))
  app.get('/files/:name', (c) => c.text('file'))
  app.all('/secure/*', secureGuard)
  app.get('/secure/report', (c) => c.text('report'))
  app.get('/admin/*', async (c, next) => {
    await next()
    return spaPage(c)
  })
}
