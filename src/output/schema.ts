import { z } from 'zod'
import { CLASSIFICATIONS, REASON_CODES } from '../classify/reasons.js'
import { CONTRACT_LEVELS } from '../contracts/types.js'
import { ReviewersFileSchema } from '../review/ownership.js'

const path = z.string().min(1)
const line = z.number().int().positive()
const count = z.number().int().nonnegative()
const status = z.enum(['ok', 'not-provided', 'error'])

export const ReasonSchema = z.object({ code: z.enum(REASON_CODES), file: path.optional(), detail: z.string() }).strict()

export const FileSchema = z
  .object({
    path,
    oldPath: path.optional(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
    role: z.enum(['global', 'manifest', 'lockfile', 'routes', 'schema', 'resolvers', 'test', 'story', 'infra', 'barrel', 'i18n', 'source', 'excluded']),
    /** Only for modified routes, barrel and i18n files: whether the additive rule holds. */
    additive: z.boolean().optional(),
    linesAdded: count,
    linesRemoved: count,
    /** Added TypeScript/JavaScript files that only declare things (types, re-exports, static constants): no logic of their own. */
    declarationsOnly: z.literal(true).optional(),
  })
  .strict()

const RangeSchema = z.object({ start: line, end: line }).strict()

export const CoverageSignalSchema = z
  .object({
    status,
    message: z.string().optional(),
    files: z.array(
      z
        .object({
          path,
          changedExecutableLines: count,
          coveredLines: count,
          uncovered: z.array(RangeSchema),
          missingFromReport: z.boolean(),
        })
        .strict(),
    ),
    total: z.object({ changedExecutableLines: count, coveredLines: count }).strict().nullable(),
    /** Changed source files left out of coverage by signals.coverageIgnore / --coverage-ignore. */
    ignoredFiles: z.array(path),
  })
  .strict()

export const LintFindingSchema = z.object({ path, line, rule: z.string(), severity: z.enum(['error', 'warning']), message: z.string() }).strict()

export const LintSignalSchema = z
  .object({
    status,
    message: z.string().optional(),
    changedLines: z.object({ errors: count, warnings: count }).strict().nullable(),
    otherLines: z.object({ errors: count, warnings: count }).strict().nullable(),
    findings: z.array(LintFindingSchema).max(50),
    omittedFindings: count,
  })
  .strict()

export const SUPPRESSION_KINDS = ['eslint-disable', 'eslint-disable-line', 'eslint-disable-next-line', 'ts-ignore', 'ts-expect-error', 'ts-nocheck', 'biome-ignore', 'biome-ignore-all', 'biome-ignore-start', 'as-any', 'any-annotation', 'nolint', 'lint-ignore', 'nosec', 'noqa', 'type-ignore', 'no-cover', 'pyright-ignore', 'pylint-disable'] as const

export const SuppressionsSignalSchema = z
  .object({
    status,
    message: z.string().optional(),
    items: z.array(z.object({ path, line, kind: z.enum(SUPPRESSION_KINDS), text: z.string() }).strict()),
  })
  .strict()

export const TestsModifiedSignalSchema = z
  .object({
    status,
    message: z.string().optional(),
    files: z.array(z.object({ path, oldPath: path.optional(), status: z.enum(['modified', 'deleted', 'renamed']), linesRemoved: count }).strict()),
  })
  .strict()

const vulnSeverity = z.enum(['critical', 'high', 'moderate', 'low', 'info'])

export const VulnerabilitiesSignalSchema = z
  .object({
    status,
    message: z.string().optional(),
    /** Advisories on dependencies this PR added or changed (direct) or on packages they depend on (transitive). */
    related: z.array(
      z
        .object({
          package: z.string(),
          severity: vulnSeverity,
          title: z.string(),
          id: z.string(),
          url: z.string().nullable(),
          cves: z.array(z.string()),
          vulnerableRange: z.string().nullable(),
          patchedVersions: z.string().nullable(),
          relatedTo: z.array(z.string()),
          kind: z.enum(['direct', 'transitive']),
        })
        .strict(),
    ),
    /** Every advisory of the report, by severity (context: most predate the PR). */
    total: z.object({ critical: count, high: count, moderate: count, low: count, info: count }).strict().nullable(),
  })
  .strict()

export const SECURITY_RULES = ['dangerously-set-inner-html', 'inner-html', 'eval', 'string-timer', 'document-write', 'postmessage-wildcard', 'hardcoded-secret', 'javascript-url', 'target-blank', 'insecure-url', 'gosec', 'bandit'] as const

export const SecurityFindingSchema = z
  .object({ path, line, rule: z.enum(SECURITY_RULES), severity: z.enum(['high', 'medium', 'low']), message: z.string(), text: z.string() })
  .strict()

export const SecuritySignalSchema = z
  .object({ status, message: z.string().optional(), findings: z.array(SecurityFindingSchema), summary: z.object({ high: count, medium: count, low: count }).strict() })
  .strict()

export const SignalsSchema = z
  .object({
    coverage: CoverageSignalSchema,
    lint: LintSignalSchema,
    suppressions: SuppressionsSignalSchema,
    testsModified: TestsModifiedSignalSchema,
    security: SecuritySignalSchema,
    vulnerabilities: VulnerabilitiesSignalSchema,
  })
  .strict()

export const UnresolvedImportSchema = z
  .object({ file: path, specifier: z.string(), line, reason: z.enum(['not-found', 'non-literal']), target: path.optional(), packages: z.array(z.string()).optional() })
  .strict()

export const DynamicRouteSchema = z.object({ file: path, line, detail: z.string() }).strict()

export const DependencyChangeSchema = z
  .object({
    manifest: path,
    name: z.string().min(1),
    section: z.enum(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'require', 'indirect']),
    change: z.enum(['added', 'removed', 'updated', 'moved']),
    from: z.string().nullable(),
    to: z.string().nullable(),
    fromSection: z.enum(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'require', 'indirect']).optional(),
    /** Python: extra or dependency group of the requirement. */
    group: z.string().optional(),
    bump: z.enum(['major', 'minor', 'patch', 'range', 'unknown']).nullable(),
    direction: z.enum(['upgrade', 'downgrade']).nullable(),
    critical: z.boolean(),
    note: z.string().optional(),
  })
  .strict()

export const DependenciesSchema = z
  .object({
    /** Changed package.json files that belong to the project (the project, its ancestors, imported workspace packages). */
    manifests: z.array(path),
    lockfiles: z.array(path),
    changes: z.array(DependencyChangeSchema),
    summary: z.object({ critical: count, major: count, minor: count, patch: count, added: count, removed: count }).strict(),
  })
  .strict()

export const RiskSchema = z
  .object({
    /** Existing pages (routes without children) of the head route table. */
    totalPages: count,
    files: z.array(
      z
        .object({
          path,
          change: z.enum(['modified', 'renamed', 'deleted', 'added', 'additive']),
          level: z.enum(['high', 'medium', 'low']),
          directImporters: count,
          transitiveDependents: count,
          centrality: z.number().min(0).max(1),
          pagesReached: count,
          routesReached: count,
          why: z.string(),
        })
        .strict(),
    ),
    summary: z.object({ high: count, medium: count, low: count }).strict(),
  })
  .strict()

export const RouteRefSchema = z.object({ key: z.string(), path: z.string() }).strict()

export const OutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** What the entry points are: React pages (frontend) or GraphQL operations, REST endpoints and configured files (backend). */
    surface: z.enum(['frontend', 'backend']),
    /** "revscope" in results written before the project was renamed. */
    tool: z.object({ name: z.enum(['farol', 'revscope']), version: z.string() }).strict(),
    repo: z.string().nullable(),
    /** Pull request number, when known (--pr or the GitHub Actions event); used for links to the PR diff. */
    pr: z.number().int().positive().nullable(),
    base: z.object({ ref: z.string(), sha: z.string().nullable() }).strict(),
    mergeBase: z.string().nullable(),
    head: z.object({ ref: z.string(), sha: z.string().nullable() }).strict(),
    analyzedAt: z.iso.datetime(),
    classification: z.enum(CLASSIFICATIONS),
    reasons: z.array(ReasonSchema),
    files: z.array(FileSchema),
    /** Changed files whose path matches "ignore" (configuration) or --ignore: left out of everything, except that a rename from a path that is not ignored still counts for the classification. */
    ignoredFiles: z.array(path),
    dependencies: DependenciesSchema,
    risk: RiskSchema,
    routes: z
      .object({
        /** hasChildren: the route wraps other routes (a layout); routes without children are the pages people visit. */
        added: z.array(RouteRefSchema.extend({ entry: path.nullable(), hasChildren: z.boolean() }).strict()),
        affected: z.array(RouteRefSchema.extend({ hasChildren: z.boolean(), via: z.array(z.object({ file: path, chain: z.array(path).min(1) }).strict()).min(1) }).strict()),
        disconnectedNewFiles: z.array(path),
      })
      .strict(),
    signals: SignalsSchema,
    diagnostics: z
      .object({
        unresolvedImports: z.array(UnresolvedImportSchema),
        dynamicRoutes: z.array(DynamicRouteSchema),
        parseErrors: z.array(z.object({ file: path, line, message: z.string() }).strict()),
        timingsMs: z.record(z.string(), count),
        error: z.string().nullable(),
      })
      .strict(),
    review: z.null(),
    /** Incremental mode (--since): only the changes since this commit (e.g. the last reviewed head) were analyzed. */
    incremental: z.object({ since: z.string() }).strict().optional(),
    /** Diffs of the changed code files with 3 context lines (cut at a size limit), for the report's inline diff. */
    diffs: z
      .array(z.object({ path, hunks: z.array(z.object({ header: z.string(), oldStart: count, newStart: count, lines: z.array(z.string()) }).strict()), truncated: z.boolean() }).strict())
      .optional(),
    /**
     * Traffic of the affected pages (RUM page views) or operations (APM requests), from a usage report (--usage).
     * Information only: it never changes the class, the score or the verdict.
     */
    usage: z
      .object({
        status: z.enum(['ok', 'error']),
        message: z.string().optional(),
        /** Datadog site, for links to its explorers. */
        site: z.string().optional(),
        source: z.string(),
        from: z.string(),
        to: z.string(),
        kind: z.enum(['pages', 'operations']),
        /** Every page view or request of the report (health checks left out), and those that matched an entry point of the head. */
        total: count,
        matched: count,
        affectedHits: count,
        /** Distinct errors (Error Tracking issues) of every row, of the matched rows and of the affected entry points. */
        totalIssues: count,
        matchedIssues: count,
        affectedIssues: count,
        /** Affected entry points with traffic or errors, busiest first; affected entry points without a match are left out. */
        entries: z.array(z.object({ key: z.string(), hits: count, issues: count, issueIds: z.array(z.string()).default([]) }).strict()),
        /** Changed files where Error Tracking issues were thrown (top stack frame) in the period, most errors first. */
        files: z.array(z.object({ path, errors: count, issues: count, types: z.array(z.string()), issueIds: z.array(z.string()).default([]), track: z.enum(['rum', 'trace']).optional() }).strict()),
        /** Services that call the entry points with contract changes (Datadog client spans), busiest first. */
        callers: z.array(z.object({ key: z.string(), services: z.array(z.object({ service: z.string(), hits: count }).strict()) }).strict()).default([]),
      })
      .strict()
      .optional(),
    /**
     * Backends: changes of what endpoints receive and return (GraphQL schema, FastAPI, Go handlers, gRPC), per entry
     * point, worst first. `readable`: head entry points whose contract farol could read.
     */
    contracts: z
      .object({
        readable: count,
        entries: z.array(
          z
            .object({
              key: z.string(),
              level: z.enum(CONTRACT_LEVELS),
              changes: z.array(z.object({ level: z.enum(CONTRACT_LEVELS), where: z.string(), detail: z.string() }).strict()),
              omitted: count,
            })
            .strict(),
        ),
        summary: z.object({ breaking: count, dangerous: count, safe: count }).strict(),
        problem: z.string().optional(),
      })
      .strict()
      .optional(),
    /** Reviewers by authorship, added at render time from `farol reviewers` (html/report/comment --reviewers). */
    ownership: ReviewersFileSchema.optional(),
    /** --reviewers: CODEOWNERS owners and recent authors of the changed files (names only). */
    reviewers: z.array(z.object({ name: z.string(), kind: z.enum(['codeowner', 'history']), files: z.array(path), commits: count }).strict()).optional(),
  })
  .strict()

export type Output = z.infer<typeof OutputSchema>
export type OutputFile = z.infer<typeof FileSchema>
export type Dependencies = z.infer<typeof DependenciesSchema>
export type Risk = z.infer<typeof RiskSchema>
export type Signals = z.infer<typeof SignalsSchema>
export type CoverageSignal = z.infer<typeof CoverageSignalSchema>
export type LintSignal = z.infer<typeof LintSignalSchema>
export type LintFinding = z.infer<typeof LintFindingSchema>
export type SuppressionsSignal = z.infer<typeof SuppressionsSignalSchema>
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number]
export type TestsModifiedSignal = z.infer<typeof TestsModifiedSignalSchema>
export type VulnerabilitiesSignal = z.infer<typeof VulnerabilitiesSignalSchema>
export type SecuritySignal = z.infer<typeof SecuritySignalSchema>
export type SecurityFinding = z.infer<typeof SecurityFindingSchema>
export type AffectedRoute = Output['routes']['affected'][number]
export type AddedRoute = Output['routes']['added'][number]
export type UnresolvedImportOut = z.infer<typeof UnresolvedImportSchema>
