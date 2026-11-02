import { Kind, type DocumentNode } from 'graphql'
import { backendFileImpact, compareCodeFile, duplicateEndpoints, mountImpacts, type AddedMount, type BackendFileImpact, type CodeFileChanges } from '../backend/impact.js'
import type { BackendTable } from '../backend/entrypoints.js'
import { holdsApp } from '../backend/hono.js'
import { resolverEntries } from '../backend/resolvers.js'
import { restAnchor } from '../backend/rest.js'
import { diffSdl, parseSdl, sdlSources } from '../backend/schema.js'
import { isScriptFile } from '../classify/declarations-only.js'
import type { AnalysisRole } from '../classify/roles.js'
import { readFiles } from '../git/index.js'
import type { ChangedFile } from '../git/types.js'
import type { RouteEntry, RouteTable } from '../routes/types.js'
import type { Context } from './context.js'
import { graphqlContractChanges, type EntryContractChange } from '../contracts/graphql.js'

/** All type system definitions of a file (a .graphql file or every gql`…` template of a TS/JS file), as one document. */
function fileSchema(file: string, code: string | undefined): DocumentNode | null {
  if (code === undefined) return null
  const docs = sdlSources(file, code).sources.map((s) => parseSdl(s).doc).filter((d) => d !== null)
  if (docs.length === 0) return null
  return { kind: Kind.DOCUMENT, definitions: docs.flatMap((d) => d.definitions) }
}

/**
 * Impact of every changed schema or resolver file: the SDL and the resolvers/endpoints of its base and head versions,
 * each parsed on its own, are compared member by member.
 */
export async function backendImpacts(
  ctx: Context,
  table: BackendTable,
  files: readonly ChangedFile[],
  roleOf: (path: string) => AnalysisRole | 'outside',
  baseSha: string,
  headSha: string,
): Promise<{ impacts: Map<string, BackendFileImpact>; baseRoutes: RouteTable; contracts: { changes: EntryContractChange[]; problem?: string } }> {
  const compared = (f: ChangedFile): boolean => roleOf(f.path) === 'schema' || roleOf(f.path) === 'resolvers'
  const candidates = files.filter((f) => f.status === 'modified' && (compared(f) || (roleOf(f.path) === 'source' && ctx.config.backend.rest && isScriptFile(f.path))))
  const paths = candidates.map((f) => f.path)
  const base = await readFiles(ctx.repoRoot, baseSha, paths)
  const head = await readFiles(ctx.repoRoot, headSha, paths)
  // A file that holds a Hono app in either version: its module code runs for that app's endpoints, also with no handler.
  const holdsInVersion = (path: string, code: string | undefined): boolean => code !== undefined && holdsApp(path, code, table.honoFiles.has(path))
  const appFiles = new Set(paths.filter((p) => ctx.config.backend.rest && isScriptFile(p) && (table.fileHoldsApp(p) || holdsInVersion(p, base.get(p)) || holdsInVersion(p, head.get(p)))))
  const targets = candidates.filter((f) => compared(f) || appFiles.has(f.path))
  const impacts = new Map<string, BackendFileImpact>()
  const addedOperations = new Set<string>()
  // Handlers and mounts the PR adds: the endpoints the head has without them existed before.
  const addedAnchors = new Set<string>()
  const addedMounts: AddedMount[] = []
  for (const f of targets) {
    const before = base.get(f.path)
    const after = head.get(f.path)
    const isCode = !f.path.endsWith('.graphql') && !f.path.endsWith('.gql')
    const schema = diffSdl(fileSchema(f.path, before), fileSchema(f.path, after))
    // Every code file is compared: with no entries left, or with SDL only, its module code is what changed.
    const resolvers: CodeFileChanges | undefined = isCode && before !== undefined && after !== undefined
      ? compareCodeFile(table, { file: f.path, before, after, isSource: roleOf(f.path) === 'source', holdsApp: appFiles.has(f.path), rest: ctx.config.backend.rest })
      : undefined
    for (const k of resolvers?.added ?? []) if (k.includes(' ')) addedAnchors.add(restAnchor(f.path, k))
    for (const m of resolvers?.addedMounts ?? []) addedMounts.push({ ...m, file: f.path })
    const impact = backendFileImpact(table, f.path, schema.added.length + schema.removed.length + schema.changed.length > 0 ? schema : undefined, resolvers)
    // Only files with an app get here with the role `source`.
    impacts.set(f.path, roleOf(f.path) === 'source' ? { ...impact, keepsReach: true } : impact)
    for (const op of impact.addedOperations) addedOperations.add(op)
  }
  // New root fields and endpoints are the backend's new routes: the base table is the head table without them.
  for (const f of files) {
    if (f.status === 'added' && (roleOf(f.path) === 'schema' || roleOf(f.path) === 'resolvers')) {
      const after = (await readFiles(ctx.repoRoot, headSha, [f.path])).get(f.path)
      const schema = diffSdl(null, fileSchema(f.path, after))
      for (const m of schema.added) if (table.rootTypes.has(m.slice(0, m.indexOf('.'))) && m.includes('.')) addedOperations.add(m)
      if (after !== undefined && !f.path.endsWith('.graphql')) {
        const added = resolverEntries(f.path, after, table.typeFields, ctx.config.backend.rest, table.honoFiles.has(f.path))
        for (const e of added.entries) if (e.key.includes(' ')) addedAnchors.add(restAnchor(f.path, e.key))
        for (const m of added.mounts.values()) addedMounts.push({ ...m, file: f.path })
      }
    }
  }
  const baseRest = table.restKeysWithout(new Set(addedMounts.map((m) => m.id)), addedAnchors)
  const addedFiles = new Set(files.filter((f) => f.status === 'added').map((f) => f.path))
  // An entry point named in the configuration is new only with its file: a renamed file stays an existing one.
  const inBase = (r: RouteEntry): boolean => (r.entry !== null ? !addedFiles.has(r.entry) : r.key.includes(' ') ? baseRest.has(r.key) : !addedOperations.has(r.key))
  const baseRoutes = table.operations.filter(inBase)
  return { impacts: mountImpacts(table, addedMounts, baseRest, duplicateEndpoints(impacts, baseRest)), baseRoutes: { routes: baseRoutes, dynamic: [], sources: [] }, contracts: await schemaContracts(ctx, table, files, baseSha) }
}

/**
 * Contract changes of the GraphQL schema: the head schema against the base one, which is the head schema with every
 * changed SDL file in its base version (added files left out, deleted ones put back).
 */
async function schemaContracts(ctx: Context, table: BackendTable, files: readonly ChangedFile[], baseSha: string): Promise<{ changes: EntryContractChange[]; problem?: string }> {
  if (table.schemaDocs.length === 0) return { changes: [] }
  const sdlFile = (p: string): boolean => /\.(graphql|gql|ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p)
  const touched = files.filter((f) => table.schemaFiles.has(f.path) || (f.status !== 'added' && sdlFile(f.oldPath ?? f.path)))
  if (touched.length === 0) return { changes: [] }
  const changed = new Set(touched.flatMap((f) => [f.path, f.oldPath ?? f.path]))
  const base = await readFiles(ctx.repoRoot, baseSha, touched.filter((f) => f.status !== 'added').map((f) => f.oldPath ?? f.path))
  const baseDocs = [...table.schemaDocs.filter((d) => !changed.has(d.file)).map((d) => d.doc), ...[...base].map(([file, code]) => fileSchema(file, code)).filter((d) => d !== null)]
  try {
    return { changes: graphqlContractChanges(baseDocs, table.schemaDocs.map((d) => d.doc)) }
  } catch (error) {
    // A schema graphql-js cannot build (types defined elsewhere, interpolated SDL): no comparison, said so.
    return { changes: [], problem: `GraphQL contracts not compared: ${error instanceof Error ? error.message : String(error)}` }
  }
}
