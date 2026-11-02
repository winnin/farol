import { expoRouterAdapter } from './expo-router/index.js'
import { nextAdapter } from './next/index.js'
import { reactRouterAdapter } from './react-router/index.js'
import { tanstackRouterAdapter } from './tanstack-router/index.js'
import type { RouteAdapter } from './types.js'

export type * from './types.js'

export const ROUTE_ADAPTERS = ['react-router', 'next', 'tanstack-router', 'expo-router'] as const
export type RouteAdapterName = (typeof ROUTE_ADAPTERS)[number]

const ADAPTERS: Record<RouteAdapterName, RouteAdapter> = { 'react-router': reactRouterAdapter, next: nextAdapter, 'tanstack-router': tanstackRouterAdapter, 'expo-router': expoRouterAdapter }

export function getRouteAdapter(name: string): RouteAdapter {
  const adapter = (ADAPTERS as Record<string, RouteAdapter | undefined>)[name]
  if (!adapter) throw new Error(`unknown route adapter "${name}"`)
  return adapter
}
