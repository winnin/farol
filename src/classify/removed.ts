import { posix } from 'node:path'
import type { ChangedFile } from '../git/types.js'
import type { AnalysisRole } from './roles.js'

function withoutExtension(path: string): string {
  const ext = posix.extname(path)
  return ext === '' ? path : path.slice(0, -ext.length)
}

/** Source extensions an import of an emitted file (`./a.js`) can point at. */
const SOURCES_OF_EMITTED: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.jsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}

/** Whether an unresolved specifier target could have pointed at a file this PR deleted or renamed away. */
export function targetsRemoved(target: string, removed: readonly string[]): boolean {
  const stem = withoutExtension(target)
  const sources = (SOURCES_OF_EMITTED[posix.extname(target)] ?? []).map((ext) => stem + ext)
  return removed.some((r) => r === target || withoutExtension(r) === target || sources.includes(r) || (posix.dirname(r) === target && posix.basename(r).startsWith('index.')))
}

/** Roles whose files are not production code: no entry point runs them. */
const NOT_COUNTED: ReadonlySet<AnalysisRole | 'outside'> = new Set(['test', 'story', 'excluded', 'outside'])

/**
 * A rename from a path that counts as production code to one that does not: the code is gone from the analysis.
 * It lists the roles that do not count, so a new role counts.
 */
export function leavesCountedCode(file: ChangedFile, newRole: AnalysisRole | 'outside', roleOf: (path: string) => AnalysisRole | 'outside'): boolean {
  return file.status === 'renamed' && file.oldPath !== undefined && NOT_COUNTED.has(newRole) && !NOT_COUNTED.has(roleOf(file.oldPath))
}
