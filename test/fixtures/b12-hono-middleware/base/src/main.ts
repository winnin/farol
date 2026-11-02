import { createHttpApp } from './http/server'
import { registerRoutes } from './http/routes'

const app = createHttpApp()
registerRoutes(app)
