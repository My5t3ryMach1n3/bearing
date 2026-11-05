// Package rewrite instruments Go source for the trace hook. `bearing-go overlay` runs it over a module before the
// tests run; see docs/adrs/0001-trace-go-with-an-overlay.md.
//
// Edits are insertions on existing lines, so line numbers in compile errors, panics and coverage stay right:
//
//   - after the package clause:            ; import __bt "<runtime>"
//   - at the top of each traced function:  defer __bt.Span("<component>", "<name>", "<file>")();
//   - at the top of each test function:    __bt.Test(t, "<file>");
//
// And in any file that imports the AWS SDK for Go v2's SQS package, each call of a method named SendMessage,
// SendMessageBatch or ReceiveMessage with at least two arguments goes through the hook, which carries the trace
// context in the messages' attributes:
//
//	client.SendMessage(ctx, input)  ->  __bt.SQSSendMessage(client.SendMessage, ctx, input)
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

// The SQS package whose calls carry trace context, and its methods the hook wraps.
const sqsPackage = "github.com/aws/aws-sdk-go-v2/service/sqs"

var sqsMethods = map[string]bool{"SendMessage": true, "SendMessageBatch": true, "ReceiveMessage": true}

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
	// Text to put at an offset, in place of the `cut` bytes there.
	type insert struct {
		at   int
		text string
		cut  int
	}
	var inserts []insert
	// Each insertion ends with a line directive giving the position of the text after it, so compile errors
	// report the original file, line and column.
	at := func(body *ast.BlockStmt, text string) {
		next := fset.Position(body.Lbrace + 1)
		inserts = append(inserts, insert{next.Offset, text + fmt.Sprintf("/*line %s:%d:%d*/", path, next.Line,
			next.Column), 0})
	}
	directive := func(pos token.Pos) string {
		p := fset.Position(pos)
		return fmt.Sprintf("/*line %s:%d:%d*/", path, p.Line, p.Column)
	}

	if importName(f, sqsPackage) != "" {
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) < 2 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || !sqsMethods[sel.Sel.Name] {
				return true
			}
			start, paren := fset.Position(call.Fun.Pos()), fset.Position(call.Lparen)
			inserts = append(inserts,
				insert{start.Offset, alias + ".SQS" + sel.Sel.Name + "(" + directive(call.Fun.Pos()), 0},
				insert{paren.Offset, ", " + directive(call.Args[0].Pos()), 1})
			return true
		})
	}

	if strings.HasSuffix(rel, "_test.go") {
		testing := importName(f, "testing")
		// Tests are TestXxx functions and the function literals handed to t.Run. Helpers that take a *testing.T
		// aren't tests of their own.
		ast.Inspect(f, func(n ast.Node) bool {
			switch fn := n.(type) {
			case *ast.FuncDecl:
				if testing != "" && strings.HasPrefix(fn.Name.Name, "Test") && fn.Recv == nil && fn.Body != nil {
					if t := testParam(fn.Type, testing); t != "" {
						at(fn.Body, alias+".Test("+t+", "+strconv.Quote(rel)+");")
					}
				}
			case *ast.CallExpr:
				sel, ok := fn.Fun.(*ast.SelectorExpr)
				if testing == "" || !ok || sel.Sel.Name != "Run" || len(fn.Args) != 2 {
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
	} else if component := componentOf(rel, s.Components); component != "" && !inTestFolder(rel) {
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
		fmt.Sprintf("/*line %s:%d:%d*/", path, pkgEnd.Line, pkgEnd.Column), 0})
	// Applied last first. Two at one offset go in the order they were added, which puts an SQS call after the defer
	// at the top of the function it opens.
	sort.SliceStable(inserts, func(i, j int) bool { return inserts[i].at > inserts[j].at })
	out := append([]byte("//line "+path+":1\n"), src...)
	for i := range inserts {
		inserts[i].at += len("//line " + path + ":1\n")
	}
	for _, in := range inserts {
		out = append(out[:in.at], append([]byte(in.text), out[in.at+in.cut:]...)...)
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

// Bearing treats files under test folders as tests (testFile in src/paths.ts): they exercise components rather than
// belong to them, so they're never traced.
func inTestFolder(file string) bool {
	parts := strings.Split(file, "/")
	for _, part := range parts[:len(parts)-1] {
		if part == "test" || part == "tests" || part == "__tests__" {
			return true
		}
	}
	return false
}

func componentOf(file string, components []Component) string {
	for _, c := range components {
		if c.Path == "." || file == c.Path || strings.HasPrefix(file, c.Path+"/") {
			return c.ID
		}
	}
	return ""
}

// RuntimeGoids is appended to the runtime package's stubs.go in the overlay. The runtime keeps each goroutine's ID
// and the ID of the goroutine that started it, but exports neither; reading them from a stack trace instead costs
// microseconds a call and grows with stack depth. It's appended to a file the runtime already has, rather than
// added as a new one, because `go vet` before Go 1.24 reads the standard library's files from disk, not the
// overlay. stubs.go imports unsafe, which go:linkname needs, in every Go release since 1.21.
const RuntimeGoids = `

// Added by Bearing's trace hook for bearingtrace.goids.
//
//go:linkname bearingGoids
func bearingGoids() (id, parent uint64) {
	gp := getg()
	return gp.goid, gp.parentGoid
}
`

// FastGoids replaces bearingtrace's goids.go in the overlay when RuntimeGoids is in the runtime.
const FastGoids = `package bearingtrace

// Before Go 1.24, vet reads goids.go from disk with the imports of this one, so it imports the same packages.
import (
	_ "bytes"
	_ "runtime"
	_ "strconv"
	_ "unsafe" // for go:linkname
)

// goids returns the calling goroutine's ID and the ID of the goroutine that started it, from the function
// bearing-go overlay adds to the runtime (rewrite.RuntimeGoids).
//
//go:linkname goids runtime.bearingGoids
func goids() (id, parent uint64)
`
