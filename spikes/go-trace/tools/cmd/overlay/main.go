// Command overlay is prototype A: before the tests run, it writes an instrumented copy of every traced Go file and
// an overlay file mapping each original to its copy, and adds the runtime as a new package inside the module.
// `bearing test` would then run the test command with GOFLAGS=-overlay=<file>.
//
//	overlay -settings settings.json -module services/reminder-worker -runtime bearingtrace/trace.go -out .bearing/go
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"bearing.dev/gotrace/rewrite"
)

func main() {
	settingsPath := flag.String("settings", "", "JSON with root and components")
	module := flag.String("module", ".", "the Go module's directory")
	runtimeSrc := flag.String("runtime", "", "the runtime's source file")
	out := flag.String("out", "", "where instrumented copies and overlay.json go")
	flag.Parse()
	if err := run(*settingsPath, *module, *runtimeSrc, *out); err != nil {
		fmt.Fprintln(os.Stderr, "overlay:", err)
		os.Exit(1)
	}
}

func run(settingsPath, module, runtimeSrc, out string) error {
	var s rewrite.Settings
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	module, _ = filepath.Abs(module)
	out, _ = filepath.Abs(out)
	modPath, err := modulePath(filepath.Join(module, "go.mod"))
	if err != nil {
		return err
	}
	// The runtime is a module of its own, written to out. The overlaid go.mod requires it and replaces it with
	// that directory, so the module's go.mod and go.sum on disk stay as they are. (A package added inside the module
	// by the overlay alone doesn't work: vet changes into its directory, which doesn't exist.)
	_ = modPath
	s.Runtime = runtimeModule

	replace := map[string]string{}
	err = filepath.WalkDir(module, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
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
		instrumented, err := rewrite.File(path, src, s)
		if err != nil || instrumented == nil {
			return err
		}
		rel, _ := filepath.Rel(module, path)
		copyPath := filepath.Join(out, "src", rel)
		if err := write(copyPath, instrumented); err != nil {
			return err
		}
		replace[path] = copyPath
		return nil
	})
	if err != nil {
		return err
	}
	runtime, err := os.ReadFile(runtimeSrc)
	if err != nil {
		return err
	}
	runtimeDir := filepath.Join(out, "runtime")
	if err := write(filepath.Join(runtimeDir, "trace.go"), runtime); err != nil {
		return err
	}
	asm, err := os.ReadFile(filepath.Join(filepath.Dir(runtimeSrc), "goids.s"))
	if err != nil {
		return err
	}
	if err := write(filepath.Join(runtimeDir, "goids.s"), asm); err != nil {
		return err
	}
	// The overlay reaches the standard library too: add the goroutine IDs file to the runtime package.
	goroot, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		return err
	}
	goidsCopy := filepath.Join(out, "goroot", "bearing_goids.go")
	if err := write(goidsCopy, []byte(rewrite.GoroutineIDs)); err != nil {
		return err
	}
	replace[filepath.Join(strings.TrimSpace(string(goroot)), "src", "runtime", "bearing_goids.go")] = goidsCopy
	if err := write(filepath.Join(runtimeDir, "go.mod"), []byte("module "+runtimeModule+"\n\ngo 1.21\n")); err != nil {
		return err
	}
	gomod, err := os.ReadFile(filepath.Join(module, "go.mod"))
	if err != nil {
		return err
	}
	gomod = append(gomod, fmt.Sprintf("\nrequire %s v0.0.0\n\nreplace %s => %s\n", runtimeModule, runtimeModule,
		runtimeDir)...)
	gomodCopy := filepath.Join(out, "src", "go.mod")
	if err := write(gomodCopy, gomod); err != nil {
		return err
	}
	replace[filepath.Join(module, "go.mod")] = gomodCopy
	overlay, _ := json.MarshalIndent(map[string]any{"Replace": replace}, "", "  ")
	if err := write(filepath.Join(out, "overlay.json"), overlay); err != nil {
		return err
	}
	fmt.Printf("instrumented %d files\n", len(replace)-2)
	return nil
}

const runtimeModule = "bearing.dev/trace"

func modulePath(gomod string) (string, error) {
	data, err := os.ReadFile(gomod)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if f := strings.Fields(line); len(f) == 2 && f[0] == "module" {
			return strings.Trim(f[1], `"`), nil
		}
	}
	return "", fmt.Errorf("%s has no module line", gomod)
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

func write(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
