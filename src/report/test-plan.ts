import { posix } from 'node:path'
import { isScriptFile } from '../classify/declarations-only.js'
import { ENTRY_KINDS } from '../config/schema.js'
import { compareStrings } from '../output/order.js'
import type { Output } from '../output/schema.js'
import { mergeScore, scoreGroups } from './merge-score.js'

/** One page or operation to try by hand before approving. */
export interface TestItem {
  key: string
  path: string
  kind: 'new' | 'affected'
  /** Riskiest changed file behind it (affected) or the module it renders (new). */
  because: string | null
  /** Risk points of that file: the order in which to test. */
  priority: number
  /** Changed files behind it (every file of its chains, or the module a new one renders): once all of them are
   * reviewed, the HTML report shows the item as reviewed. */
  files: string[]
}

export interface TestGroup {
  label: string
  items: TestItem[]
}

/** The file of a key such as `JOB src/jobs/a.ts`, an entry point named by its file. A file name can hold spaces. */
export function fileOfEntryKey(key: string): string | null {
  const space = key.indexOf(' ')
  const file = key.slice(space + 1)
  return (ENTRY_KINDS as readonly string[]).includes(key.slice(0, space)) && !file.startsWith('/') && isScriptFile(file) ? file : null
}

/** Module of an entry point: the service and method of backend keys, the first URL segment of pages. */
export function moduleOf(o: Output, path: string): string {
  if (o.surface === 'backend') {
    const parts = path.split(' ')
    if (fileOfEntryKey(path) !== null) return parts[0] ?? ''
    if (parts.length >= 3) return `${parts[0] ?? ''} ${parts[1] ?? ''}`
    if (parts.length === 2) {
      const first = (parts[1] ?? '').split('/').filter((s) => s !== '')[0]
      return parts[0] === 'RUN' ? 'RUN' : `${parts[0] ?? ''} /${first ?? ''}`
    }
    return path.split('.')[0] ?? path
  }
  const first = path.split('/').filter((s) => s !== '')[0]
  return first === undefined ? '/' : `/${first}`
}

/**
 * Manual test checklist: every new and affected page/operation (layouts excluded: their pages are listed), grouped
 * by module, riskiest first. New entry points come first in their group: nothing existed to compare them with.
 */
export function testPlan(o: Output): TestGroup[] {
  const points = new Map(scoreGroups(mergeScore(o).items).flatMap((g) => (g.file === null ? [] : [[g.file, g.points] as const])))
  const items: TestItem[] = [
    ...o.routes.added.filter((r) => !r.hasChildren).map((r): TestItem => ({ key: r.key, path: r.path, kind: 'new', because: r.entry, priority: 100, files: r.entry === null ? [] : [r.entry] })),
    ...o.routes.affected
      .filter((r) => !r.hasChildren)
      .map((r): TestItem => {
        const files = r.via.map((v) => v.file).sort((a, b) => (points.get(b) ?? 0) - (points.get(a) ?? 0) || compareStrings(a, b))
        return { key: r.key, path: r.path, kind: 'affected', because: files[0] ?? null, priority: points.get(files[0] ?? '') ?? 0, files: [...new Set(files)].sort(compareStrings) }
      }),
  ]
  const groups = new Map<string, TestItem[]>()
  for (const item of items) groups.set(moduleOf(o, item.path), [...(groups.get(moduleOf(o, item.path)) ?? []), item])
  return [...groups.entries()]
    .map(([label, list]) => ({ label, items: list.sort((a, b) => b.priority - a.priority || compareStrings(a.path, b.path)) }))
    .sort((a, b) => Math.max(...b.items.map((i) => i.priority)) - Math.max(...a.items.map((i) => i.priority)) || compareStrings(a.label, b.label))
}

export function shortFile(path: string | null): string {
  return path === null ? '' : posix.basename(path)
}
