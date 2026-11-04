// Package rewrite instruments Go source for the trace hook. Both prototypes use it: the overlay one ahead of the
// test run, the toolexec one on each compile.
//
// Edits are insertions on existing lines, so line numbers in compile errors, panics and coverage stay right:
//
//   - after the package clause:            ; import __bt "<runtime>"
//   - at the top of each traced function:  defer __bt.Span("<component>", "<name>", "<file>")();
//   - at the top of each test function:    __bt.Test(t, "<file>");
package rewrite

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type Component struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

type Settings struct {
	// The repo root, absolute.
	Root string `json:"root"`
	// Longest path first, as Bearing's componentPaths sorts them.
	Components []Component `json:"components"`
	// The import path of the bearingtrace runtime as the instrumented code imports it.
	Runtime string `json:"runtime"`
}

const alias = "__bt"

// File returns src instrumented, or nil if nothing in it is traced.
func File(path string, src []byte, s Settings) ([]byte, error) {
	rel, err := filepath.Rel(s.Root, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return nil, nil
	}
	rel = filepath.ToSlash(rel)
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, src, parser.SkipObjectResolution)
	if err != nil {
		// Leave broken files to the compiler, which reports them better.
		return nil, nil
	}
	type insert struct {
		at   int
		text string
	}
	var inserts []insert
	// Each insertion ends with a line directive giving the position of the text after it, so compile errors
	// report the original file, line and column.
	at := func(body *ast.BlockStmt, text string) {
		next := fset.Position(body.Lbrace + 1)
		inserts = append(inserts, insert{next.Offset, text + fmt.Sprintf("/*line %s:%d:%d*/", path, next.Line,
			next.Column)})
	}

	if strings.HasSuffix(rel, "_test.go") {
		testing := importName(f, "testing")
		if testing == "" {
			return nil, nil
		}
		// Tests are TestXxx functions and the function literals handed to t.Run. Helpers that take a *testing.T
		// aren't tests of their own.
		ast.Inspect(f, func(n ast.Node) bool {
			switch fn := n.(type) {
			case *ast.FuncDecl:
				if strings.HasPrefix(fn.Name.Name, "Test") && fn.Recv == nil && fn.Body != nil {
					if t := testParam(fn.Type, testing); t != "" {
						at(fn.Body, alias+".Test("+t+", "+strconv.Quote(rel)+");")
					}
				}
			case *ast.CallExpr:
				sel, ok := fn.Fun.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "Run" || len(fn.Args) != 2 {
					return true
				}
				if lit, ok := fn.Args[1].(*ast.FuncLit); ok {
					if t := testParam(lit.Type, testing); t != "" {
						at(lit.Body, alias+".Test("+t+", "+strconv.Quote(rel)+");")
					}
				}
			}
			return true
		})
	} else if component := componentOf(rel, s.Components); component != "" {
		tracedDecls(f, func(fn *ast.FuncDecl, name string) {
			at(fn.Body, "defer "+alias+".Span("+strconv.Quote(component)+", "+strconv.Quote(name)+", "+
				strconv.Quote(rel)+")();")
		})
	}
	if len(inserts) == 0 {
		return nil, nil
	}
	pkgEnd := fset.Position(f.Name.End())
	inserts = append(inserts, insert{pkgEnd.Offset, "; import " + alias + " " + strconv.Quote(s.Runtime) +
		fmt.Sprintf("/*line %s:%d:%d*/", path, pkgEnd.Line, pkgEnd.Column)})
	sort.Slice(inserts, func(i, j int) bool { return inserts[i].at > inserts[j].at })
	out := append([]byte("//line "+path+":1\n"), src...)
	for i := range inserts {
		inserts[i].at += len("//line " + path + ":1\n")
	}
	for _, in := range inserts {
		out = append(out[:in.at], append([]byte(in.text), out[in.at:]...)...)
	}
	return out, nil
}

// TracedFunctions lists the functions File traces in a non-test file, as spans name them: what the adapter's
// tracedFunctions returns for surplus.
func TracedFunctions(src []byte) []string {
	f, err := parser.ParseFile(token.NewFileSet(), "", src, parser.SkipObjectResolution)
	if err != nil {
		return nil
	}
	return tracedDecls(f, func(*ast.FuncDecl, string) {})
}

// Exported functions, and exported methods on exported types, as "Name" and "Type.Name". Like the TypeScript hook,
// only what other components can call.
func tracedDecls(f *ast.File, each func(*ast.FuncDecl, string)) []string {
	var names []string
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil || !fn.Name.IsExported() {
			continue
		}
		name := fn.Name.Name
		if fn.Recv != nil {
			recv := receiverType(fn.Recv.List[0].Type)
			if !ast.IsExported(recv) {
				continue
			}
			name = recv + "." + name
		}
		each(fn, name)
		names = append(names, name)
	}
	return names
}

func receiverType(e ast.Expr) string {
	for {
		switch t := e.(type) {
		case *ast.StarExpr:
			e = t.X
		case *ast.IndexExpr:
			e = t.X
		case *ast.IndexListExpr:
			e = t.X
		case *ast.ParenExpr:
			e = t.X
		case *ast.Ident:
			return t.Name
		default:
			return ""
		}
	}
}

// The name of a `*testing.T` parameter, if the function has a named one.
func testParam(typ *ast.FuncType, testing string) string {
	if typ.Params == nil {
		return ""
	}
	for _, field := range typ.Params.List {
		star, ok := field.Type.(*ast.StarExpr)
		if !ok {
			continue
		}
		sel, ok := star.X.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "T" {
			continue
		}
		if pkg, ok := sel.X.(*ast.Ident); !ok || pkg.Name != testing {
			continue
		}
		for _, name := range field.Names {
			if name.Name != "_" {
				return name.Name
			}
		}
	}
	return ""
}

func importName(f *ast.File, path string) string {
	for _, spec := range f.Imports {
		if p, _ := strconv.Unquote(spec.Path.Value); p == path {
			if spec.Name != nil {
				return spec.Name.Name
			}
			return filepath.Base(path)
		}
	}
	return ""
}

func componentOf(file string, components []Component) string {
	for _, c := range components {
		if c.Path == "." || file == c.Path || strings.HasPrefix(file, c.Path+"/") {
			return c.ID
		}
	}
	return ""
}

// GoroutineIDs is a file both hooks add to the runtime package. The runtime keeps each goroutine's ID and the ID of
// the goroutine that started it, but exports neither; reading them from a stack trace instead costs microseconds a
// call and grows with stack depth.
const GoroutineIDs = `package runtime

import _ "unsafe"

// Added by Bearing's trace hook for bearingtrace.goids.
//
//go:linkname bearingGoids
func bearingGoids() (id, parent uint64) {
	gp := getg()
	return gp.goid, gp.parentGoid
}
`
