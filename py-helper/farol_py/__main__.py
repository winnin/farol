"""farol Python helper: reads a Python project with the standard library (ast, tokenize, tomllib) and prints, as
JSON, its top-level declarations with a hash of their code, the references between them and its entry points. It
only parses files: nothing of the analyzed project is imported or executed.

Usage:
  python3 -I farol_py analyze --root DIR [--project P] [--roots src,.] [--comments a.py,b.py]
  python3 -I farol_py toml < pyproject.toml
"""

from __future__ import annotations

import argparse
import ast
import io
import json
import os
import sys
import tokenize
import warnings

from .decls import Graph, file_header
from .modules import collect_imports, discover
from .routes import find_entries


def comments_of(source: str) -> list[tuple[int, str]]:
    out = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.COMMENT:
                out.append((tok.start[0], tok.string))
    except (tokenize.TokenError, SyntaxError):
        pass
    return out


def analyze(args: argparse.Namespace) -> dict:
    root = os.path.realpath(args.root)
    roots = [r for r in args.roots.split(",") if r] or ["."]
    modules = discover(root, args.project, roots)
    problems: list[dict] = []
    for module in modules.values():
        with open(os.path.join(root, module.file), encoding="utf-8", errors="replace") as fh:
            module.source = fh.read()
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                module.tree = ast.parse(module.source, filename=module.file)
        except SyntaxError as error:
            problems.append({"file": module.file, "line": error.lineno or 1, "kind": "parse-error", "detail": f"syntax error: {error.msg}"})
            continue
        collect_imports(module)
    graph = Graph(modules)
    graph.collect()
    graph.link()
    entries, route_problems = find_entries(graph)
    wanted = {f for f in args.comments.split(",") if f}
    comments = [{"file": m.file, "line": line, "text": text} for m in modules.values() if m.file in wanted for line, text in comments_of(m.source)]
    return {
        "module": "",
        "files": sorted(m.file for m in modules.values()),
        "decls": [{"id": d.id, "file": d.file, "line": d.line, "end": d.end, "kind": d.kind, "hash": d.hash, "core": d.core} for d in graph.decls],
        "edges": sorted([list(e) for e in graph.edges]),
        "entries": entries,
        "problems": problems + route_problems,
        "comments": comments,
        "headers": {m.file: file_header(m.tree) for m in modules.values() if m.tree is not None},
    }


def main() -> int:
    if sys.version_info < (3, 11):
        print("farol Python helper: Python 3.11 or newer is required", file=sys.stderr)
        return 1
    parser = argparse.ArgumentParser(prog="farol_py")
    sub = parser.add_subparsers(dest="command", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("--root", required=True)
    a.add_argument("--project", default=".")
    a.add_argument("--roots", default="src,.")
    a.add_argument("--comments", default="")
    sub.add_parser("toml")
    args = parser.parse_args()
    if args.command == "toml":
        import tomllib

        json.dump(tomllib.loads(sys.stdin.read()), sys.stdout, default=str)
        return 0
    json.dump(analyze(args), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
