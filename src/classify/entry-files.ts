import type { OutputFile } from '../output/schema.js'
import type { RouteEntry } from '../routes/types.js'
import { reason, REASONS, type Reason } from './reasons.js'

export interface EditedEntry {
  route: RouteEntry
  file: OutputFile
}

/** Existing entry points named in the configuration whose own file this PR edits. A file of types only runs nothing. */
export function editedEntryFiles(configEntries: ReadonlyMap<string, string>, files: readonly OutputFile[], existing: readonly RouteEntry[], typeOnly: ReadonlySet<string> = new Set()): EditedEntry[] {
  return existing.flatMap((route) => {
    const path = configEntries.get(route.key)
    const file = files.find((f) => f.path === path && f.status === 'modified' && !typeOnly.has(f.path))
    return file ? [{ route, file }] : []
  })
}

/** A file named as an entry point runs whole when that entry point runs: no edit of it is additive. */
export function markEdited({ route, file }: EditedEntry, reasons: Reason[]): void {
  if (file.additive) file.additive = false
  const additive = reasons.filter((r) => r.file === file.path && r.code.endsWith('-additive') && REASONS[r.code] === 'info')
  for (const r of additive) reasons.splice(reasons.indexOf(r), 1)
  if (!reasons.some((r) => r.file === file.path && r.code === 'existing-file-modified')) reasons.push(reason('existing-file-modified', `the file of entry point ${route.key}`, file.path))
}

/** Entry points a file's risk counts: what its impact reaches, and the entry points named on that file. */
export function reachedKeys(file: string, reached: Iterable<string>, edited: readonly EditedEntry[]): string[] {
  return [...new Set([...reached, ...edited.filter((e) => e.file.path === file).map((e) => e.route.key)])]
}
