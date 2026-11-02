import { Kind, parse, print, visit, type ASTNode, type DefinitionNode, type DocumentNode, type TypeNode } from 'graphql'
import ts from 'typescript'
import { compareStrings } from '../output/order.js'
import { parseIsolated } from '../project/parse.js'

/** A piece of SDL and where it comes from: a .graphql file, or a gql`…` template in a TS/JS file. */
export interface SdlSource {
  file: string
  /** 1-based line of the start of the SDL in the file (for templates). */
  line: number
  sdl: string
}

export interface SdlProblem {
  file: string
  line: number
  detail: string
}

export const GQL_TAGS: ReadonlySet<string> = new Set(['gql', 'graphql'])

/** SDL sources of a file: the whole file for .graphql/.gql, every gql`…`/graphql`…` template otherwise. */
export function sdlSources(file: string, code: string): { sources: SdlSource[]; problems: SdlProblem[] } {
  if (file.endsWith('.graphql') || file.endsWith('.gql')) return { sources: [{ file, line: 1, sdl: code }], problems: [] }
  const sources: SdlSource[] = []
  const problems: SdlProblem[] = []
  if (!code.includes('gql') && !code.includes('graphql')) return { sources, problems }
  const { sourceFile: sf } = parseIsolated(file, code)
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && GQL_TAGS.has(node.tag.text)) {
      const line = sf.getLineAndCharacterOfPosition(node.template.getStart(sf)).line + 1
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) sources.push({ file, line, sdl: node.template.text })
      else {
        // Interpolated fragments cannot be read statically; the literal parts still are.
        problems.push({ file, line, detail: 'gql template with interpolations: only its literal parts are read' })
        sources.push({ file, line, sdl: [node.template.head.text, ...node.template.templateSpans.map((s) => s.literal.text)].join('\n') })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { sources, problems }
}

/** Parses SDL; queries and fragments in the same templates are ignored (only type system definitions count). */
export function parseSdl(source: SdlSource): { doc: DocumentNode | null; problem?: SdlProblem } {
  try {
    return { doc: parse(source.sdl, { noLocation: false }) }
  } catch (error) {
    return { doc: null, problem: { file: source.file, line: source.line, detail: `invalid GraphQL: ${error instanceof Error ? error.message : String(error)}` } }
  }
}

function namedType(type: TypeNode): string {
  return type.kind === Kind.NAMED_TYPE ? type.name.value : namedType(type.type)
}

/** The type system of the whole project, enough to know which operations can reach which types. */
export interface SchemaGraph {
  /** Root operation type names (Query, Mutation, Subscription or the ones declared in `schema { … }`). */
  roots: { query: string; mutation: string; subscription: string }
  /** type name → field name → named return type. */
  fields: Map<string, Map<string, string>>
  /** union / interface name → possible object types. */
  possible: Map<string, Set<string>>
  /** Where each type field is declared (for messages). */
  declaredIn: Map<string, string>
  /** Enum type names. */
  enums: Set<string>
}

export function buildSchemaGraph(docs: readonly { doc: DocumentNode; file: string }[]): SchemaGraph {
  const roots = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' }
  const fields = new Map<string, Map<string, string>>()
  const possible = new Map<string, Set<string>>()
  const declaredIn = new Map<string, string>()
  const enums = new Set<string>()
  const addPossible = (abstract: string, concrete: string): void => {
    const set = possible.get(abstract) ?? new Set<string>()
    set.add(concrete)
    possible.set(abstract, set)
  }
  for (const { doc, file } of docs) {
    for (const def of doc.definitions) {
      if (def.kind === Kind.SCHEMA_DEFINITION || def.kind === Kind.SCHEMA_EXTENSION) {
        for (const op of def.operationTypes ?? []) roots[op.operation] = op.type.name.value
      }
      if (def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION || def.kind === Kind.INTERFACE_TYPE_DEFINITION || def.kind === Kind.INTERFACE_TYPE_EXTENSION) {
        const map = fields.get(def.name.value) ?? new Map<string, string>()
        for (const f of def.fields ?? []) {
          map.set(f.name.value, namedType(f.type))
          declaredIn.set(`${def.name.value}.${f.name.value}`, file)
        }
        fields.set(def.name.value, map)
        for (const i of def.interfaces ?? []) addPossible(i.name.value, def.name.value)
      }
      if (def.kind === Kind.ENUM_TYPE_DEFINITION || def.kind === Kind.ENUM_TYPE_EXTENSION) enums.add(def.name.value)
      if (def.kind === Kind.UNION_TYPE_DEFINITION || def.kind === Kind.UNION_TYPE_EXTENSION) for (const t of def.types ?? []) addPossible(def.name.value, t.name.value)
    }
  }
  return { roots, fields, possible, declaredIn, enums }
}

export interface Operation {
  /** `Query.getBrand` */
  key: string
  kind: 'query' | 'mutation' | 'subscription'
  field: string
  /** Every type the operation can return, through fields, unions and interfaces (its own root type excluded). */
  reachableTypes: Set<string>
}

/** Root operations and the types each one can reach. */
export function operationsOf(schema: SchemaGraph): Operation[] {
  const reach = (start: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [start]
    while (stack.length > 0) {
      const t = stack.pop() ?? ''
      if (seen.has(t)) continue
      seen.add(t)
      for (const p of schema.possible.get(t) ?? []) stack.push(p)
      for (const r of schema.fields.get(t)?.values() ?? []) stack.push(r)
    }
    return seen
  }
  const ops: Operation[] = []
  for (const kind of ['query', 'mutation', 'subscription'] as const) {
    const root = schema.roots[kind]
    for (const [field, returns] of schema.fields.get(root) ?? []) ops.push({ key: `${root}.${field}`, kind, field, reachableTypes: reach(returns) })
  }
  return ops.sort((a, b) => compareStrings(a.key, b.key))
}

export interface SchemaDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

/** Comparable signature of every definition member: `Type.field` → printed field (type, arguments, directives). */
function members(input: DocumentNode | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!input) return out
  // Descriptions are documentation: changing them changes no behavior.
  const doc = visit(input, {
    enter(node: ASTNode) {
      return 'description' in node && node.description ? { ...node, description: undefined } : undefined
    },
  })
  const typeName = (def: DefinitionNode): string | undefined => ('name' in def && def.name ? def.name.value : undefined)
  for (const def of doc.definitions) {
    const name = typeName(def)
    if (name === undefined) continue
    if ('fields' in def && def.fields) for (const f of def.fields) out.set(`${name}.${f.name.value}`, print(f))
    else if ('values' in def && def.values) for (const v of def.values) out.set(`${name}.${v.name.value}`, print(v))
    else if ('types' in def && def.types) for (const t of def.types) out.set(`${name}|${t.name.value}`, t.name.value)
    else out.set(name, print(def))
    if ('interfaces' in def && def.interfaces) for (const i of def.interfaces) out.set(`${name}&${i.name.value}`, i.name.value)
  }
  return out
}

/** What one SDL file (or the SDL of one TS/JS file) adds, removes and changes between base and head. */
export function diffSdl(base: DocumentNode | null, head: DocumentNode | null): SchemaDiff {
  const before = members(base)
  const after = members(head)
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [key, value] of before) {
    const now = after.get(key)
    if (now === undefined) removed.push(key)
    else if (now !== value) changed.push(key)
  }
  for (const key of after.keys()) if (!before.has(key)) added.push(key)
  return { added: added.sort(compareStrings), removed: removed.sort(compareStrings), changed: changed.sort(compareStrings) }
}
