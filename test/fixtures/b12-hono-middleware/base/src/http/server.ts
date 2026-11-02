import { Hono } from 'hono'
import { createErrorHandler } from './middleware/error-handler'
import { requestLogger } from './middleware/request-logger'

export function createHttpApp(): Hono {
  const app = new Hono()
  app.use('*', requestLogger())
  app.onError(createErrorHandler())
  return app
}
