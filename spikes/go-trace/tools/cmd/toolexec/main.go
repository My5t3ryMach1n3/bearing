// Command toolexec is prototype B: `bearing test` would run the test command with GOFLAGS=-toolexec=<this binary>,
// and the go command runs every compile and link through it.
//
//   - compile -V=full: adds a hash of the hook and its settings to the tool's version, so instrumented builds get
//     their own cache entries.
//   - compile of a package with traced files: rewrites them into a temp directory, adds the runtime to the
//     importcfg, and compiles the rewritten files instead.
//   - link: adds the runtime to the importcfg.
//
// The runtime isn't in the module's build graph, so this command builds it on first use (with the plain go command,
// no toolexec) and hands its archive to compile and link itself.
//
// Settings come from $BEARING_GO_TRACE_SETTINGS, a JSON file with root and components.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"bearing.dev/gotrace/rewrite"
)

const runtimePath = "bearing.dev/gotrace/bearingtrace"

func main() {
	if len(os.Args) < 2 {
		fatal(fmt.Errorf("usage: toolexec <tool> [args]"))
	}
	tool, args := os.Args[1], os.Args[2:]
	settingsPath := os.Getenv("BEARING_GO_TRACE_SETTINGS")
	var err error
	name := filepath.Base(strings.TrimSuffix(tool, ".exe"))
	switch {
	case (name == "compile" || name == "link") && len(args) == 1 && args[0] == "-V=full":
		err = version(tool, settingsPath)
	case name == "compile":
		args, err = compile(args, settingsPath)
	case name == "link":
		args, err = link(args)
	}
	if err != nil {
		fatal(err)
	}
	run(tool, args)
}

func version(tool, settingsPath string) error {
	out, err := exec.Command(tool, "-V=full").Output()
	if err != nil {
		return err
	}
	// "compile version go1.26.2" → "compile version go1.26.2:bearing-<hash>". The go command keys its cache on the
	// third field. Link needs it too: the go command doesn't know the runtime archive is an input to the link, so
	// without it a changed runtime would leave a stale test binary in the cache.
	h := sha256.New()
	self, _ := os.Executable()
	runtimeSrc := filepath.Join(os.Getenv("BEARING_GO_TRACE_RUNTIME_SRC"), "trace.go")
	for _, path := range []string{self, settingsPath, runtimeSrc} {
		data, _ := os.ReadFile(path)
		h.Write(data)
	}
	f := strings.Fields(strings.TrimSpace(string(out)))
	if len(f) < 3 {
		return fmt.Errorf("unexpected %s -V=full output: %s", tool, out)
	}
	f[2] += ":bearing-" + hex.EncodeToString(h.Sum(nil))[:16]
	fmt.Println(strings.Join(f, " "))
	os.Exit(0)
	return nil
}

func compile(args []string, settingsPath string) ([]string, error) {
	pkg, importcfg := flagValue(args, "-p"), flagValue(args, "-importcfg")
	if pkg == "runtime" {
		return addGoroutineIDs(args, importcfg)
	}
	// rewrite.File leaves files outside the repo, such as the standard library's, alone.
	if pkg == "" || importcfg == "" || pkg == runtimePath {
		return args, nil
	}
	s, err := settings(settingsPath)
	if err != nil {
		return nil, err
	}
	s.Runtime = runtimePath
	var tmp string
	changed := false
	for i, arg := range args {
		if !strings.HasSuffix(arg, ".go") || strings.HasPrefix(arg, "-") {
			continue
		}
		src, err := os.ReadFile(arg)
		if err != nil {
			return nil, err
		}
		path, _ := filepath.Abs(arg)
		out, err := rewrite.File(path, src, s)
		if err != nil {
			return nil, err
		}
		if out == nil {
			continue
		}
		if tmp == "" {
			if tmp, err = os.MkdirTemp(filepath.Dir(importcfg), "bearing-"); err != nil {
				return nil, err
			}
		}
		copyPath := filepath.Join(tmp, fmt.Sprintf("%d_%s", i, filepath.Base(arg)))
		if err := os.WriteFile(copyPath, out, 0o644); err != nil {
			return nil, err
		}
		args[i] = copyPath
		changed = true
	}
	if !changed {
		return args, nil
	}
	archive, err := runtimeArchive()
	if err != nil {
		return nil, err
	}
	cfg, err := addPackage(importcfg, tmp, archive)
	if err != nil {
		return nil, err
	}
	setFlag(args, "-importcfg", cfg)
	return args, nil
}

// addGoroutineIDs adds rewrite.GoroutineIDs to the runtime package's compile.
func addGoroutineIDs(args []string, importcfg string) ([]string, error) {
	dir, err := os.MkdirTemp(filepath.Dir(importcfg), "bearing-")
	if err != nil {
		return nil, err
	}
	file := filepath.Join(dir, "bearing_goids.go")
	if err := os.WriteFile(file, []byte(rewrite.GoroutineIDs), 0o644); err != nil {
		return nil, err
	}
	return append(args, file), nil
}

func link(args []string) ([]string, error) {
	importcfg := flagValue(args, "-importcfg")
	if importcfg == "" {
		return args, nil
	}
	data, err := os.ReadFile(importcfg)
	if err != nil {
		return nil, err
	}
	if strings.Contains(string(data), "packagefile "+runtimePath+"=") {
		return args, nil
	}
	archive, err := runtimeArchive()
	if err != nil {
		return nil, err
	}
	cfg, err := addPackage(importcfg, filepath.Dir(importcfg), archive)
	if err != nil {
		return nil, err
	}
	setFlag(args, "-importcfg", cfg)
	return args, nil
}

// runtimeArchive builds the runtime once per toolexec binary, into the user cache, and returns its archive.
func runtimeArchive() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	info, err := os.Stat(self)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(cache, "bearing", "gotrace", fmt.Sprintf("%x", info.ModTime().UnixNano()))
	archive := filepath.Join(dir, "bearingtrace.a")
	if _, err := os.Stat(archive); err == nil {
		return archive, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	src := os.Getenv("BEARING_GO_TRACE_RUNTIME_SRC")
	if src == "" {
		return "", fmt.Errorf("BEARING_GO_TRACE_RUNTIME_SRC not set")
	}
	tmp, err := os.CreateTemp(dir, "build-*.a")
	if err != nil {
		return "", err
	}
	tmp.Close()
	cmd := exec.Command("go", "build", "-o", tmp.Name(), ".")
	cmd.Dir = src
	// No toolexec, or the build would come back here.
	cmd.Env = append(os.Environ(), "GOFLAGS=")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("building the trace runtime: %w", err)
	}
	// Compiles run in parallel: whichever finishes first wins, and the archives are identical.
	return archive, os.Rename(tmp.Name(), archive)
}

func addPackage(importcfg, dir, archive string) (string, error) {
	data, err := os.ReadFile(importcfg)
	if err != nil {
		return "", err
	}
	out, err := os.CreateTemp(dir, "importcfg-*")
	if err != nil {
		return "", err
	}
	defer out.Close()
	w := bufio.NewWriter(out)
	w.Write(data)
	fmt.Fprintf(w, "\npackagefile %s=%s\n", runtimePath, archive)
	return out.Name(), w.Flush()
}

func settings(path string) (rewrite.Settings, error) {
	var s rewrite.Settings
	data, err := os.ReadFile(path)
	if err != nil {
		return s, fmt.Errorf("reading BEARING_GO_TRACE_SETTINGS: %w", err)
	}
	return s, json.Unmarshal(data, &s)
}

func flagValue(args []string, name string) string {
	for i, arg := range args {
		if arg == name && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(arg, name+"=") {
			return strings.TrimPrefix(arg, name+"=")
		}
	}
	return ""
}

func setFlag(args []string, name, value string) {
	for i, arg := range args {
		if arg == name && i+1 < len(args) {
			args[i+1] = value
		} else if strings.HasPrefix(arg, name+"=") {
			args[i] = name + "=" + value
		}
	}
}

func run(tool string, args []string) {
	cmd := exec.Command(tool, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "bearing toolexec:", err)
	os.Exit(1)
}
