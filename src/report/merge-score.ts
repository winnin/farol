import { REASONS } from '../classify/reasons.js'
import { compareStrings } from '../output/order.js'
import type { Output } from '../output/schema.js'

/**
 * One thing that makes the merge risky, with a weight in [0, 1] (roughly: how likely it is to break something).
 * Items of a file go away when that file is marked as reviewed; items without a file (vulnerable dependencies,
 * analysis problems) never do.
 */
export interface ScoreItem {
  file: string | null
  kind: 'change' | 'infra' | 'security' | 'lint' | 'suppression' | 'tests' | 'dependency' | 'vulnerability' | 'global' | 'unknown' | 'contract'
  weight: number
  title: string
  /** Line of a finding (security, lint, suppression). */
  line?: number
}

export type ScoreLevel = 'high' | 'medium' | 'low'

/** Score at or above which the merge is high / medium risk. */
export const HIGH_SCORE = 60
export const MEDIUM_SCORE = 30

/**
 * Global files and critical dependency changes. Calibrated on 528 commits of 3 repositories (2026-10-18): global PRs
 * (mostly dependency bumps) were followed by a revert or fix no more often than other changes to existing code.
 */
export const GLOBAL_WEIGHT = 0.3
/** All environment, infrastructure and CI files of a PR together (a deploy-time risk, not a code path). */
export const INFRA_WEIGHT = 0.12
/** Each added file that only declares things (types, re-exports, static constants), and all of them together at most. */
export const DECLARATIONS_FILE_WEIGHT = 0.01
export const DECLARATIONS_TOTAL_WEIGHT = 0.05
/**
 * Endpoints whose contract breaks (or may break) clients, all together: a model shared by many endpoints breaks them
 * all with one change, so the weight is shared rather than added per endpoint. Not tied to a file: reviewing the code
 * does not tell whether the clients were updated.
 */
export const CONTRACT_WEIGHT = { breaking: 0.4, dangerous: 0.1 } as const
/**
 * Dependency changes, by how much the bump can break: a major version or a removed package breaks code that uses it,
 * a 0.x minor (or 0.0.x patch) may, a compatible bump rarely does. Versions that cannot be compared are read by hand.
 */
export const DEPENDENCY_WEIGHT = { breaking: 0.15, unknown: 0.1, mayBreak: 0.08, compatible: 0.02 } as const

function dependencyWeight(c: Output['dependencies']['changes'][number]): number {
  if (!c.critical) return DEPENDENCY_WEIGHT.compatible
  if (c.change === 'removed' || c.bump === 'major') return DEPENDENCY_WEIGHT.breaking
  if (c.bump === 'unknown') return DEPENDENCY_WEIGHT.unknown
  return DEPENDENCY_WEIGHT.mayBreak
}

const SECURITY_WEIGHT = { high: 0.3, medium: 0.1, low: 0.02 } as const
const VULN_WEIGHT = { critical: 0.5, high: 0.35, moderate: 0.12, low: 0.03, info: 0 } as const

const round = (n: number): number => Math.round(n * 1000) / 1000

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|go|py|graphql|gql)$/
export const isCode = (path: string): boolean => CODE.test(path)

/** Weight of a changed file from its reach: existing pages/operations it runs in and its centrality, by kind of change. */
function reachWeight(f: Output['risk']['files'][number], totalPages: number): number {
  if (f.change === 'additive') return 0.02
  // New code: untested new code inside existing pages is a risk of its own.
  // New code no existing entry point runs cannot break what exists; untested new code inside existing pages can.
  if (f.change === 'added') return f.pagesReached > 0 ? 0.15 : 0.02
  if (f.change === 'deleted') return 0.2
  const share = totalPages === 0 ? 0 : f.pagesReached / totalPages
  // A changed file no entry point reaches weighs little: many of them must not add up to a high score.
  const raw = f.pagesReached === 0 ? 0.03 + 0.1 * f.centrality : 0.05 + 0.45 * share + 0.15 * f.centrality
  const floor = f.level === 'high' ? 0.35 : f.level === 'medium' ? 0.12 : 0
  return Math.min(0.6, Math.max(raw, floor))
}

/** Share of a file's risk left by its diff coverage: 100% covered keeps 30%, 0% keeps it all. */
export const COVERED_RISK = 0.3
/** Share kept by a file whose changed lines are all declarations (nothing executable to cover). */
export const DECLARATIONS_RISK = 0.5
/**
 * Share kept by a file left out of coverage on purpose (coverageIgnore, or the project's own coverage settings):
 * neither tested nor untested, and usually constants, types, migrations or generated code.
 */
export const LEFT_OUT_RISK = 0.5

export interface FileCoverage {
  /** Covered share of the changed executable lines, or null when unknown (no report, or no executable line changed). */
  ratio: number | null
  factor: number
  label: string
}

/** Diff coverage of each changed file, as the factor applied to its weight (1 when unknown: fail closed). */
export function fileCoverage(o: Output): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>()
  if (o.signals.coverage.status !== 'ok') return out
  for (const path of o.signals.coverage.ignoredFiles) out.set(path, { ratio: null, factor: LEFT_OUT_RISK, label: 'left out of diff coverage (coverageIgnore)' })
  for (const path of o.signals.coverage.excludedByProject ?? []) out.set(path, { ratio: null, factor: LEFT_OUT_RISK, label: "left out by the project's coverage settings" })
  for (const f of o.signals.coverage.files) {
    if (f.changedExecutableLines === 0) {
      // Only declarations changed (types, fields, constants): tests cannot cover them, and they rarely break alone.
      out.set(f.path, { ratio: null, factor: DECLARATIONS_RISK, label: 'only declarations changed (no executable line)' })
      continue
    }
    const ratio = f.missingFromReport ? 0 : f.coveredLines / f.changedExecutableLines
    out.set(f.path, { ratio, factor: 1 - (1 - COVERED_RISK) * ratio, label: f.missingFromReport ? 'missing from the coverage report' : `${Math.round(ratio * 100)}% of changed lines covered` })
  }
  return out
}

/** Everything that adds to the merge risk score, heaviest first. Pure: derived from the analysis output only. */
export function scoreItems(o: Output): ScoreItem[] {
  const items: ScoreItem[] = []
  const add = (file: string | null, kind: ScoreItem['kind'], weight: number, title: string, line?: number): void => {
    if (round(weight) > 0) items.push({ file, kind, weight: round(Math.min(weight, 0.95)), title, ...(line === undefined ? {} : { line }) })
  }
  const coverage = fileCoverage(o)
  const coverageNote = o.signals.coverage.status === 'ok' ? 'not measured' : 'coverage not verified'
  const declarationsOnly = new Set(o.files.filter((f) => f.declarationsOnly === true).map((f) => f.path))
  // Only comments or formatting changed: the code that runs is the same, so the file adds nothing to the risk.
  const commentsOnly = new Set(o.files.filter((f) => f.commentsOnly === true).map((f) => f.path))
  // Shared like the infra weight: one point each, five for all of them together.
  const declarationWeight = Math.min(DECLARATIONS_FILE_WEIGHT, 1 - (1 - DECLARATIONS_TOTAL_WEIGHT) ** (1 / Math.max(1, declarationsOnly.size)))
  for (const f of o.risk.files) {
    // Docs, templates and other files that are not code have no runtime behavior to weigh.
    if (!isCode(f.path) || commentsOnly.has(f.path)) continue
    if (declarationsOnly.has(f.path)) {
      add(f.path, 'change', declarationWeight, `added · only declarations (types, re-exports, static constants): no logic of its own`)
      continue
    }
    const c = coverage.get(f.path)
    add(f.path, 'change', reachWeight(f, o.risk.totalPages) * (c?.factor ?? 1), `${f.change} · ${f.level} reach: ${f.why} · ${c?.label ?? coverageNote}`)
  }
  // Environment, infrastructure and CI files together weigh at most INFRA_WEIGHT, shared by file (each reviewable).
  const infra = o.files.filter((f) => f.role === 'infra')
  for (const f of infra) add(f.path, 'infra', 1 - (1 - INFRA_WEIGHT) ** (1 / infra.length), `${f.status} environment, infrastructure or CI file: check it per environment`)
  // Findings in files outside the project belong to another project's review.
  const outside = new Set(o.files.filter((f) => f.role === 'excluded').map((f) => f.path))
  const security = o.signals.security.findings.filter((s) => !outside.has(s.path))
  for (const s of security) add(s.path, 'security', SECURITY_WEIGHT[s.severity], `${s.severity} ${s.rule} at line ${s.line}`, s.line)
  // A lint error on the line of a security finding is the same problem seen twice (ruff S608 and bandit): counted once.
  const securityLines = new Set(security.map((s) => `${s.path}:${s.line}`))
  for (const l of o.signals.lint.findings) if (l.severity === 'error' && !outside.has(l.path) && !securityLines.has(`${l.path}:${l.line}`)) add(l.path, 'lint', 0.05, `lint error ${l.rule} at line ${l.line}`, l.line)
  for (const s of o.signals.suppressions.items) if (!outside.has(s.path)) add(s.path, 'suppression', 0.02, `${s.kind} at line ${s.line}`, s.line)
  // A deleted or heavily trimmed test may hide a regression; a few removed lines are usual test maintenance.
  for (const t of o.signals.testsModified.files) if (t.linesRemoved > 0) add(t.path, 'tests', t.status === 'deleted' ? 0.1 : t.linesRemoved >= 10 ? 0.05 : 0.02, `existing test ${t.status}, ${t.linesRemoved} line(s) removed`)
  for (const c of o.dependencies.changes) add(c.manifest, 'dependency', dependencyWeight(c), `${c.name} ${c.change}${c.bump ? ` (${c.bump})` : ''}${c.critical ? ', critical' : ''}`)
  for (const v of o.signals.vulnerabilities.related) add(null, 'vulnerability', VULN_WEIGHT[v.severity] * (v.kind === 'direct' ? 1 : 0.6), `${v.severity} advisory on ${v.package}: ${v.title}`)
  for (const level of ['breaking', 'dangerous'] as const) {
    const list = (o.contracts?.entries ?? []).filter((e) => e.level === level)
    for (const e of list) add(null, 'contract', 1 - (1 - CONTRACT_WEIGHT[level]) ** (1 / list.length), `${level} contract change of ${e.key}: ${e.changes[0]?.where ?? ''} ${e.changes[0]?.detail ?? ''}`.trim())
  }
  for (const r of o.reasons) {
    const effect = REASONS[r.code]
    // Critical dependencies already count per package.
    if (effect === 'global' && r.code !== 'dependency-critical') add(r.file ?? null, 'global', GLOBAL_WEIGHT, `${r.code}: ${r.detail}`)
    if (effect === 'unknown') add(r.file ?? null, 'unknown', 0.25, `${r.code}: ${r.detail}`)
  }
  return items.sort((a, b) => b.weight - a.weight || compareStrings(a.file ?? '', b.file ?? '') || compareStrings(a.title, b.title))
}

/** 0–100: the chance that at least one item breaks something, if each were independent. Adding an item never lowers it. */
export function combineScore(items: readonly Pick<ScoreItem, 'weight'>[]): number {
  return Math.round(100 * (1 - items.reduce((p, i) => p * (1 - i.weight), 1)))
}

export function scoreLevel(score: number): ScoreLevel {
  return score >= HIGH_SCORE ? 'high' : score >= MEDIUM_SCORE ? 'medium' : 'low'
}

export function mergeScore(o: Output): { score: number; level: ScoreLevel; items: ScoreItem[] } {
  const items = scoreItems(o)
  const score = combineScore(items)
  return { score, level: scoreLevel(score), items }
}

/** Items grouped by file (items without a file stay alone): what one "reviewed" tick removes. */
export interface ScoreGroup {
  file: string | null
  items: ScoreItem[]
  /** Risk of this group on its own, 0–100 (stable while other files get reviewed, unlike its share of the score). */
  points: number
}

export function scoreGroups(items: readonly ScoreItem[]): ScoreGroup[] {
  const groups: { file: string | null; items: ScoreItem[] }[] = []
  for (const item of items) {
    const same = item.file === null ? undefined : groups.find((g) => g.file === item.file)
    if (same) same.items.push(item)
    else groups.push({ file: item.file, items: [item] })
  }
  return groups.map((g) => ({ ...g, points: combineScore(g.items) })).sort((a, b) => b.points - a.points || b.items.length - a.items.length)
}
