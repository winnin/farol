import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import ts from 'typescript'
import type { DeclHelperOutput } from '../decls/types.js'
import { routeAnchors } from '../classify/reach.js'
import type { RouteTable } from '../routes/types.js'
import { isProjectPath } from './fs.js'
import { codeTokens, parseIsolated } from './parse.js'
import type { ProjectProgram } from './program.js'

type Decl = DeclHelperOutput['decls'][number]

/** Hash of a node's tokens: equal hashes mean the same code. */
function tokenHash(sf: ts.SourceFile, node: ts.Node): string {
  return createHash('sha1').update(codeTokens(node, sf).join('\0')).digest('hex').slice(0, 16)
}

const isTypeDecl = (s: ts.Node): boolean => ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)

function nameOf(node: ts.Node): string | undefined {
  const n = (node as { name?: ts.Node }).name
  return n !== undefined && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) ? n.text : undefined
}

/**
 * Top-level declarations of a module, as [id suffix, kind, node]: functions, classes (header; methods apart),
 * variables, enums, types (erased: kind "type") and the remaining module-level code.
 */
export function moduleDecls(sf: ts.SourceFile): { name: string; kind: string; node: ts.Node; owner?: string }[] {
  const out: { name: string; kind: string; node: ts.Node; owner?: string }[] = []
  const code: ts.Statement[] = []
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s) || (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined)) continue
    if (ts.isFunctionDeclaration(s)) out.push({ name: s.name?.text ?? 'default', kind: 'func', node: s })
    else if (ts.isClassDeclaration(s)) {
      const cls = s.name?.text ?? 'default'
      out.push({ name: cls, kind: 'class', node: s })
      for (const m of s.members) {
        const name = nameOf(m)
        if (name !== undefined && (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m) || ts.isConstructorDeclaration(m) || (ts.isPropertyDeclaration(m) && m.initializer !== undefined && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))))) {
          out.push({ name: `${cls}.${name}`, kind: 'method', node: m, owner: cls })
        } else if (ts.isConstructorDeclaration(m)) out.push({ name: `${cls}.constructor`, kind: 'method', node: m, owner: cls })
      }
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, kind: 'var', node: d })
        else code.push(s)
      }
    } else if (ts.isEnumDeclaration(s)) out.push({ name: s.name.text, kind: 'var', node: s })
    else if (isTypeDecl(s)) out.push({ name: (s as ts.InterfaceDeclaration).name.text, kind: 'type', node: s })
    else if (ts.isModuleDeclaration(s) && s.name.kind === ts.SyntaxKind.Identifier) out.push({ name: s.name.text, kind: 'var', node: s })
    else code.push(s)
  }
  if (code.length > 0) out.push({ name: '<module>', kind: 'module', node: code[0] as ts.Node })
  return out
}

/** Hash of a declaration; module-level code hashes every statement that is not a declaration. */
function declHash(sf: ts.SourceFile, d: { kind: string; node: ts.Node }): string {
  if (d.kind !== 'module') {
    // A class keeps its header and fields: method bodies are their own declarations.
    if (ts.isClassDeclaration(d.node)) {
      const parts = [d.node.name?.text ?? '', ...(d.node.heritageClauses ?? []).map((h) => tokenHash(sf, h)), ...d.node.members.filter((m) => !ts.isMethodDeclaration(m) && !ts.isConstructorDeclaration(m) && !ts.isGetAccessor(m) && !ts.isSetAccessor(m)).map((m) => tokenHash(sf, m))]
      return createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16)
    }
    return tokenHash(sf, ts.isVariableDeclaration(d.node) ? d.node.parent.parent : d.node).concat(ts.isVariableDeclaration(d.node) ? `:${d.node.name.getText(sf)}` : '')
  }
  const names = new Set(moduleDecls(sf).filter((x) => x.kind !== 'module').map((x) => (ts.isVariableDeclaration(x.node) ? x.node.parent.parent : x.node)))
  const code = sf.statements.filter((s) => !names.has(s) && !ts.isImportDeclaration(s) && !(ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined))
  return createHash('sha1').update(code.map((s) => tokenHash(sf, s)).join('\0')).digest('hex').slice(0, 16)
}

function toDecl(sf: ts.SourceFile, file: string, d: { name: string; kind: string; node: ts.Node }): Decl {
  const start = sf.getLineAndCharacterOfPosition(d.node.getStart(sf)).line + 1
  const end = sf.getLineAndCharacterOfPosition(d.node.end).line + 1
  const hash = declHash(sf, d)
  return { id: `${file}#${d.name}`, file, line: start, end, kind: d.kind, hash, core: hash }
}

/** Declarations of a base file, from its text alone (no type checking): enough to compare hashes. */
export function baseDecls(file: string, code: string): Decl[] {
  const { sourceFile: sf } = parseIsolated(file, code)
  return moduleDecls(sf).map((d) => toDecl(sf, file, d))
}

export interface TsDeclInput {
  project: ProjectProgram
  repoRoot: string
  /** Whether a repo-relative file counts (tests, stories, excluded and outside-project files do not). */
  isOrigin: (path: string) => boolean
  routes: RouteTable
}

/**
 * Declaration graph of the head program: references resolved with the type checker (through imports, re-exports,
 * property accesses and JSX), types left out (erased). Entry points are the routes, anchored on the declarations of
 * their modules (entry, wrappers, layouts).
 */
export function tsDeclGraph(input: TsDeclInput): DeclHelperOutput {
  const root = input.repoRoot.replaceAll('\\', '/')
  const rel = (f: string): string => posix.relative(root, f.replaceAll('\\', '/'))
  const isProject = (f: string): boolean => isProjectPath(root, f) && input.isOrigin(rel(f))
  const checker = input.project.program.getTypeChecker()
  const decls: Decl[] = []
  const nodes: { node: ts.Node; sf: ts.SourceFile; kind: string; owner?: number }[] = []
  const byNode = new Map<ts.Node, number>()
  const files: string[] = []
  for (const sf of input.project.program.getSourceFiles()) {
    if (sf.isDeclarationFile || !isProject(sf.fileName)) continue
    const file = rel(sf.fileName)
    files.push(file)
    const classIndex = new Map<string, number>()
    for (const d of moduleDecls(sf)) {
      byNode.set(d.node, decls.length)
      if (d.kind === 'class') classIndex.set(d.name, decls.length)
      nodes.push({ node: d.node, sf, kind: d.kind, ...(d.owner !== undefined ? { owner: classIndex.get(d.owner) ?? -1 } : {}) })
      decls.push(toDecl(sf, file, d))
    }
    if (decls.length > 0 && moduleDecls(sf).some((d) => d.kind === 'module')) {
      // Every statement that is module-level code maps to the <module> declaration.
      const moduleIndex = decls.findIndex((d) => d.id === `${file}#<module>`)
      const named = new Set(moduleDecls(sf).filter((x) => x.kind !== 'module').map((x) => (ts.isVariableDeclaration(x.node) ? x.node.parent.parent : x.node)))
      for (const s of sf.statements) if (!named.has(s) && !ts.isImportDeclaration(s)) byNode.set(s, moduleIndex)
    }
  }
  /** Declaration index of the top-level declaration (or class member) containing a node. */
  const ownerOf = (node: ts.Node): number | undefined => {
    for (let n = node; ; n = n.parent) {
      const i = byNode.get(n)
      if (i !== undefined) return i
      if (ts.isSourceFile(n)) return undefined
    }
  }
  const edges = new Set<string>()
  const called = new Set<number>()
  nodes.forEach((d, i) => {
    if (d.kind === 'type') return
    // Module-level code is every statement mapped to the <module> declaration, not only the first one.
    const roots = d.kind === 'module' ? d.sf.statements.filter((s) => byNode.get(s) === i) : [d.node]
    const visit = (n: ts.Node): void => {
      if (ts.isTypeNode(n) || isTypeDecl(n) || ts.isHeritageClause(n) && n.token === ts.SyntaxKind.ImplementsKeyword) return
      // Methods are their own declarations: a class does not run its methods' bodies.
      if (n !== d.node && byNode.has(n) && d.kind === 'class') return
      if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
        let symbol = ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n)
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
        for (const decl of symbol?.declarations ?? []) {
          if (decl.getSourceFile().isDeclarationFile || !isProject(decl.getSourceFile().fileName)) continue
          const target = ownerOf(decl)
          if (target === undefined || target === i || nodes[target]?.kind === 'type') continue
          edges.add(`${i},${target}`)
          called.add(target)
        }
      }
      ts.forEachChild(n, visit)
    }
    for (const r of roots) visit(r)
  })
  // Like Go: a method nothing in the project calls can only run through a framework (React lifecycle, a library).
  nodes.forEach((d, i) => {
    if (d.kind === 'method' && d.owner !== undefined && d.owner >= 0 && !called.has(i)) edges.add(`${d.owner},${i}`)
  })
  const fileDecls = new Map<string, number[]>()
  decls.forEach((d, i) => fileDecls.set(d.file, [...(fileDecls.get(d.file) ?? []), i]))
  // A route module anchors its own declarations and everything it exports, through re-exports and barrels
  // (`export { AppLayout } from './app-layout'` has no declaration of its own).
  const sourceOf = new Map(input.project.program.getSourceFiles().map((sf) => [rel(sf.fileName), sf]))
  const fileAnchors = (file: string): number[] => {
    const own = fileDecls.get(file) ?? []
    const sf = sourceOf.get(file)
    const moduleSymbol = sf ? checker.getSymbolAtLocation(sf) : undefined
    if (!moduleSymbol) return own
    const exported = checker.getExportsOfModule(moduleSymbol).flatMap((sym) => {
      const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
      return (target.declarations ?? []).filter((d) => isProject(d.getSourceFile().fileName)).flatMap((d) => {
        const owner = ownerOf(d)
        return owner === undefined ? [] : [owner]
      })
    })
    return [...new Set([...own, ...exported])]
  }
  const entries = input.routes.routes.map((r) => ({ key: r.key, file: r.entry ?? '', line: 1, kind: 'http' as const, anchors: routeAnchors(r).flatMap((f) => fileAnchors(f)), inline: '' }))
  return {
    module: '',
    files: files.sort(),
    decls,
    edges: [...edges].map((e) => e.split(',').map(Number) as [number, number]),
    entries,
    problems: [],
    comments: [],
  }
}
