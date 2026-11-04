"""Top-level declarations of the project, a hash of their code, and the references between them."""

from __future__ import annotations

import ast
import builtins
import copy
import hashlib
from dataclasses import dataclass, field

from .modules import Module
from .typing_infer import class_attribute_types, local_types

BUILTINS = set(dir(builtins))
REGISTRATION_ATTRS = {"get", "post", "put", "patch", "delete", "head", "options", "trace", "api_route", "websocket", "route"}
REGISTRATION_CALLS = {"include_router", "add_api_route", "add_api_websocket_route", "add_route", "mount"}
MODULE_CODE = "<module>"
MAIN_CODE = "<main>"


def file_header(tree: ast.Module) -> list[str]:
    """What declarations leave out (see src/project/decls.ts): the name each module-level import binds
    ("bind <name> <module> <imported>"), and star imports ("effect …")."""
    out: list[str] = []
    for stmt in tree.body:
        if isinstance(stmt, ast.Import):
            for alias in stmt.names:
                out.append(f"bind {alias.asname or alias.name.split('.')[0]} {alias.name} *")
        elif isinstance(stmt, ast.ImportFrom):
            module = "." * stmt.level + (stmt.module or "")
            for alias in stmt.names:
                out.append(f"effect from {module} import *" if alias.name == "*" else f"bind {alias.asname or alias.name} {module} {alias.name}")
    return sorted(out)


def is_main_guard(stmt: ast.stmt) -> bool:
    """`if __name__ == "__main__":` — code that runs only when the file is executed as a script."""
    if not isinstance(stmt, ast.If) or not isinstance(stmt.test, ast.Compare):
        return False
    parts = [stmt.test.left, *stmt.test.comparators]
    return any(isinstance(p, ast.Name) and p.id == "__name__" for p in parts) and any(isinstance(p, ast.Constant) and p.value == "__main__" for p in parts)


def is_registration_decorator(dec: ast.expr) -> bool:
    return isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.func.attr in REGISTRATION_ATTRS


def is_registration_statement(stmt: ast.stmt) -> bool:
    return isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Attribute) and stmt.value.func.attr in REGISTRATION_CALLS


def strip_docstring(body: list[ast.stmt]) -> list[ast.stmt]:
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        return body[1:]
    return body


class _Normalize(ast.NodeTransformer):
    """Docstrings are documentation; for the core hash, route registrations are compared route by route instead."""

    def __init__(self, core: bool, drop_methods: bool):
        self.core = core
        self.drop_methods = drop_methods
        self.depth = 0

    def _body(self, node):
        node.body = strip_docstring(node.body)
        if self.core:
            node.body = [s for s in node.body if not is_registration_statement(s)]
        return node

    def visit_FunctionDef(self, node):
        if self.core:
            node.decorator_list = [d for d in node.decorator_list if not is_registration_decorator(d)]
        self._body(node)
        return self.generic_visit(node)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self._body(node)
        if self.drop_methods and self.depth == 0:
            # Methods are declarations of their own: the class keeps its header, attributes and nested classes.
            node.body = [s for s in node.body if not isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef))]
        self.depth += 1
        node = self.generic_visit(node)
        self.depth -= 1
        return node

    def visit_Assign(self, node):
        # Django's urlpatterns is a list of route registrations, compared route by route.
        if self.core and any(isinstance(t, ast.Name) and t.id == "urlpatterns" for t in node.targets):
            node.value = ast.List(elts=[], ctx=ast.Load())
        return self.generic_visit(node)

    def visit_Module(self, node):
        self._body(node)
        return self.generic_visit(node)


def digest(node: ast.AST, core: bool) -> str:
    tree = _Normalize(core, isinstance(node, ast.ClassDef)).visit(copy.deepcopy(node))
    return hashlib.sha1(ast.dump(tree, include_attributes=False).encode()).hexdigest()[:16]


@dataclass
class Decl:
    id: str
    file: str
    line: int
    end: int
    kind: str
    hash: str
    core: str
    module: Module = field(repr=False)
    node: ast.AST = field(repr=False)
    owner: str | None = None  # class id of a method


class Graph:
    def __init__(self, modules: dict[str, Module]):
        self.modules = modules
        self.decls: list[Decl] = []
        self.by_id: dict[str, int] = {}
        self.edges: set[tuple[int, int]] = set()
        self.methods_by_name: dict[str, list[int]] = {}
        self.class_bases: dict[str, list[ast.expr]] = {}
        self.class_of: dict[str, Module] = {}
        self.attr_types: dict[str, dict[str, str]] = {}

    def add(self, module: Module, id_: str, kind: str, node: ast.AST, owner: str | None = None) -> int:
        if id_ in self.by_id:
            id_ = f"{id_}#{len(self.decls)}"
        line = getattr(node, "lineno", 1)
        end = getattr(node, "end_lineno", line) or line
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.decorator_list:
            line = min(line, *(d.lineno for d in node.decorator_list))
        self.decls.append(Decl(id_, module.file, line, end, kind, digest(node, False), digest(node, True), module, node, owner))
        self.by_id[id_] = len(self.decls) - 1
        return len(self.decls) - 1

    def collect(self) -> None:
        for module in self.modules.values():
            if module.tree is None:
                continue
            code: list[ast.stmt] = []
            for stmt in strip_docstring(module.tree.body):
                if is_main_guard(stmt):
                    # Not import-time code: it belongs to the script entry point only.
                    self.add(module, f"{module.name}.{MAIN_CODE}", "main", stmt)
                elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    self.add(module, f"{module.name}.{stmt.name}", "func", stmt)
                elif isinstance(stmt, ast.ClassDef):
                    cid = f"{module.name}.{stmt.name}"
                    self.add(module, cid, "class", stmt)
                    self.class_bases[cid] = list(stmt.bases)
                    self.class_of[cid] = module
                    for item in stmt.body:
                        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            i = self.add(module, f"{cid}.{item.name}", "method", item, owner=cid)
                            if not item.name.startswith("__"):
                                self.methods_by_name.setdefault(item.name, []).append(i)
                elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
                    continue
                elif isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                    names = assigned_names(stmt)
                    if not names:
                        code.append(stmt)
                    for name in names:
                        self.add(module, f"{module.name}.{name}", "var", stmt)
                else:
                    code.append(stmt)
            if code:
                body = ast.Module(body=code, type_ignores=[])
                body.lineno, body.end_lineno = code[0].lineno, code[-1].end_lineno  # type: ignore[attr-defined]
                self.add(module, f"{module.name}.{MODULE_CODE}", "module", body)

    # --- name resolution -------------------------------------------------------------------------------------------

    def resolve_dotted(self, dotted: str, depth: int = 0) -> list[int]:
        if depth > 6 or not dotted:
            return []
        if dotted in self.by_id:
            return [self.by_id[dotted]]
        if dotted in self.modules:
            return self.lookup(f"{dotted}.{MODULE_CODE}")
        parts = dotted.split(".")
        for cut in range(len(parts) - 1, 0, -1):
            prefix = ".".join(parts[:cut])
            module = self.modules.get(prefix)
            if module is None:
                continue
            first, rest = parts[cut], parts[cut + 1 :]
            candidate = f"{prefix}.{first}"
            if candidate in self.by_id:
                found = [self.by_id[candidate]]
                if rest and self.decls[found[0]].kind == "class":
                    return found + self.member(candidate, rest[0])
                return found + [m for r in rest for m in self.by_name(r)]
            if first in module.imports:
                return self.resolve_dotted(".".join([module.imports[first], *rest]), depth + 1)
            return []
        return []

    def lookup(self, id_: str) -> list[int]:
        return [self.by_id[id_]] if id_ in self.by_id else []

    def by_name(self, attr: str) -> list[int]:
        """An attribute of a value of unknown type: every project method with that name (conservative)."""
        return [] if attr.startswith("__") else self.methods_by_name.get(attr, [])

    def member(self, class_id: str, attr: str, seen: set[str] | None = None) -> list[int]:
        seen = seen or set()
        if class_id in seen:
            return []
        seen.add(class_id)
        if f"{class_id}.{attr}" in self.by_id:
            return [self.by_id[f"{class_id}.{attr}"]]
        for base in self.class_bases.get(class_id, []):
            for b in self.resolve_expr(self.class_of[class_id], base):
                if self.decls[b].kind == "class":
                    found = self.member(self.decls[b].id, attr, seen)
                    if found:
                        return found
        return self.by_name(attr)

    def resolve_name(self, module: Module, name: str) -> list[int]:
        own = f"{module.name}.{name}"
        if own in self.by_id:
            return [self.by_id[own]]
        if name in module.imports:
            return self.resolve_dotted(module.imports[name])
        return []

    def instance_of(self, i: int) -> str | None:
        """Type of a module variable assigned from a call: a project class id, "" for anything else, None if unknown."""
        decl = self.decls[i]
        node = decl.node
        if decl.kind != "var" or not isinstance(node, (ast.Assign, ast.AnnAssign)) or not isinstance(node.value, ast.Call):
            return None
        chain = attribute_chain(node.value.func)
        if chain is None:
            return None
        target = self.resolve_dotted(".".join([decl.module.imports[chain[0]], *chain[1:]])) if chain[0] in decl.module.imports else self.lookup(f"{decl.module.name}.{'.'.join(chain)}")
        classes = [t for t in target if self.decls[t].kind == "class"]
        if classes:
            return self.decls[classes[0]].id
        # A call to something outside the project (FastAPI(), Celery(), logging.getLogger()…): its attributes are not ours.
        return "" if chain[0] in decl.module.imports and not target else None

    def resolve_expr(self, module: Module, expr: ast.expr) -> list[int]:
        chain = attribute_chain(expr)
        if chain is None:
            return []
        head, attrs = chain[0], chain[1:]
        if f"{module.name}.{head}" in self.by_id:
            found = [self.by_id[f"{module.name}.{head}"]]
            if attrs and self.decls[found[0]].kind == "class":
                return found + self.member(self.decls[found[0]].id, attrs[0])
            if attrs and self.decls[found[0]].kind == "var":
                typed = self.instance_of(found[0])
                if typed == "":
                    return found
                if typed:
                    return found + self.member(typed, attrs[0]) + [m for a in attrs[1:] for m in self.by_name(a)]
            return found + [m for a in attrs for m in self.by_name(a)]
        if head in module.imports:
            return self.resolve_dotted(".".join([module.imports[head], *attrs]))
        return []

    # --- references ------------------------------------------------------------------------------------------------

    def link(self) -> None:
        self.attr_types = class_attribute_types(self)
        for i, decl in enumerate(self.decls):
            for j in References(self, decl).targets:
                if j != i:
                    self.edges.add((i, j))
            module_code = self.lookup(f"{decl.module.name}.{MODULE_CODE}")
            if module_code and module_code[0] != i and decl.kind != "main":
                self.edges.add((i, module_code[0]))
            if decl.kind == "method" and decl.owner in self.by_id and decl.id.rsplit(".", 1)[-1].startswith("__"):
                # Python calls dunder methods implicitly (construction, calls, iteration…): code using the class runs
                # them. Other methods are resolved where they are called (self., a module object, or by name).
                self.edges.add((self.by_id[decl.owner], i))


def assigned_names(stmt: ast.stmt) -> list[str]:
    targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]  # type: ignore[attr-defined]
    names: list[str] = []
    for t in targets:
        for n in ast.walk(t):
            if isinstance(n, ast.Name):
                names.append(n.id)
    return names


def attribute_chain(expr: ast.expr) -> list[str] | None:
    parts: list[str] = []
    while isinstance(expr, ast.Attribute):
        parts.append(expr.attr)
        expr = expr.value
    if not isinstance(expr, ast.Name):
        return None
    parts.append(expr.id)
    return parts[::-1]


def bound_names(node: ast.AST) -> set[str]:
    """Names a function binds locally (parameters, assignments, loop and with targets, nested definitions)."""
    names: set[str] = set()
    declared_global: set[str] = set()
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
        a = node.args
        for arg in [*a.posonlyargs, *a.args, *a.kwonlyargs, *([a.vararg] if a.vararg else []), *([a.kwarg] if a.kwarg else [])]:
            names.add(arg.arg)
    for n in ast.walk(node):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            names.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n is not node:
            names.add(n.name)
        elif isinstance(n, ast.arg):
            names.add(n.arg)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            declared_global.update(n.names)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            names.add(n.name)
    return names - declared_global


class References(ast.NodeVisitor):
    """Project declarations a declaration's code uses."""

    def __init__(self, graph: Graph, decl: Decl):
        self.graph = graph
        self.decl = decl
        self.targets: list[int] = []
        self.local = bound_names(decl.node) if decl.kind in ("func", "method") else set()
        self.types = local_types(graph, decl.module, decl.node)
        self.attr_types = graph.attr_types.get(decl.owner or "", {})
        node = decl.node
        if isinstance(node, ast.ClassDef):
            # A class declaration is its header and attributes: method bodies belong to the methods.
            for part in [*node.decorator_list, *node.bases, *node.keywords, *(s for s in node.body if not isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)))]:
                self.visit(part)
        else:
            self.visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load) and node.id not in self.local and node.id not in BUILTINS:
            self.targets += self.graph.resolve_name(self.decl.module, node.id)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        chain = attribute_chain(node)
        if chain is None:
            self.targets += self.graph.by_name(node.attr)
            self.generic_visit(node)
            return
        head, attrs = chain[0], chain[1:]
        g = self.graph
        if head in ("self", "cls") and self.decl.owner:
            self.targets += g.member(self.decl.owner, attrs[0])
            typed = self.attr_types.get(attrs[0])
            # self.repo.save(): through the type of self.repo when known, else every method named save.
            if typed and len(attrs) > 1:
                self.targets += g.member(typed, attrs[1]) + [m for a in attrs[2:] for m in g.by_name(a)]
            else:
                self.targets += [m for a in attrs[1:] for m in g.by_name(a)]
        elif head in self.types:
            self.targets += g.member(self.types[head], attrs[0]) + [m for a in attrs[1:] for m in g.by_name(a)]
        elif head in self.local:
            self.targets += [m for a in attrs for m in g.by_name(a)]
        else:
            self.targets += g.resolve_expr(self.decl.module, node)
