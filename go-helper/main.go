// Command gohelper reads a Go module the way the compiler does (go list + go/types, offline) and prints, as JSON, what
// farol needs: top-level declarations with a hash of their code, the references between them, and the entry
// points (HTTP routes and binaries). It never runs code of the analyzed module.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Comment is a comment line of a requested file (for suppressions such as //nolint).
type Comment struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// Output is the whole result.
type Output struct {
	Module   string    `json:"module"`
	Files    []string  `json:"files"`
	Decls    []Decl    `json:"decls"`
	Edges    [][2]int  `json:"edges"`
	Entries  []Entry   `json:"entries"`
	Problems []Problem `json:"problems"`
	Comments []Comment `json:"comments"`
	// Headers lists, per file, what declarations leave out: imports and compiler directives.
	Headers map[string][]string `json:"headers"`
}

func relPath(root, abs string) string {
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return filepath.ToSlash(abs)
	}
	return filepath.ToSlash(rel)
}

func run() error {
	root := flag.String("root", "", "repository root (paths in the output are relative to it)")
	project := flag.String("project", ".", "directory of the Go module, relative to the root")
	comments := flag.String("comments", "", "comma-separated repo-relative files whose comments to print")
	flag.Parse()
	if *root == "" {
		return fmt.Errorf("-root is required")
	}
	absRoot, err := filepath.Abs(*root)
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(absRoot); err == nil {
		absRoot = resolved
	}
	fset := token.NewFileSet()
	pkgs, err := load(filepath.Join(absRoot, *project), fset)
	if err != nil {
		return err
	}
	g := newGraph(fset, absRoot)
	if err := g.collect(pkgs); err != nil {
		return err
	}
	g.link()
	entries, problems := findEntries(g, pkgs)
	out := Output{Decls: g.decls, Edges: g.edgeList(), Entries: entries, Problems: problems, Files: []string{}, Comments: []Comment{}, Headers: map[string][]string{}}
	wanted := map[string]bool{}
	for _, f := range strings.Split(*comments, ",") {
		if f != "" {
			wanted[f] = true
		}
	}
	for _, p := range pkgs {
		if !p.project {
			continue
		}
		if out.Module == "" && p.list.Module != nil {
			out.Module = p.list.Module.Path
		}
		for i, name := range p.names {
			rel := g.rel(name)
			out.Files = append(out.Files, rel)
			out.Headers[rel] = fileHeader(p.files[i])
			if wanted[rel] {
				for _, group := range p.files[i].Comments {
					for _, c := range group.List {
						out.Comments = append(out.Comments, Comment{File: rel, Line: fset.Position(c.Pos()).Line, Text: c.Text})
					}
				}
			}
		}
		for _, e := range p.errors {
			pos := e.Fset.Position(e.Pos)
			out.Problems = append(out.Problems, Problem{File: g.rel(pos.Filename), Line: pos.Line, Kind: "type-error", Detail: e.Msg})
		}
	}
	sort.Strings(out.Files)
	if out.Problems == nil {
		out.Problems = []Problem{}
	}
	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(out)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "gohelper:", err)
		os.Exit(1)
	}
}
