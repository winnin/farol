import { afterAll, describe, expect, it } from 'vitest'
import { analyzeRepo } from '../helpers/analyze.js'
import { createRepo, type TestRepo } from '../helpers/repo.js'

const repos: TestRepo[] = []
afterAll(() => {
  for (const r of repos) r.cleanup()
})

const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, noEmit: true }, include: ['**/*.ts', '**/*.tsx'] })

/** A repository on `main` with the given files, then a `feature` branch with `head` written (null deletes). */
function repoWith(base: Record<string, string>, head: Record<string, string | null>): TestRepo {
  const repo = createRepo()
  repos.push(repo)
  repo.write('tsconfig.json', TSCONFIG)
  for (const [path, code] of Object.entries(base)) repo.write(path, code)
  repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  for (const [path, code] of Object.entries(head)) {
    if (code === null) repo.remove(path)
    else repo.write(path, code)
  }
  repo.commit('head')
  return repo
}

const NEXT_BASE = {
  'farol.config.json': JSON.stringify({ routes: { adapter: 'next' } }),
  'components/Card.tsx': 'export function Card() {\n  return <div>card</div>\n}\n',
  'pages/_app.tsx': 'export default function App({ Component }: { Component: () => null }) {\n  return <Component />\n}\n',
  'pages/index.tsx': 'export default function Home() {\n  return <h1>home</h1>\n}\n',
  'pages/about.tsx': "import { Card } from '../components/Card'\nexport default function About() {\n  return <Card />\n}\n",
}

describe('Next.js (Pages Router)', () => {
  it('a new page is isolated', async () => {
    const { output } = await analyzeRepo(repoWith(NEXT_BASE, { 'pages/orders/[id].tsx': 'export default function Order() {\n  return <h1>order</h1>\n}\n' }))
    expect(output.classification).toBe('isolated')
    expect(output.routes.added.map((r) => [r.path, r.entry])).toEqual([['/orders/:id', 'pages/orders/[id].tsx']])
    expect(output.reasons.find((r) => r.code === 'route-added')?.file).toBe('pages/orders/[id].tsx')
  })

  it('a changed component affects the pages that render it, and _app affects every page', async () => {
    const card = await analyzeRepo(repoWith(NEXT_BASE, { 'components/Card.tsx': 'export function Card() {\n  return <div>new card</div>\n}\n' }))
    expect(card.output.classification).toBe('touches-existing')
    expect(card.output.routes.affected.map((r) => r.path)).toEqual(['/about'])
    const app = await analyzeRepo(repoWith(NEXT_BASE, { 'pages/_app.tsx': 'export default function App({ Component }: { Component: () => null }) {\n  return <main><Component /></main>\n}\n' }))
    expect(app.output.routes.affected.map((r) => r.path)).toEqual(['/', '/about'])
  })

  it('a removed page is a change to existing routes', async () => {
    const { output } = await analyzeRepo(repoWith(NEXT_BASE, { 'pages/about.tsx': null }))
    expect(output.classification).toBe('touches-existing')
    expect(output.reasons.filter((r) => r.code === 'routes-not-additive').map((r) => [r.file, r.detail])).toEqual([['pages/about.tsx', 'route /about (/about) was removed']])
  })
})

const route = (id: string, body = 'null'): string => `import { createFileRoute } from '@tanstack/react-router'\nexport const Route = createFileRoute('${id}')({ component: () => ${body} })\n`

const TANSTACK_BASE = {
  'farol.config.json': JSON.stringify({ routes: { adapter: 'tanstack-router' } }),
  'src/routes/__root.tsx': "import { createRootRoute } from '@tanstack/react-router'\nexport const Route = createRootRoute({})\n",
  'src/routes/index.tsx': route('/'),
  'src/routes/_app.tsx': route('/_app', '<div />'),
  'src/routes/_app/settings.tsx': route('/_app/settings'),
}

describe('TanStack Router (file-based)', () => {
  it('a new route is isolated; a changed pathless layout affects the routes under it only', async () => {
    const added = await analyzeRepo(repoWith(TANSTACK_BASE, { 'src/routes/_app/billing.tsx': route('/_app/billing') }))
    expect(added.output.classification).toBe('isolated')
    expect(added.output.routes.added.map((r) => r.path)).toEqual(['/billing'])
    const layout = await analyzeRepo(repoWith(TANSTACK_BASE, { 'src/routes/_app.tsx': route('/_app', '<main />') }))
    expect(layout.output.classification).toBe('touches-existing')
    expect(layout.output.routes.affected.map((r) => r.path)).toEqual(['/settings'])
  })
})

const EXPO_BASE = {
  'farol.config.json': JSON.stringify({ routes: { adapter: 'expo-router' } }),
  'components/Card.tsx': 'export function Card() {\n  return <div>card</div>\n}\n',
  'app/_layout.tsx': 'export default function Root() {\n  return null\n}\n',
  'app/index.tsx': 'export default function Home() {\n  return <h1>home</h1>\n}\n',
  'app/(tabs)/_layout.tsx': 'export default function Tabs() {\n  return null\n}\n',
  'app/(tabs)/cards.tsx': "import { Card } from '../../components/Card'\nexport default function Cards() {\n  return <Card />\n}\n",
}

describe('Expo Router', () => {
  it('a new screen is isolated; a changed group layout affects the screens under it only', async () => {
    const added = await analyzeRepo(repoWith(EXPO_BASE, { 'app/(tabs)/cards/[cardId].tsx': 'export default function CardDetail() {\n  return <h1>card</h1>\n}\n' }))
    expect(added.output.classification).toBe('isolated')
    expect(added.output.routes.added.map((r) => [r.path, r.entry])).toEqual([['/cards/:cardId', 'app/(tabs)/cards/[cardId].tsx']])
    const layout = await analyzeRepo(repoWith(EXPO_BASE, { 'app/(tabs)/_layout.tsx': 'export default function Tabs() {\n  return <main />\n}\n' }))
    expect(layout.output.classification).toBe('touches-existing')
    expect(layout.output.routes.affected.map((r) => r.path)).toEqual(['/cards'])
  })

  it('a changed component affects the screens that render it', async () => {
    const { output } = await analyzeRepo(repoWith(EXPO_BASE, { 'components/Card.tsx': 'export function Card() {\n  return <div>new card</div>\n}\n' }))
    expect(output.classification).toBe('touches-existing')
    expect(output.routes.affected.map((r) => r.path)).toEqual(['/cards'])
  })

  it('a test file added under app/ is a new screen: Expo Router loads every module there', async () => {
    const { output } = await analyzeRepo(repoWith(EXPO_BASE, { 'app/(tabs)/Card.test.tsx': "import { Card } from '../../components/Card'\n\ntest('renders', () => Card())\n" }))
    expect(output.routes.added.map((r) => [r.path, r.entry])).toEqual([['/Card.test', 'app/(tabs)/Card.test.tsx']])
  })
})
