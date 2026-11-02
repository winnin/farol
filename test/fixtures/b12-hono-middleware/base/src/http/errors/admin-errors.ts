import type { Hono } from 'hono'
import { formatError } from './format-error'

export const ERROR_PREFIX = 'err:'

export function installAdminErrorHandler(app: Hono): void {
  app.onError((err, c) => c.json({ error: formatError(err), source: 'admin' }, 500))
}
