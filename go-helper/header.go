package main

import (
	"go/ast"
	"path"
	"sort"
	"strconv"
	"strings"
)

// directivePrefixes are the comments the Go toolchain reads: they change what is compiled or linked.
var directivePrefixes = []string{"//go:", "//export ", "//extern ", "//line ", "/*line ", "// +build", "//sys "}

func isDirective(text string) bool {
	for _, p := range directivePrefixes {
		if strings.HasPrefix(text, p) {
			return true
		}
	}
	return false
}

// declLabel names a top-level declaration for the file header: a directive is recorded with the declaration it sits on.
func declLabel(d ast.Decl) string {
	switch d := d.(type) {
	case *ast.FuncDecl:
		if d.Recv != nil && len(d.Recv.List) > 0 {
			return "func (" + recvName(d.Recv.List[0].Type) + ")." + d.Name.Name
		}
		return "func " + d.Name.Name
	case *ast.GenDecl:
		names := []string{}
		for _, spec := range d.Specs {
			switch s := spec.(type) {
			case *ast.TypeSpec:
				names = append(names, s.Name.Name)
			case *ast.ValueSpec:
				for _, n := range s.Names {
					names = append(names, n.Name)
				}
			case *ast.ImportSpec:
				names = append(names, s.Path.Value)
			}
		}
		return d.Tok.String() + " " + strings.Join(names, ",")
	}
	return "?"
}

// fileHeader lists what the declarations of a file leave out (see the TypeScript side, src/project/decls.ts): the
// name each import binds ("bind <name> <path>"), blank, dot and cgo imports ("effect …", with the cgo preamble), and
// the compiler directives (//go:embed, //go:linkname, //export, build constraints) with the declaration they sit on.
func fileHeader(f *ast.File) []string {
	out := []string{}
	for _, d := range f.Decls {
		g, ok := d.(*ast.GenDecl)
		if !ok || g.Tok.String() != "import" {
			continue
		}
		for _, spec := range g.Specs {
			s := spec.(*ast.ImportSpec)
			p, err := strconv.Unquote(s.Path.Value)
			if err != nil {
				p = s.Path.Value
			}
			name := path.Base(p)
			if s.Name != nil {
				name = s.Name.Name
			}
			switch {
			case p == "C":
				for _, doc := range []*ast.CommentGroup{g.Doc, s.Doc} {
					if doc != nil {
						for _, c := range doc.List {
							out = append(out, "effect cgo "+c.Text)
						}
					}
				}
				out = append(out, "effect import C")
			case name == "_" || name == ".":
				out = append(out, "effect import "+name+" "+p)
			default:
				// The package name can differ from the last path element; the path is what matters.
				out = append(out, "bind "+name+" "+p)
			}
		}
	}
	for _, group := range f.Comments {
		for _, c := range group.List {
			if !isDirective(c.Text) {
				continue
			}
			// The declaration the directive sits on: the first one that starts after it.
			i := sort.Search(len(f.Decls), func(i int) bool { return f.Decls[i].Pos() >= c.End() })
			label := "(end of file)"
			if c.End() < f.Package {
				label = "(package)"
			} else if i > 0 && f.Decls[i-1].End() > c.Pos() {
				label = "in " + declLabel(f.Decls[i-1]) // inside a var ( … ) group
			} else if i < len(f.Decls) {
				label = declLabel(f.Decls[i])
			}
			out = append(out, "directive "+label+" "+c.Text)
		}
	}
	sort.Strings(out)
	return out
}
