import { z } from 'zod'
import { ContractSchema } from '../contracts/types.js'

const line = z.number().int().nonnegative()

/**
 * JSON printed by the language helpers (go-helper/ for Go, py-helper/ for Python): one shape for both. Paths are repo-relative with `/`. Entry `inline`: hashes of
 * handler/middleware function literals written in place (their code is not an anchor).
 */
export const DeclHelperSchema = z.object({
  module: z.string(),
  /** Every source file the helper read (tests not included). */
  files: z.array(z.string()),
  /**
   * Top-level declarations; `hash` covers their tokens without comments or formatting, `core` the same without route
   * registration calls (routes are compared entry by entry).
   */
  decls: z.array(z.object({ id: z.string(), file: z.string(), line, end: line, kind: z.string(), hash: z.string(), core: z.string() })),
  /** [from, to]: declaration `from` uses declaration `to` (indices into decls). */
  edges: z.array(z.tuple([z.number().int(), z.number().int()])),
  entries: z.array(
    z.object({
      key: z.string(),
      file: z.string(),
      line,
      kind: z.enum(['http', 'ws', 'rpc', 'tool', 'task', 'main']),
      anchors: z.array(z.number().int()),
      inline: z.string(),
      /** What the endpoint receives and returns, when the helper can read it (FastAPI, Go handlers, gRPC). */
      contract: ContractSchema.optional(),
      /** The path (or a prefix of it) is computed at run time: the key holds the expression in braces; where each part is computed. */
      computed: z.array(z.object({ file: z.string(), line })).optional(),
    }),
  ),
  problems: z.array(z.object({ file: z.string(), line, kind: z.enum(['type-error', 'parse-error', 'dynamic-route']), detail: z.string() })),
  comments: z.array(z.object({ file: z.string(), line, text: z.string() })),
  /**
   * Per file, what declaration hashes leave out, as sorted entries: "bind <name> <source…>" for each name an import
   * binds, "effect …" for side-effect and re-export imports, compiler directives and comments that change emitted code.
   */
  headers: z.record(z.string(), z.array(z.string())).optional(),
})

export type DeclHelperOutput = z.infer<typeof DeclHelperSchema>
export type Decl = DeclHelperOutput['decls'][number]
export type Entry = DeclHelperOutput['entries'][number]
