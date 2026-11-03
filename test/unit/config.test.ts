import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseConfig, UsageError } from '../../src/config/load.js'
import { createGeneratedMatcher, createInfraMatcher, createRoleMatcher } from '../../src/classify/roles.js'
import { DEFAULT_INFRA, DEFAULT_ROLES, GO_DEFAULT_ROLES, PYTHON_DEFAULT_ROLES } from '../../src/config/schema.js'

const EXAMPLE = readFileSync(join(import.meta.dirname, '..', '..', 'examples', 'farol.config.json'), 'utf8')

describe('parseConfig', () => {
  it('accepts the example configuration', () => {
    const config = parseConfig(EXAMPLE, 'example')
    expect(config.routes).toEqual({ adapter: 'react-router', file: 'src/routes.tsx', extraFiles: [] })
    expect(config.signals.coverage).toBe('coverage/coverage-final.json')
  })

  it('fills defaults for a minimal configuration', () => {
    const config = parseConfig('{"routes":{"file":"src/routes.tsx"}}', 'min')
    expect(config.tsconfig).toBe('tsconfig.json')
    expect(config.exclude).toEqual([])
    expect(config.generated).toEqual([])
    expect(config.roles.barrel).toEqual(['**/index.ts'])
    expect(config.signals).toEqual({ coverageIgnore: [] })
  })

  it('fills each role left out with the default of the project language, key by key', () => {
    expect(parseConfig('{"language":"python","surface":"backend"}', 'c').roles).toEqual(PYTHON_DEFAULT_ROLES)
    expect(parseConfig('{"language":"go","surface":"backend"}', 'c').roles).toEqual(GO_DEFAULT_ROLES)
    // Setting one role keeps the language's defaults for the others (Python tests stay tests).
    const python = parseConfig('{"language":"python","surface":"backend","roles":{"global":["app/settings.py"]}}', 'c').roles
    expect(python).toEqual({ ...PYTHON_DEFAULT_ROLES, global: ['app/settings.py'] })
    const go = parseConfig('{"language":"go","surface":"backend","roles":{"infra":["deploy/**"]}}', 'c').roles
    expect(go).toEqual({ ...GO_DEFAULT_ROLES, infra: ['deploy/**'] })
    expect(parseConfig('{"routes":{"file":"src/routes.tsx"},"roles":{"barrel":[]}}', 'c').roles).toEqual({ ...DEFAULT_ROLES, barrel: [], infra: DEFAULT_INFRA })
  })

  it('reads file-system routers from a directory, with defaults', () => {
    expect(parseConfig('{"routes":{"adapter":"next"}}', 'c').routes).toEqual({ adapter: 'next', file: '', dir: '', extraFiles: [] })
    expect(parseConfig('{"routes":{"adapter":"tanstack-router"}}', 'c').routes).toEqual({ adapter: 'tanstack-router', file: '', dir: 'src/routes', extraFiles: [] })
    expect(parseConfig('{"routes":{"adapter":"tanstack-router","dir":"routes"}}', 'c').routes.dir).toBe('routes')
  })

  it('explains what is wrong and where', () => {
    expect(() => parseConfig('{"routes":{}}', 'cfg.json')).toThrow(UsageError)
    expect(() => parseConfig('{"routes":{}}', 'cfg.json')).toThrow(/invalid configuration in cfg\.json:\n {2}- routes\.file:/)
    expect(() => parseConfig('{"routes":{"file":"a","adapter":"next"}}', 'c')).toThrow(/routes\.file: the next adapter reads a directory: use routes\.dir/)
    expect(() => parseConfig('{"routes":{"adapter":"remix"}}', 'c')).toThrow(/routes\.adapter/)
    expect(() => parseConfig('{"routes":{"file":"a"},"rolez":{}}', 'c')).toThrow(/unknown key\(s\) "rolez"/)
    expect(() => parseConfig('{', 'c')).toThrow(/not valid JSON/)
  })
})

describe('roles', () => {
  const role = createRoleMatcher(parseConfig(EXAMPLE, 'example'))

  it('applies the precedence global > routes > test > story > barrel > i18n > source', () => {
    expect(role('src/App.tsx')).toBe('global')
    expect(role('tsconfig.app.json')).toBe('global')
    expect(role('src/routes.tsx')).toBe('routes')
    expect(role('src/components/index.test.ts')).toBe('test')
    expect(role('src/components/Button.stories.tsx')).toBe('story')
    expect(role('src/components/index.ts')).toBe('barrel')
    expect(role('src/locales/pt/common.json')).toBe('i18n')
    expect(role('src/pages/Home.tsx')).toBe('source')
  })

  it('excludes only files that are not tests or stories', () => {
    expect(role('src/mocks/handlers.ts')).toBe('excluded')
    expect(role('src/mocks/handlers.test.ts')).toBe('test')
    // Stories match both `exclude` and `roles.story`: they keep the story role.
    expect(role('src/x/Card.stories.tsx')).toBe('story')
  })

  it('never excludes globals or the routes file', () => {
    const r = createRoleMatcher(parseConfig('{"routes":{"file":"./src/routes.tsx"},"exclude":["src/**","package.json"]}', 'c'))
    expect(r('src/routes.tsx')).toBe('routes')
    expect(r('package.json')).toBe('global')
    expect(r('src/a.ts')).toBe('excluded')
  })

  it('recognizes environment, infrastructure and CI files anywhere, but never source code', () => {
    const infra = createInfraMatcher(parseConfig(EXAMPLE, 'example'))
    for (const p of ['.env.example', 'apps/web/.env.production', 'Dockerfile', 'services/api/Dockerfile.dev', 'docker-compose.yml', '.github/workflows/ci.yaml', '.infra/helm/api/prd.yaml', 'deploy/k8s/api.yaml', 'terraform/main.tf', '.gitlab-ci.yml', 'Procfile']) {
      expect(infra(p), p).toBe(true)
    }
    for (const p of ['src/deploy/release.ts', 'infra/scripts/seed.py', 'src/pages/Home.tsx', 'README.md', 'package.json']) {
      expect(infra(p), p).toBe(false)
    }
  })
})

describe('backend entry points', () => {
  it.each([
    ['a Go project', '"language":"go","surface":"backend"'],
    ['a Python project', '"language":"python","surface":"backend"'],
    ['a frontend', '"routes":{"file":"src/routes.tsx"}'],
  ])('rejects them on %s, which would ignore them', (_name, rest) => {
    expect(() => parseConfig(`{${rest},"backend":{"entries":{"JOB":["a.ts"]}}}`, 'c')).toThrow(/backend\.entries/)
  })

  it.each(['../shared/jobs/*.ts', 'src/../jobs/*.ts', './src/jobs/*.ts', '!src/jobs/legacy.ts', 'src/{../x,a}/*.ts', '{./src/a/*.ts,src/b/*.ts}', '/src/jobs/*.ts', '{/src/a/*.ts,src/b/*.ts}', '{,}/src/jobs/*.ts', '{,src}/jobs/*.ts', '{{a,/b},c}/*.ts'])('rejects the glob %s, which would not match as written', (glob) => {
    expect(() => parseConfig(JSON.stringify({ surface: 'backend', backend: { entries: { JOB: [glob] } } }), 'c')).toThrow(/relative to the project/)
  })

  it.each(['!(top).ts', 'src/{a,b}/*.ts', 'src/.hidden/*.ts', 'src{/,/jobs/}*.ts', '{src,lib}/{a,/b}.ts'])('accepts the glob %s', (glob) => {
    const config = parseConfig(JSON.stringify({ surface: 'backend', backend: { entries: { JOB: [glob] } } }), 'c')
    expect(config.backend.entries.JOB).toEqual([glob])
  })

  it('rejects a kind it does not know', () => {
    expect(() => parseConfig('{"surface":"backend","backend":{"entries":{"WORKER":["a.ts"]}}}', 'c')).toThrow(/WORKER/)
  })
})

describe('path globs', () => {
  it.each([
    ['roles.global', { roles: { global: ['/src/App.tsx'] } }],
    ['ignore', { ignore: ['{src/a/**,/legacy/**}'] }],
    ['exclude', { exclude: ['{a/**,/b/**}'] }],
  ])('rejects a glob with a leading "/" in %s, which matches no changed file', (_key, config) => {
    expect(() => parseConfig(JSON.stringify(config), 'c')).toThrow(/leading "\/"/)
  })
})

describe('generated import targets', () => {
  const head = ['apps/api/src/lib/format.ts', 'apps/api/src/generated/.gitkeep', 'src/lib/a.ts']

  it('matches a missing target in a folder with no committed file, by its project-relative path', () => {
    const isGenerated = createGeneratedMatcher(['src/generated/**'], 'apps/api', head)
    expect(isGenerated('apps/api/src/generated/prisma/client.js')).toBe(true)
    expect(isGenerated('apps/api/src/generated/proto/kafka')).toBe(true)
  })

  it('does not match a target next to committed files (a typo in an import of real code)', () => {
    const isGenerated = createGeneratedMatcher(['src/**'], 'apps/api', head)
    expect(isGenerated('apps/api/src/lib/formt.ts')).toBe(false)
  })

  it('does not match a target outside the project, even with a glob that matches everything', () => {
    const isGenerated = createGeneratedMatcher(['**'], 'apps/api', head)
    expect(isGenerated('apps/web/src/missing.ts')).toBe(false)
    expect(isGenerated('src/lib/missing.ts')).toBe(false)
  })

  it('matches nothing without globs', () => {
    expect(createGeneratedMatcher([], '', head)('src/generated/x.js')).toBe(false)
  })

  it('is rejected in Go and Python projects, which do not read it', () => {
    expect(() => parseConfig('{"language":"go","surface":"backend","generated":["gen/**"]}', 'c')).toThrow(/generated: only TypeScript projects read generated import targets/)
  })
})

