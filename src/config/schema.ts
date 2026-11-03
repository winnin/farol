import { z } from 'zod'

const glob = z.string().min(1, 'glob patterns cannot be empty')
/**
 * Whether a brace expansion of the glob starts with "/" (`/a`, `{a,/b}`, `{,x}/a`). Changed files have relative paths,
 * so such a glob never matches. Only a group at the start counts: text before a brace is a prefix (`src{/,/a/}*.ts`).
 */
function isRooted(g: string): boolean {
  if (g.startsWith('/')) return true
  if (!g.startsWith('{')) return false
  const alternatives: string[] = []
  let depth = 0
  let start = 1
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '\\') i++
    else if (c === '{') depth++
    else if (c === ',' && depth === 1) {
      alternatives.push(g.slice(start, i))
      start = i + 1
    } else if (c === '}' && --depth === 0) {
      alternatives.push(g.slice(start, i))
      return alternatives.some((a) => isRooted(a + g.slice(i + 1)))
    }
  }
  return false // an unclosed "{" is a literal character
}
const pathGlob = glob.refine((g) => !isRooted(g), 'write the glob relative to the project or repository, with no leading "/"')
const globs = z.array(pathGlob)

/** Kinds of the entry points a TypeScript backend names in `backend.entries`. */
export const ENTRY_KINDS = ['JOB', 'CONSUMER', 'RPC', 'RUN'] as const
// `!(a).ts` is a positive glob; `{./a,b}` holds a segment like any other.
const isPositive = (g: string): boolean => !g.startsWith('!') || g.startsWith('!(')
const hasDotSegment = (g: string): boolean => g.split(/[/{},]/).some((seg) => seg === '.' || seg === '..')
const entryGlob = pathGlob.refine((g) => isPositive(g) && !hasDotSegment(g), 'write a positive glob relative to the project, with no "!", "./" or "../"')

/**
 * Environment, infrastructure and CI files (deploy-time configuration, not code): matched anywhere in the repository,
 * only for files that are not source code.
 */
export const DEFAULT_INFRA = [
  '**/.env', '**/.env.*', '**/*.env', '**/Dockerfile', '**/Dockerfile.*', '**/*.dockerfile', '**/.dockerignore',
  '**/docker-compose*.{yml,yaml}', '**/compose.{yml,yaml}', '.github/**', '.gitlab-ci.yml', '.gitlab/**', '.circleci/**',
  '.buildkite/**', '**/Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '**/.infra/**', '**/infra/**',
  '**/infrastructure/**', '**/deploy/**', '**/deployment/**', '**/k8s/**', '**/kubernetes/**', '**/helm/**', '**/charts/**',
  '**/terraform/**', '**/*.tf', '**/*.tfvars', '**/skaffold*.{yml,yaml}', '**/Procfile', '**/serverless.{yml,yaml}',
  '**/fly.toml', '**/vercel.json', '**/netlify.toml', '**/nginx*.conf', '**/.tool-versions', '**/.nvmrc', '**/.python-version',
]

export const DEFAULT_ROLES = {
  barrel: ['**/index.ts'],
  i18n: ['src/locales/**/*.json'],
  test: ['**/*.test.ts', '**/*.test.tsx'],
  story: ['**/*.stories.tsx'],
  global: ['src/App.tsx', 'src/main.tsx', 'package.json', 'package-lock.json', 'tsconfig*.json', 'eslint.config.*', 'vite.config.ts'],
  infra: DEFAULT_INFRA,
}

/** Roles of a Go module: tests are `_test.go` files; go.mod and go.sum are the manifest and lockfile (not globs). */
export const GO_DEFAULT_ROLES = { barrel: [], i18n: [], test: ['**/*_test.go'], story: [], global: [], infra: DEFAULT_INFRA }

/** Generated mocks are test doubles: they implement every interface and would be reached through each of them. */
export const GO_DEFAULT_EXCLUDE = ['**/mock/**', '**/mocks/**', '**/*_mock.go', '**/mock_*.go']

/** Roles of a Python project: pytest files and directories are tests. */
export const PYTHON_DEFAULT_ROLES = { barrel: [], i18n: [], test: ['tests/**', '**/tests/**', '**/test/**', '**/test_*.py', '**/*_test.py', '**/conftest.py'], story: [], global: [], infra: DEFAULT_INFRA }

/** Datadog sites: the API host is `api.<site>`. A closed list, so a changed configuration cannot send the keys elsewhere. */
export const DATADOG_SITES = ['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ap2.datadoghq.com', 'ddog-gov.com'] as const

/** Service names, tags and operation names used in Datadog queries. */
const ddName = z.string().regex(/^[A-Za-z0-9_.:\-/]+$/, 'only letters, digits and _ . : - / are allowed')

export const DatadogSchema = z
  .object({
    site: z.enum(DATADOG_SITES).default('datadoghq.com'),
    /** Days of traffic `farol usage` reads, up to now. */
    days: z.number().int().min(1).max(90).default(14),
    env: ddName.optional(),
    /** Also read errors: RUM errors per page, APM error spans per operation, Error Tracking issues per file. */
    errors: z.boolean().default(true),
    /** Frontends: page views of a RUM application, grouped by URL path. */
    rum: z.object({ applicationId: ddName, facet: z.string().regex(/^@[A-Za-z0-9_.]+$/).default('@view.url_path_group') }).strict().optional(),
    /**
     * Backends: `trace.<operation>.hits` of a service (or several, for a repository with several apps) by resource,
     * e.g. operations ["http.request"], ["fastapi.request"] or ["fastify.request", "graphql.resolve"].
     */
    apm: z.object({ service: z.union([ddName, z.array(ddName).min(1)]), operations: z.array(ddName).min(1) }).strict().optional(),
  })
  .strict()
  .refine((d) => d.rum !== undefined || d.apm !== undefined, { message: 'set datadog.rum (pages) or datadog.apm (operations)' })

type Roles = typeof DEFAULT_ROLES

/** Default roles of each language. */
const LANGUAGE_ROLES: Record<'typescript' | 'go' | 'python', Roles> = { typescript: DEFAULT_ROLES, go: GO_DEFAULT_ROLES, python: PYTHON_DEFAULT_ROLES }

function rolesWithDefaults(given: Partial<Record<keyof Roles, string[]>>, defaults: Roles): Roles {
  return {
    barrel: given.barrel ?? defaults.barrel,
    i18n: given.i18n ?? defaults.i18n,
    test: given.test ?? defaults.test,
    story: given.story ?? defaults.story,
    global: given.global ?? defaults.global,
    infra: given.infra ?? defaults.infra,
  }
}

export const ConfigSchema = z
  .object({
    /**
     * typescript: the TypeScript compiler reads the project; go: the Go toolchain does (a helper built from go-helper/);
     * python: Python's own parser does (py-helper/, run with python3).
     */
    language: z.enum(['typescript', 'go', 'python']).default('typescript'),
    python: z
      .object({
        /** Import roots, relative to the project: `src` for a src layout (`from orders_api import x` is src/orders_api/x.py). */
        roots: z.array(z.string().min(1)).min(1).default(['src', '.']),
      })
      .strict()
      .prefault({}),
    /** frontend: React routes are the entry points; backend: GraphQL operations, REST endpoints and `backend.entries` are. */
    surface: z.enum(['frontend', 'backend']).default('frontend'),
    tsconfig: z.string().min(1).default('tsconfig.json'),
    backend: z
      .object({
        /** Read GraphQL schemas (.graphql files and gql`…` templates) and resolver maps. */
        graphql: z.boolean().default(true),
        /** Read REST endpoints registered with Fastify/Express-style calls. */
        rest: z.boolean().default(true),
        /**
         * Context properties injected at runtime (dependency injection the import graph cannot see), with the files
         * that provide them, e.g. "loaders" → the loader registries of each module. A resolver reading `loaders.Brand…`
         * uses the provider file whose directory or name matches `Brand`, or every provider when none matches.
         */
        context: z.record(z.string().min(1), globs).default({}),
        /**
         * Files that run outside HTTP and GraphQL (Kafka handlers, cron jobs, gRPC services, scripts), by kind. Each
         * matching file of the TypeScript program is one entry point, `<KIND> <repo-relative file>`, that runs the code
         * the file uses.
         */
        entries: z.partialRecord(z.enum(ENTRY_KINDS), z.array(entryGlob)).default({}),
      })
      .strict()
      .prefault({}),
    routes: z
      .object({
        /** react-router: a route table in `file`. next, tanstack-router: file-system routing under `dir`. */
        adapter: z.enum(['react-router', 'next', 'tanstack-router']).default('react-router'),
        file: z.string().min(1, 'routes.file must point to the file with the route table, e.g. "src/routes.tsx"').optional(),
        /** File-system routers: next → the directory holding pages/ and app/ (default: the project, or its src/); tanstack-router → the routes directory (default "src/routes"). */
        dir: z.string().optional(),
        /** Other modules that only define routes (split route trees): they get the routes rule instead of the source rule. */
        extraFiles: globs.default([]),
      })
      .strict()
      .superRefine((routes, ctx) => {
        if (routes.adapter === 'react-router' && routes.file === undefined) ctx.addIssue({ code: 'custom', path: ['file'], message: 'routes.file must point to the file with the route table, e.g. "src/routes.tsx"' })
        if (routes.adapter !== 'react-router' && routes.file !== undefined) ctx.addIssue({ code: 'custom', path: ['file'], message: `the ${routes.adapter} adapter reads a directory: use routes.dir instead of routes.file` })
      })
      .transform(({ file, dir, ...routes }) => ({
        ...routes,
        file: file ?? '',
        ...(routes.adapter === 'react-router' ? {} : { dir: dir ?? (routes.adapter === 'tanstack-router' ? 'src/routes' : '') }),
      }))
      .optional(),
    exclude: globs.default([]),
    /** TypeScript: import targets the build generates and git ignores (Prisma client, protobuf types): not an unresolved import. Project-relative globs, matched against the import path as written. */
    generated: globs.default([]),
    /** Where `farol usage` reads traffic from (optional). */
    datadog: DatadogSchema.optional(),
    /** Changed files left out of every analysis (classification, dependencies, signals). Project-relative or repo-relative globs. */
    ignore: globs.default([]),
    roles: z
      .object({
        // Each key left out takes the default of the project's language (see the transform below).
        barrel: globs.optional(),
        i18n: globs.optional(),
        test: globs.optional(),
        story: globs.optional(),
        global: globs.optional(),
        /** Environment, infrastructure and CI files (repo-relative globs; source code files never match). */
        infra: globs.optional(),
      })
      .strict()
      .prefault({}),
    signals: z
      .object({
        coverage: z.string().min(1).optional(),
        eslint: z.string().min(1).optional(),
        /** npm/pnpm audit --json report, for vulnerabilities in added or changed dependencies. */
        audit: z.string().min(1).optional(),
        /** Traffic per page/operation written by `farol usage` (information only). */
        usage: z.string().min(1).optional(),
        /** Changed files left out of diff coverage only (they still count everywhere else), e.g. constants and types. */
        coverageIgnore: globs.default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.language !== 'typescript' && config.surface !== 'backend') ctx.addIssue({ code: 'custom', path: ['surface'], message: `a ${config.language === 'go' ? 'Go' : 'Python'} project is a backend: set "surface": "backend"` })
    if (config.language !== 'typescript' && config.generated.length > 0) ctx.addIssue({ code: 'custom', path: ['generated'], message: 'only TypeScript projects read generated import targets: remove it' })
    if ((config.language !== 'typescript' || config.surface !== 'backend') && Object.keys(config.backend.entries).length > 0) ctx.addIssue({ code: 'custom', path: ['backend', 'entries'], message: 'only TypeScript backends read entry points from the configuration' })
    if (config.surface === 'frontend' && config.routes === undefined) ctx.addIssue({ code: 'custom', path: ['routes'], message: 'routes is required for a frontend (routes.file for React Router, or routes.adapter "next" / "tanstack-router"), or set "surface": "backend"' })
  })
  // A backend has no routes file: an empty one keeps the rest of the code uniform.
  .transform((config) => ({
    ...config,
    routes: config.routes ?? { adapter: 'react-router' as const, file: '', extraFiles: [] },
    // Every role the configuration leaves out takes the default of the project's language, key by key: setting
    // roles.global in a Python project keeps the Python test globs.
    roles: rolesWithDefaults(config.roles, LANGUAGE_ROLES[config.language]),
    exclude: config.language === 'go' && config.exclude.length === 0 ? GO_DEFAULT_EXCLUDE : config.exclude,
  }))

export type Config = z.infer<typeof ConfigSchema>
export type ConfigInput = z.input<typeof ConfigSchema>
