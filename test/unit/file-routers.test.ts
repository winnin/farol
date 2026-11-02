import { describe, expect, it } from 'vitest'
import { expoRouterAdapter } from '../../src/routes/expo-router/index.js'
import { nextAdapter } from '../../src/routes/next/index.js'
import { tanstackRouterAdapter } from '../../src/routes/tanstack-router/index.js'
import type { RouteAdapter, RouteTable } from '../../src/routes/types.js'

function extract(adapter: RouteAdapter, dir: string, modules: Record<string, string>): RouteTable {
  return adapter.extract({ file: dir, code: '', files: Object.keys(modules).sort(), resolve: () => ({ kind: 'unresolved' }), read: (f) => modules[f] })
}

const rows = (t: RouteTable): string[][] => t.routes.map((r) => [r.key, r.path, r.entry ?? '-', r.layouts.join(',')])

describe('next adapter', () => {
  it('reads the Pages Router: index, dynamic and catch-all segments, _app/_document as layouts, API routes', () => {
    const t = extract(nextAdapter, 'web', {
      'web/pages/_app.tsx': '',
      'web/pages/_document.tsx': '',
      'web/pages/index.tsx': '',
      'web/pages/org/[slug]/index.tsx': '',
      'web/pages/docs/[...path].tsx': '',
      'web/pages/api/health.ts': '',
      'web/pages/org/[slug]/Card.test.tsx': '',
      'web/pages/styles.css': '',
      'web/middleware.ts': '',
    })
    expect(rows(t)).toEqual([
      ['/', '/', 'web/pages/index.tsx', 'web/middleware.ts,web/pages/_document.tsx,web/pages/_app.tsx'],
      ['/api/health', '/api/health', 'web/pages/api/health.ts', 'web/middleware.ts'],
      ['/docs/*', '/docs/*', 'web/pages/docs/[...path].tsx', 'web/middleware.ts,web/pages/_document.tsx,web/pages/_app.tsx'],
      ['/org/:slug', '/org/:slug', 'web/pages/org/[slug]/index.tsx', 'web/middleware.ts,web/pages/_document.tsx,web/pages/_app.tsx'],
    ])
    expect(t.dynamic).toEqual([])
    expect(t.sources).toContain('web/pages/_app.tsx')
  })

  it('reads the App Router: layouts and templates above, boundaries, groups, slots and private folders', () => {
    const t = extract(nextAdapter, '', {
      'src/app/layout.tsx': '',
      'src/app/page.tsx': '',
      'src/app/(shop)/layout.tsx': '',
      'src/app/(shop)/products/[id]/page.tsx': '',
      'src/app/(shop)/products/[id]/loading.tsx': '',
      'src/app/_lib/page.tsx': '',
      'src/app/api/orders/route.ts': '',
      'src/app/@modal/(.)photo/page.tsx': '',
    })
    expect(rows(t)).toEqual([
      ['/', '/', 'src/app/page.tsx', 'src/app/layout.tsx'],
      ['/(shop)/products/[id]', '/products/:id', 'src/app/(shop)/products/[id]/page.tsx', 'src/app/layout.tsx,src/app/(shop)/layout.tsx'],
      ['/api/orders', '/api/orders', 'src/app/api/orders/route.ts', ''],
    ])
    expect(t.routes[1]?.modules).toEqual(['src/app/(shop)/products/[id]/loading.tsx', 'src/app/(shop)/products/[id]/page.tsx'])
  })

  it('reports a project with no route (fail closed) and a path defined twice', () => {
    expect(extract(nextAdapter, 'web', { 'web/src/a.ts': '' }).dynamic.map((d) => d.detail)).toEqual([expect.stringContaining('no Next.js route found')])
    const twice = extract(nextAdapter, '', { 'pages/about.tsx': '', 'pages/about/index.tsx': '' })
    expect(twice.dynamic.map((d) => d.detail)).toEqual(['route /about is defined twice: pages/about.tsx and pages/about/index.tsx'])
  })
})

const route = (id: string): string => `import { createFileRoute } from '@tanstack/react-router'\nexport const Route = createFileRoute('${id}')({ component: () => null })\n`

describe('tanstack-router adapter', () => {
  it('lists the leaf routes with their layouts: root, pathless and parent routes', () => {
    const t = extract(tanstackRouterAdapter, 'src/routes', {
      'src/routes/__root.tsx': "import { createRootRouteWithContext } from '@tanstack/react-router'\nexport const Route = createRootRouteWithContext<{ a: 1 }>()({})\n",
      'src/routes/index.tsx': route('/'),
      'src/routes/_app.tsx': route('/_app'),
      'src/routes/_app/org/$slug/webhooks/index.tsx': route('/_app/org/$slug/webhooks/'),
      'src/routes/posts.tsx': route('/posts'),
      'src/routes/posts/$postId.tsx': route('/posts/$postId'),
      'src/routes/posts/$postId.lazy.tsx': "import { createLazyFileRoute } from '@tanstack/react-router'\nexport const Route = createLazyFileRoute('/posts/$postId')({})\n",
      'src/routes/files/$.tsx': route('/files/$'),
      'src/routes/-components/Header.tsx': route('/ignored'),
      'src/routes/helpers.ts': 'export const x = 1\n',
    })
    expect(rows(t)).toEqual([
      ['/', '/', 'src/routes/index.tsx', 'src/routes/__root.tsx'],
      ['/_app/org/$slug/webhooks/', '/org/:slug/webhooks', 'src/routes/_app/org/$slug/webhooks/index.tsx', 'src/routes/__root.tsx,src/routes/_app.tsx'],
      ['/files/$', '/files/*', 'src/routes/files/$.tsx', 'src/routes/__root.tsx'],
      ['/posts/$postId', '/posts/:postId', 'src/routes/posts/$postId.lazy.tsx', 'src/routes/__root.tsx,src/routes/posts.tsx'],
    ])
    expect(t.routes[3]?.modules).toEqual(['src/routes/posts/$postId.lazy.tsx', 'src/routes/posts/$postId.tsx'])
    expect(t.dynamic).toEqual([])
  })

  it('reports route ids it cannot read and a directory without routes', () => {
    const t = extract(tanstackRouterAdapter, 'routes', { 'routes/a.tsx': "import { createFileRoute } from '@tanstack/react-router'\nconst id = '/a'\nexport const Route = createFileRoute(id)({})\n" })
    expect(t.dynamic.map((d) => [d.file, d.line, d.detail])).toEqual([
      ['routes', 1, expect.stringContaining('no TanStack Router route found')],
      ['routes/a.tsx', 3, 'createFileRoute without a literal route id'],
    ])
  })
})

describe('expo-router adapter', () => {
  it('lists screens with the layouts above them: index, groups, dynamic segments, platform modules', () => {
    const t = extract(expoRouterAdapter, '', {
      'src/app/_layout.tsx': '',
      'src/app/_layout.web.tsx': '',
      'src/app/index.tsx': '',
      'src/app/sign-in.tsx': '',
      'src/app/(tabs)/_layout.tsx': '',
      'src/app/(tabs)/index.tsx': '',
      'src/app/(tabs)/cards/[cardId].tsx': '',
      'src/app/(tabs)/cards/[cardId].ios.tsx': '',
      'src/app/(a,b)/docs/[...rest].tsx': '',
      'src/app/(tabs)/cards/Card.test.tsx': '',
      'src/app/styles.css': '',
      'src/components/Card.tsx': '',
    })
    expect(rows(t)).toEqual([
      ['/(a,b)/docs/[...rest]', '/docs/*', 'src/app/(a,b)/docs/[...rest].tsx', 'src/app/_layout.tsx,src/app/_layout.web.tsx'],
      ['/(tabs)/cards/[cardId]', '/cards/:cardId', 'src/app/(tabs)/cards/[cardId].tsx', 'src/app/_layout.tsx,src/app/_layout.web.tsx,src/app/(tabs)/_layout.tsx'],
      ['/(tabs)/index', '/', 'src/app/(tabs)/index.tsx', 'src/app/_layout.tsx,src/app/_layout.web.tsx,src/app/(tabs)/_layout.tsx'],
      ['/index', '/', 'src/app/index.tsx', 'src/app/_layout.tsx,src/app/_layout.web.tsx'],
      ['/sign-in', '/sign-in', 'src/app/sign-in.tsx', 'src/app/_layout.tsx,src/app/_layout.web.tsx'],
    ])
    expect(t.routes[1]?.modules).toEqual(['src/app/(tabs)/cards/[cardId].ios.tsx', 'src/app/(tabs)/cards/[cardId].tsx'])
    expect(t.dynamic).toEqual([])
  })

  it('reads API routes, +not-found and the root modules that run before every screen', () => {
    const t = extract(expoRouterAdapter, 'mobile', {
      'mobile/app/_layout.tsx': '',
      'mobile/app/+html.tsx': '',
      'mobile/app/+native-intent.ts': '',
      'mobile/app/+middleware.ts': '',
      'mobile/app/+not-found.tsx': '',
      'mobile/app/(protected)/+not-found.tsx': '',
      'mobile/app/api/encrypt+api.ts': '',
      'mobile/app/api/users/[id]+api.ts': '',
      'mobile/app/api/encrypt.tsx': '',
    })
    const all = 'mobile/app/+middleware.ts,mobile/app/+native-intent.ts,mobile/app/+html.tsx,mobile/app/_layout.tsx'
    expect(rows(t)).toEqual([
      ['/(protected)/+not-found', '/*', 'mobile/app/(protected)/+not-found.tsx', all],
      ['/+not-found', '/*', 'mobile/app/+not-found.tsx', all],
      ['/api/encrypt', '/api/encrypt', 'mobile/app/api/encrypt.tsx', all],
      ['/api/encrypt+api', '/api/encrypt', 'mobile/app/api/encrypt+api.ts', 'mobile/app/+middleware.ts'],
      ['/api/users/[id]+api', '/api/users/:id', 'mobile/app/api/users/[id]+api.ts', 'mobile/app/+middleware.ts'],
    ])
    expect(t.dynamic).toEqual([])
    expect(t.sources).toContain('mobile/app/+native-intent.ts')
  })

  it('takes a configured app directory, or one with a root _layout, as is; never the project', () => {
    const t = extract(expoRouterAdapter, 'src/app', { 'src/app/index.tsx': '', 'src/app/app/settings.tsx': '' })
    expect(t.routes.map((r) => r.path)).toEqual(['/app/settings', '/'])
    const custom = extract(expoRouterAdapter, 'screens', { 'screens/_layout.tsx': '', 'screens/home.tsx': '', 'screens/app/x.tsx': '' })
    expect(custom.routes.map((r) => r.key)).toEqual(['/app/x', '/home'])
    const project = extract(expoRouterAdapter, '', { 'package.json': '', '_layout.tsx': '', 'components/Card.tsx': '', 'app/index.tsx': '' })
    expect(project.routes.map((r) => r.entry)).toEqual(['app/index.tsx'])
  })

  it('reports what Expo Router refuses, and a project with no route (fail closed)', () => {
    const t = extract(expoRouterAdapter, 'app', {
      'app/_layout.ts': '',
      'app/_layout.tsx': '',
      'app/+html.ts': '',
      'app/+html.tsx': '',
      'app/+native-intent.ios.ts': '',
      'app/index.tsx': '',
      'app/index.ts': '',
      'app/about.ios.tsx': '',
      'app/tabs/_layout.web.tsx': '',
      'app/tabs/home.tsx': '',
      'app/settings/+html.tsx': '',
      'app/hello+api.web.ts': '',
    })
    expect(t.dynamic.map((d) => [d.file, d.detail])).toEqual([
      ['app/+html.tsx', '+html is defined twice: app/+html.ts and app/+html.tsx'],
      ['app/+native-intent.ios.ts', '+native-intent is not an Expo Router route name'],
      ['app/_layout.tsx', 'layout / is defined twice: app/_layout.ts and app/_layout.tsx'],
      ['app/about.ios.tsx', 'about.ios.tsx has no module without a platform extension next to it'],
      ['app/hello+api.web.ts', 'Expo Router API routes cannot have platform extensions'],
      ['app/index.tsx', 'route /index is defined twice: app/index.ts and app/index.tsx'],
      ['app/settings/+html.tsx', '+html is not an Expo Router route name'],
      ['app/tabs/_layout.web.tsx', '_layout.web.tsx has no module without a platform extension next to it'],
    ])
    expect(extract(expoRouterAdapter, '', { 'src/a.ts': '' }).dynamic.map((d) => d.detail)).toEqual(['no Expo Router routes directory found: expected app/ or src/app/ in the project, or set routes.dir to it'])
    expect(extract(expoRouterAdapter, 'app', { 'app/README.md': '' }).dynamic.map((d) => d.detail)).toEqual(['no Expo Router route found: expected route modules under app'])
  })
})
