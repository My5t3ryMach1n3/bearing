// Command bearing-go is the part of Bearing's Go adapter (src/lang/go.ts) that needs Go's own parser and go
// command. Bearing builds it on first use and runs it with JSON in and out:
//
//	bearing-go imports            in a module's directory: its source files and their imports
//	bearing-go functions < x.go   the functions the trace hook records spans for in one file
//	bearing-go overlay < in.json  instrumented copies of a module's files and the overlay that swaps them in
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/My5t3ryMach1n3/bearing/go/rewrite"
)

func main() {
	if len(os.Args) != 2 {
		fail(errors.New("usage: bearing-go imports|functions|overlay"))
	}
	var out any
	var err error
	switch os.Args[1] {
	case "imports":
		out, err = imports()
	case "functions":
		out, err = functions(os.Stdin)
	case "overlay":
		out, err = overlay(os.Stdin)
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fail(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

// Imports is what `imports` prints. Paths are absolute.
type Imports struct {
	// The non-test Go files of every package in the module, in the current build context.
	Files []string `json:"files"`
	// Each import in those files of a package that isn't in the standard library.
	Imports []Import `json:"imports"`
}

type Import struct {
	File string `json:"file"`
	// 1-based.
	Line int `json:"line"`
	// The import path as written.
	Path string `json:"path"`
	// The imported package's directory, or "" if the go command couldn't find it.
	Dir string `json:"dir"`
}

type listed struct {
	Dir        string
	ImportPath string
	GoFiles    []string
	CgoFiles   []string
	Standard   bool
	DepOnly    bool
}

// imports lists the module's packages and everything they depend on with `go list -deps`, so an import of a
// package in another module, such as one in the same go.work, still finds its directory.
func imports() (*Imports, error) {
	cmd := exec.Command("go", "list", "-e", "-deps", "-json=Dir,ImportPath,GoFiles,CgoFiles,Standard,DepOnly", "./...")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("go list: %s", strings.TrimSpace(firstNonEmpty(stderr.String(), err.Error())))
	}
	var packages []listed
	dirs := map[string]string{}
	for decoder := json.NewDecoder(bytes.NewReader(stdout)); ; {
		var p listed
		if err := decoder.Decode(&p); err == io.EOF {
			break
		} else if err != nil {
			return nil, fmt.Errorf("go list: %w", err)
		}
		if p.Standard {
			continue
		}
		dirs[p.ImportPath] = p.Dir
		if !p.DepOnly {
			packages = append(packages, p)
		}
	}
	result := &Imports{Files: []string{}, Imports: []Import{}}
	for _, p := range packages {
		for _, name := range append(append([]string{}, p.GoFiles...), p.CgoFiles...) {
			file := filepath.Join(p.Dir, name)
			result.Files = append(result.Files, file)
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, file, nil, parser.ImportsOnly)
			if err != nil {
				// The compiler reports broken files better; their imports still count up to the error.
				if f == nil {
					continue
				}
			}
			for _, spec := range f.Imports {
				path, err := strconv.Unquote(spec.Path.Value)
				if err != nil || path == "C" {
					continue
				}
				dir, known := dirs[path]
				if !known && !strings.Contains(strings.Split(path, "/")[0], ".") {
					continue // The standard library.
				}
				result.Imports = append(result.Imports, Import{File: file, Line: fset.Position(spec.Pos()).Line,
					Path: path, Dir: dir})
			}
		}
	}
	return result, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func functions(in io.Reader) ([]string, error) {
	src, err := io.ReadAll(in)
	if err != nil {
		return nil, err
	}
	names := rewrite.TracedFunctions(src)
	if names == nil {
		names = []string{}
	}
	return names, nil
}

// OverlayInput is what `overlay` reads. Paths are absolute.
type OverlayInput struct {
	// The repo root and the target's component paths, longest first.
	Root       string              `json:"root"`
	Components []rewrite.Component `json:"components"`
	// The Go modules to trace, by directory.
	Modules []string `json:"modules"`
	// The runtime module's directory: go/bearingtrace in Bearing's package.
	Runtime string `json:"runtime"`
	// Where the instrumented copies and the overlay file go. Emptied first.
	Out string `json:"out"`
}

type OverlayOutput struct {
	// The overlay file, for GOFLAGS=-overlay=….
	Overlay string `json:"overlay"`
	// How many Go files were instrumented.
	Files int `json:"files"`
	// Where the runtime reads goroutine IDs from: "runtime", or "stack" where the toolchain won't let the overlay
	// add to the runtime package.
	Goids string `json:"goids"`
}

const runtimeModule = "github.com/My5t3ryMach1n3/bearing/go/bearingtrace"

// overlay writes an instrumented copy of every traced Go file in each module and a go.mod for each module that
// adds the runtime, and where it can, a copy of the standard library's runtime/stubs.go that exports goroutine IDs.
// Then it writes an overlay file mapping each original to its copy. Nothing in the working tree changes.
func overlay(in io.Reader) (*OverlayOutput, error) {
	var input OverlayInput
	if err := json.NewDecoder(in).Decode(&input); err != nil {
		return nil, err
	}
	if err := os.RemoveAll(input.Out); err != nil {
		return nil, err
	}
	settings := rewrite.Settings{Root: input.Root, Components: input.Components, Runtime: runtimeModule}
	replace := map[string]string{}
	copies := 0
	// Copies are named by a counter, so two modules' files can't collide.
	copyOf := func(original string, data []byte) error {
		path := filepath.Join(input.Out, "src", strconv.Itoa(len(replace)), filepath.Base(original))
		if err := write(path, data); err != nil {
			return err
		}
		replace[original] = path
		return nil
	}
	var toolchains []toolchain
	for _, module := range input.Modules {
		err := filepath.WalkDir(module, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				// The go command skips these too, and nested modules are modules of their own.
				name := d.Name()
				if path != module && (name == "vendor" || name == "testdata" || strings.HasPrefix(name, ".") ||
					strings.HasPrefix(name, "_") || exists(filepath.Join(path, "go.mod"))) {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			instrumented, err := rewrite.File(path, src, settings)
			if err != nil || instrumented == nil {
				return err
			}
			copies++
			return copyOf(path, instrumented)
		})
		if err != nil {
			return nil, err
		}
		// The go.mod requires the runtime and replaces it with Bearing's copy, so go.mod and go.sum on disk stay as
		// they are. A directory replacement needs no go.sum entry.
		gomod, err := os.ReadFile(filepath.Join(module, "go.mod"))
		if err != nil {
			return nil, err
		}
		gomod = append(gomod, fmt.Sprintf("\nrequire %s v0.0.0\n\nreplace %s => %s\n", runtimeModule,
			runtimeModule, strconv.Quote(input.Runtime))...)
		if err := copyOf(filepath.Join(module, "go.mod"), gomod); err != nil {
			return nil, err
		}
		toolchain, err := toolchainOf(module)
		if err != nil {
			return nil, err
		}
		toolchains = append(toolchains, toolchain)
	}
	// The runtime reads goroutine IDs from the standard library's runtime package if every toolchain lets the
	// overlay add to it, and from stack traces otherwise.
	fast := true
	for _, t := range toolchains {
		fast = fast && t.overlayable()
	}
	output := &OverlayOutput{Files: copies, Goids: "stack"}
	if fast {
		output.Goids = "runtime"
		seen := map[string]bool{}
		for _, t := range toolchains {
			if seen[t.goroot] {
				continue
			}
			seen[t.goroot] = true
			stubs := filepath.Join(t.goroot, "src", "runtime", "stubs.go")
			src, err := os.ReadFile(stubs)
			if err != nil {
				return nil, err
			}
			if err := copyOf(stubs, append(src, rewrite.RuntimeGoids...)); err != nil {
				return nil, err
			}
		}
		if err := copyOf(filepath.Join(input.Runtime, "goids.go"), []byte(rewrite.FastGoids)); err != nil {
			return nil, err
		}
	}
	data, err := json.MarshalIndent(map[string]any{"Replace": replace}, "", "  ")
	if err != nil {
		return nil, err
	}
	output.Overlay = filepath.Join(input.Out, "overlay.json")
	if err := write(output.Overlay, data); err != nil {
		return nil, err
	}
	return output, nil
}

// The toolchain that builds a module, asked in the module's directory, since its go.mod or GOTOOLCHAIN can pick a
// different one from the go command on PATH.
type toolchain struct {
	goroot, gomodcache string
	// The minor version, e.g. 25 for go1.25.3; 0 for a development build.
	minor int
}

func toolchainOf(module string) (toolchain, error) {
	cmd := exec.Command("go", "env", "GOROOT", "GOMODCACHE", "GOVERSION")
	cmd.Dir = module
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return toolchain{}, fmt.Errorf("go env in %s: %s", module, strings.TrimSpace(string(exit.Stderr)))
		}
		return toolchain{}, err
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 3 {
		return toolchain{}, fmt.Errorf("go env in %s printed %q", module, out)
	}
	t := toolchain{goroot: lines[0], gomodcache: lines[1]}
	if version, ok := strings.CutPrefix(lines[2], "go1."); ok {
		if digits := strings.FieldsFunc(version, func(r rune) bool { return r < '0' || r > '9' }); len(digits) > 0 {
			t.minor, _ = strconv.Atoi(digits[0])
		}
	}
	return t, nil
}

// Go 1.25 and later refuse an overlay of any file under GOMODCACHE, which is where the go command keeps the
// toolchains it downloads for GOTOOLCHAIN or a go.mod's toolchain line.
func (t toolchain) overlayable() bool {
	inModCache := t.gomodcache != "" && strings.HasPrefix(t.goroot, filepath.Clean(t.gomodcache)+string(filepath.Separator))
	return !inModCache || (t.minor != 0 && t.minor < 25)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func write(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
