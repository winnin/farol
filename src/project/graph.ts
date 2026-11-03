import ts from 'typescript'
import { posix } from 'node:path'
import { compareStrings } from '../output/order.js'
import { isProjectPath, toPosix } from './fs.js'
import type { ProjectProgram } from './program.js'
import { isTypeOnlyImport, keepsInlineTypeStatements } from './parse.js'
import { resolveSpecifier, specifierTarget, type Resolution } from './resolve.js'

/**
 * - static: value import, pointing at the module that declares the imported symbol (barrels are skipped)
 * - side-effect: `import "./x"`
 * - dynamic: `import("./x")` with a literal
 * - reexport: `export … from "./x"`
 * - namespace: `import * as ns from "./x"`
 * - asset: import of a non-TS file (CSS, SVG, JSON…)
 * - require: `require("./x")` / `import x = require("./x")`
 * - barrel: importer → barrel it named-imported through. Only followed when the barrel itself changed.
 */
export type EdgeKind = 'static' | 'side-effect' | 'dynamic' | 'reexport' | 'namespace' | 'asset' | 'require' | 'barrel'

export interface GraphEdge {
  from: string
  to: string
  kind: EdgeKind
}

export interface UnresolvedImport {
  file: string
  specifier: string
  line: number
  reason: 'not-found' | 'non-literal'
  /** Repo-relative path the specifier points to (no extension probing), when it points into the repository. */
  target?: string
  /** Repo-relative folders of the workspace package a bare specifier names, when it is in the repository. */
  packages?: string[]
}

export interface ParseError {
  file: string
  line: number
  message: string
}

/** Import graph of the project. Every path is repo-relative with `/`. */
export interface ImportGraph {
  nodes: string[]
  edges: GraphEdge[]
  unresolved: UnresolvedImport[]
  parseErrors: ParseError[]
  /** Modules whose statements are all `export … from`: changes to them may follow barrel edges. */
  reexportOnly: string[]
}

export interface GraphOptions {
  repoRoot: string
  /** Whether imports of this repo-relative file count (tests, stories and excluded files are not callers). */
  isOrigin: (path: string) => boolean
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function isReexportOnly(sf: ts.SourceFile): boolean {
  return sf.statements.length > 0 && sf.statements.every((s) => ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined)
}

class GraphBuilder {
  private readonly nodes = new Set<string>()
  private readonly edges = new Map<string, GraphEdge>()
  private readonly unresolved: UnresolvedImport[] = []
  private readonly checker: ts.TypeChecker
  /** The emitter keeps `import { type A } from "./x"`: `./x` still runs. */
  private readonly keepsInlineTypes: boolean

  constructor(
    private readonly project: ProjectProgram,
    private readonly options: GraphOptions,
  ) {
    this.checker = project.program.getTypeChecker()
    this.keepsInlineTypes = keepsInlineTypeStatements(project.options)
  }

  rel(file: string): string {
    return posix.relative(this.options.repoRoot, toPosix(file))
  }

  isProjectFile(file: string): boolean {
    return isProjectPath(this.options.repoRoot, file)
  }

  addEdge(from: string, to: string, kind: EdgeKind): void {
    if (from === to) return
    this.nodes.add(to)
    this.edges.set(`${from}\0${to}\0${kind}`, { from, to, kind })
  }

  resolve(sf: ts.SourceFile, literal: ts.StringLiteralLike): Resolution {
    const mode = this.project.program.getModeForUsageLocation(sf, literal)
    return resolveSpecifier(this.project, this.options.repoRoot, toPosix(sf.fileName), literal.text, mode)
  }

  /** Adds the edge for a resolved specifier; returns the target module path when it is a program file. */
  link(sf: ts.SourceFile, from: string, literal: ts.StringLiteralLike, kind: EdgeKind): string | undefined {
    const r = this.resolve(sf, literal)
    if (r.kind === 'unresolved') {
      const entry: UnresolvedImport = { file: from, specifier: literal.text, line: lineOf(sf, literal), reason: 'not-found' }
      const target = specifierTarget(this.project, toPosix(sf.fileName), literal.text)
      if (target !== undefined && this.isProjectFile(target)) entry.target = this.rel(target)
      if (r.packages !== undefined) entry.packages = r.packages.map((p) => this.rel(p))
      this.unresolved.push(entry)
      return undefined
    }
    if (r.kind === 'external') return undefined
    const to = this.rel(r.file)
    this.addEdge(from, to, r.kind === 'asset' ? 'asset' : kind)
    return r.kind === 'module' ? to : undefined
  }

  /** Files that declare the symbol a local import binding refers to, following every alias (barrels). */
  declaringFiles(binding: ts.Identifier): string[] | undefined {
    const local = this.checker.getSymbolAtLocation(binding)
    if (!local) return undefined
    const target = local.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(local) : local
    const decls = target.declarations ?? []
    if (decls.length === 0) return undefined
    // An import of a type (interface, type alias) is erased by every emitter: it cannot change runtime behavior.
    // Const enums are inlined at compile time, so their values still count.
    if ((target.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.ConstEnum)) === 0) return []
    const files = new Set<string>()
    for (const d of decls) {
      const file = d.getSourceFile().fileName
      if (!this.isProjectFile(file)) return [] // declared in a package: no project edge
      files.add(this.rel(file))
    }
    return [...files]
  }

  visitImport(sf: ts.SourceFile, from: string, node: ts.ImportDeclaration): void {
    if (!ts.isStringLiteralLike(node.moduleSpecifier)) return
    const clause = node.importClause
    if (!clause) {
      this.link(sf, from, node.moduleSpecifier, 'side-effect')
      return
    }
    if (isTypeOnlyImport(clause)) return
    const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.filter((e) => !e.isTypeOnly) : []
    const namespace = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings : undefined
    const allTypes = clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && named.length === 0
    if (!clause.name && !namespace && allTypes) {
      if (this.keepsInlineTypes) this.link(sf, from, node.moduleSpecifier, 'side-effect')
      return
    }
    const r = this.resolve(sf, node.moduleSpecifier)
    if (r.kind !== 'module') {
      this.link(sf, from, node.moduleSpecifier, 'static')
      return
    }
    const target = this.rel(r.file)
    if (namespace) this.addEdge(from, target, 'namespace')
    const bindings = [...(clause.name ? [clause.name] : []), ...named.map((e) => e.name)]
    if (bindings.length === 0 && !namespace) this.addEdge(from, target, 'side-effect') // `import {} from "./x"`
    for (const binding of bindings) {
      const files = this.declaringFiles(binding)
      if (files === undefined) {
        this.addEdge(from, target, 'static') // the compiler could not follow it: keep the conservative edge
        continue
      }
      for (const file of files) this.addEdge(from, file, 'static')
      if (files.some((f) => f !== target)) this.addEdge(from, target, 'barrel')
    }
  }

  visitExport(sf: ts.SourceFile, from: string, node: ts.ExportDeclaration): void {
    if (!node.moduleSpecifier || !ts.isStringLiteralLike(node.moduleSpecifier) || node.isTypeOnly) return
    const clause = node.exportClause
    if (clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly)) {
      if (this.keepsInlineTypes) this.link(sf, from, node.moduleSpecifier, 'side-effect')
      return
    }
    this.link(sf, from, node.moduleSpecifier, 'reexport')
  }

  visitCalls(sf: ts.SourceFile, from: string): void {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const arg = node.arguments[0]
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (arg && ts.isStringLiteralLike(arg)) this.link(sf, from, arg, 'dynamic')
          else this.unresolved.push({ file: from, specifier: arg ? arg.getText(sf) : '', line: lineOf(sf, node), reason: 'non-literal' })
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && arg && ts.isStringLiteralLike(arg) && node.arguments.length === 1) {
          this.link(sf, from, arg, 'require')
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isMetaProperty(node.expression.expression) &&
          node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
          node.expression.name.text === 'glob'
        ) {
          // Vite's import.meta.glob: the set of modules depends on the file system, not on a literal module path.
          this.unresolved.push({ file: from, specifier: node.getText(sf), line: lineOf(sf, node), reason: 'non-literal' })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  visitFile(sf: ts.SourceFile): void {
    const from = this.rel(sf.fileName)
    this.nodes.add(from)
    if (!this.options.isOrigin(from) || sf.isDeclarationFile) return
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement)) this.visitImport(sf, from, statement)
      else if (ts.isExportDeclaration(statement)) this.visitExport(sf, from, statement)
      else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly && ts.isExternalModuleReference(statement.moduleReference)) {
        const expr = statement.moduleReference.expression
        if (ts.isStringLiteralLike(expr)) this.link(sf, from, expr, 'require')
      }
    }
    this.visitCalls(sf, from)
  }

  build(): ImportGraph {
    const parseErrors: ParseError[] = []
    const reexportOnly: string[] = []
    for (const sf of this.project.program.getSourceFiles()) {
      if (!this.isProjectFile(sf.fileName)) continue
      this.visitFile(sf)
      const rel = this.rel(sf.fileName)
      if (isReexportOnly(sf)) reexportOnly.push(rel)
      for (const d of this.project.program.getSyntacticDiagnostics(sf)) {
        const line = sf.getLineAndCharacterOfPosition(d.start).line + 1
        parseErrors.push({ file: rel, line, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') })
      }
    }
    const edges = [...this.edges.values()].sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.kind, b.kind))
    const unresolved = this.unresolved.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.specifier, b.specifier))
    const uniqueErrors = [...new Map(parseErrors.map((e) => [`${e.file}\0${e.line}\0${e.message}`, e])).values()]
    uniqueErrors.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.message, b.message))
    return { nodes: [...this.nodes].sort(compareStrings), edges, unresolved, parseErrors: uniqueErrors, reexportOnly: reexportOnly.sort(compareStrings) }
  }
}

/** Builds the import graph of a program (pure: everything comes from the program and its file system). */
export function buildImportGraph(project: ProjectProgram, options: GraphOptions): ImportGraph {
  return new GraphBuilder(project, { ...options, repoRoot: toPosix(options.repoRoot) }).build()
}
