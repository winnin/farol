import type { Output } from '../output/schema.js'
import type { Linker } from './links.js'
import { changedRoutes, type ChangedRoute } from './route-graph.js'
import { HTML_TEXT as T, USAGE_TEXT as U, terms, type Terms } from './strings.js'
import { fileOfEntryKey } from './test-plan.js'
import { compactNumber } from './usage.js'

/** What the routes section needs from the page renderer (implemented by the Html class of html.ts). */
export interface RoutesRenderer {
  /** Traffic and distinct errors by entry point key (usage report), with its unit; empty without one. */
  traffic?: { hits: ReadonlyMap<string, number>; errors: ReadonlyMap<string, number>; links: ReadonlyMap<string, string>; kind: 'pages' | 'operations' }
  path(p: string): string
  shortPath(p: string): string
  shortKey(key: string): string
}

const MAX_ROWS = 200
const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const

function esc(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function riskChip(risk: ChangedRoute['risk']): string {
  return risk ? `<span class="chip ${risk}" title="${esc(T.routeRiskTitle)}">${T.severity[risk]}</span>` : ''
}

function routeRow(r: ChangedRoute, h: RoutesRenderer, label: string, showKey: boolean): string {
  const key = showKey ? `<span class="muted small route-key">${esc(h.shortKey(r.key))}</span>` : ''
  // data-files lets the "reviewed files" filter hide what is already reviewed.
  const hits = h.traffic?.hits.get(r.key)
  const issues = h.traffic?.errors.get(r.key) ?? 0
  const link = h.traffic?.links.get(r.key)
  const errors = issues === 0 ? '' : link === undefined ? `, ${esc(U.distinct(issues))}` : `, <a class="dd-link" href="${esc(link)}" target="_blank" rel="noopener" title="${esc(U.openInDatadog)}">${esc(U.distinct(issues))} ↗</a>`
  const traffic = hits === undefined || !h.traffic ? '' : `<span class="chip traffic">${esc(U.hits(compactNumber(hits), h.traffic.kind))}${errors}</span>`
  return `<details class="route" data-files="${esc(r.files.join('|'))}"><summary title="${esc(r.key)}"><span class="tag ${r.kind}">${T.routeKinds[r.kind]}</span><code class="route-path">${esc(label)}</code>${key}${traffic}<span class="small route-files" data-total="${r.files.length}">${esc(T.routeFiles(r.files.length))}</span>${riskChip(r.risk)}</summary>
<div class="route-body">${r.chains.length > 0 ? `<div class="fs-target graph-wrap"><button type="button" class="fullscreen" title="${esc(T.fullscreenTitle)}">${T.fullscreen}</button><pre class="mermaid">${esc(r.mermaid)}</pre></div><p class="muted small diagram-note">${T.diagramNote}</p>` : `<p class="muted small">${T.noEntry}</p>`}</div></details>`
}

/** Paths shared by several routes of the list: only for them is the key worth showing. */
function sharedPaths(routes: readonly ChangedRoute[]): Set<string> {
  return new Set(routes.filter((r, i) => routes.findIndex((o) => o.path === r.path) !== i).map((r) => r.path))
}

function routeRows(list: readonly ChangedRoute[], h: RoutesRenderer): string {
  // With traffic, the busiest entry points come first (stable: the others keep their order).
  const hits = h.traffic?.hits
  const routes = hits && hits.size > 0 ? [...list].sort((a, b) => (hits.get(b.key) ?? -1) - (hits.get(a.key) ?? -1)) : list
  const more = routes.length > MAX_ROWS ? `<p class="muted">${T.more(routes.length - MAX_ROWS)}</p>` : ''
  const shared = sharedPaths(routes)
  return `<div class="routes-list">${routes.slice(0, MAX_ROWS).map((r) => routeRow(r, h, r.path, shared.has(r.path))).join('\n')}</div>${more}`
}

/** URL segments of a page path. */
export function urlSegments(path: string): string[] {
  return path.split('/').filter((s) => s !== '')
}

/** Tree segments of a backend operation: `Query.getBrand` → Query › getBrand, `GET /a/b` → GET › a › b, `api GET /a` → api › GET › a. */
export function backendSegments(path: string): string[] {
  const parts = path.split(' ')
  const file = fileOfEntryKey(path)
  if (file !== null) return [parts[0] ?? '', ...urlSegments(file)]
  // `orders_api GET /orders`: several services in one repository label their routes with the service.
  if (parts.length >= 3) return [parts[0] ?? '', parts[1] ?? '', ...urlSegments(parts.slice(2).join(' '))]
  if (parts.length === 2) return [parts[0] ?? '', ...urlSegments(parts[1] ?? '')]
  return path.split('.')
}

/** A node of the module tree: one URL segment (or several merged), the pages at this path and the sub-modules. */
export interface TreeNode {
  label: string
  pages: ChangedRoute[]
  children: TreeNode[]
}

/** Groups pages by URL segments; segments with no page of their own and a single child are merged (`w/:id`). */
export function buildRouteTree(pages: readonly ChangedRoute[], segmentsOf: (path: string) => string[] = urlSegments): TreeNode {
  const root: TreeNode = { label: '/', pages: [], children: [] }
  for (const page of pages) {
    let node = root
    for (const segment of segmentsOf(page.path)) {
      let child = node.children.find((c) => c.label === segment)
      if (!child) {
        child = { label: segment, pages: [], children: [] }
        node.children.push(child)
      }
      node = child
    }
    node.pages.push(page)
  }
  const compress = (node: TreeNode): TreeNode => {
    let current = node
    while (current.pages.length === 0 && current.children.length === 1 && current !== root) {
      const only = current.children[0] as TreeNode
      current = { label: `${current.label}/${only.label}`, pages: only.pages, children: only.children }
    }
    return { ...current, children: current.children.map(compress) }
  }
  return compress(root)
}

function countPages(node: TreeNode): number {
  return node.pages.length + node.children.reduce((n, c) => n + countPages(c), 0)
}

function maxRisk(node: TreeNode): ChangedRoute['risk'] {
  const all = [...node.pages.map((p) => p.risk), ...node.children.map(maxRisk)].filter((r) => r !== null)
  return all.sort((a, b) => RISK_ORDER[a] - RISK_ORDER[b])[0] ?? null
}

function renderTree(node: TreeNode, h: RoutesRenderer, depth: number, t: Terms): string {
  const shared = sharedPaths(node.pages)
  const pages = node.pages.map((p) => routeRow(p, h, p.path, shared.has(p.path))).join('\n')
  const children = node.children.map((c) => renderTree(c, h, depth + 1, t)).join('\n')
  if (depth === 0) return `<div class="tree">${pages}${children}</div>`
  // A leaf with a single page is that page: no module wrapper around it.
  if (node.children.length === 0 && node.pages.length === 1) return pages
  // Top-level modules start open; deeper modules start closed so the tree reads like a table of contents.
  return `<details class="tree-node"${depth === 1 ? ' open' : ''}><summary><span class="tree-label">${esc(node.label)}</span><span class="muted small tree-count" data-one="${esc(t.one)}" data-many="${esc(t.many)}">${esc(T.treePages(countPages(node), t))}</span>${riskChip(maxRisk(node))}</summary><div class="tree-children">${pages}${children}</div></details>`
}

/**
 * Pages (routes without children) the PR changes, as a list or as a tree of modules (URL segments); opening a page
 * draws its import graph (Mermaid). Layout routes, which wrap pages and already appear in their graphs, are grouped
 * below, collapsed.
 */
export function routesSection(o: Output, h: RoutesRenderer, links: Linker): string {
  const t = terms(o.surface)
  const routes = changedRoutes(o, links, (p) => h.shortPath(p))
  const pages = routes.filter((r) => !r.hasChildren)
  const layouts = routes.filter((r) => r.hasChildren)
  const count = (kind: ChangedRoute['kind']) => pages.filter((r) => r.kind === kind).length
  const legend = `<div class="legend"><span class="lg lg-route">${t.one}</span><span class="lg lg-module">${T.legend.module}</span><span class="lg lg-changed">${T.legend.changed}</span><span class="lg lg-added">${T.legend.added}</span><span class="lg lg-high">${T.legend.high}</span><span class="lg lg-medium">${T.legend.medium}</span><span class="muted small">${T.legend.arrow}</span></div>`
  const views =
    pages.length === 0
      ? `<p class="muted">${T.noneFound}</p>`
      : `<p class="small muted">${T.routesIntro(t)}</p>${legend}
<input type="radio" name="routes-view" id="routes-view-list" class="view-input" checked><input type="radio" name="routes-view" id="routes-view-tree" class="view-input">
<div class="view-switch"><label for="routes-view-list">${T.viewList}</label><label for="routes-view-tree">${T.viewTree}</label></div>
<div class="view view-list">${routeRows(pages, h)}</div><div class="view view-tree">${renderTree(buildRouteTree(pages, o.surface === 'backend' ? backendSegments : urlSegments), h, 0, t)}</div>`
  const layoutBlock = layouts.length > 0 ? `<details class="layouts"><summary>${T.layoutsTitle(layouts.length)}</summary><p class="small muted">${T.layoutsIntro}</p>${routeRows(layouts, h)}</details>` : ''
  const disconnected = o.routes.disconnectedNewFiles.length > 0 ? `<h3>${T.disconnectedTitle}</h3><div class="finding-files">${o.routes.disconnectedNewFiles.map((p) => h.path(p)).join('')}</div>` : ''
  return `<section class="panel"><h3>${T.changedRoutesTitle(`<span id="routes-affected">${count('affected')}</span>`, count('added'), t)}</h3>${views}${layoutBlock}${disconnected}</section>`
}
