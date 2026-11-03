import { posix } from 'node:path'
import type { ChangedFile } from '../git/types.js'
import type { AnalysisRole } from './roles.js'

function withoutExtension(path: string): string {
  const ext = posix.extname(path)
  return ext === '' ? path : path.slice(0, -ext.length)
}

/** Source and declaration extensions an import can point at, by the extension it is written with (`./a.js`, `./a`). */
const SOURCES_OF_EMITTED: Readonly<Record<string, readonly string[]>> = {
  '': ['.d.ts'],
  '.js': ['.ts', '.tsx', '.d.ts', '.jsx'],
  '.jsx': ['.ts', '.tsx', '.d.ts', '.js'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
}

/** Whether an unresolved specifier target could have pointed at a file this PR deleted or renamed away. */
export function targetsRemoved(target: string, removed: readonly string[]): boolean {
  const ext = posix.extname(target)
  const sources = new Set((SOURCES_OF_EMITTED[ext] ?? []).map((e) => withoutExtension(target) + e))
  const isFolderIndex = (r: string): boolean => posix.dirname(r) === target && posix.basename(r).startsWith('index.')
  return removed.some((r) => r === target || withoutExtension(r) === target || sources.has(r) || isFolderIndex(r))
}

/** Roles of files that are not production code: no entry point runs them. */
const NON_PRODUCTION_ROLES: ReadonlySet<AnalysisRole | 'outside'> = new Set(['test', 'story', 'excluded', 'outside'])

/**
 * A rename from a path that counts as production code to one that does not: the code is gone from the analysis.
 * Roles not listed here count as production code, so a role added later fails closed.
 */
export function renamedOutOfProduction(file: ChangedFile, newRole: AnalysisRole | 'outside', roleOf: (path: string) => AnalysisRole | 'outside'): file is ChangedFile & { oldPath: string } {
  if (file.status !== 'renamed') return false
  if (file.oldPath === undefined) throw new Error(`internal: renamed file ${file.path} has no old path`)
  return NON_PRODUCTION_ROLES.has(newRole) && !NON_PRODUCTION_ROLES.has(roleOf(file.oldPath))
}
