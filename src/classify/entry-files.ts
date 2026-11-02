import type { OutputFile } from '../output/schema.js'
import type { RouteEntry } from '../routes/types.js'

/** Existing entry points named in the configuration whose own file this PR edits. */
export function editedEntryFiles(configEntries: ReadonlyMap<string, string>, files: readonly OutputFile[], existing: readonly RouteEntry[]): { route: RouteEntry; file: OutputFile }[] {
  return existing.flatMap((route) => {
    const path = configEntries.get(route.key)
    const file = files.find((f) => f.path === path && f.status === 'modified')
    return file ? [{ route, file }] : []
  })
}
