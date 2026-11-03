import { renamedOutOfProduction } from '../classify/removed.js'
import type { AnalysisRole } from '../classify/roles.js'
import type { ChangedFile } from '../git/types.js'
import { compareStrings } from '../output/order.js'
import type { TestsModifiedSignal } from '../output/schema.js'

/** Existing test files modified, deleted or renamed, with removed line counts: loosened tests stand out. */
export function testsModifiedSignal(files: readonly ChangedFile[], roleOf: (path: string) => AnalysisRole | 'outside'): TestsModifiedSignal {
  const result: TestsModifiedSignal['files'] = []
  for (const f of files) {
    if (f.status === 'added') continue
    const isTest = roleOf(f.path) === 'test' || (f.oldPath !== undefined && roleOf(f.oldPath) === 'test')
    // Production code renamed to a test path is gone code, not a loosened test.
    if (!isTest || renamedOutOfProduction(f, roleOf(f.path), roleOf)) continue
    result.push({ path: f.path, ...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }), status: f.status, linesRemoved: f.removed.length })
  }
  return { status: 'ok', files: result.sort((a, b) => compareStrings(a.path, b.path)) }
}
