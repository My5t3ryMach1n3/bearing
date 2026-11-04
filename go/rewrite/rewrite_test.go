package rewrite

import (
	"reflect"
	"strings"
	"testing"
)

var settings = Settings{
	Root:       "/repo",
	Components: []Component{{ID: "smsSender", Path: "internal/sms"}},
	Runtime:    "example.com/bearingtrace",
}

func TestFileTracesExportedFunctions(t *testing.T) {
	src := "package sms\n\nfunc Format() string {\n\treturn \"\"\n}\n\nfunc shorten() {}\n"
	out, err := File("/repo/internal/sms/templates.go", []byte(src), settings)
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	for _, want := range []string{
		"//line /repo/internal/sms/templates.go:1\npackage sms; import __bt \"example.com/bearingtrace\"",
		"func Format() string {defer __bt.Span(\"smsSender\", \"Format\", \"internal/sms/templates.go\")();" +
			"/*line /repo/internal/sms/templates.go:3:23*/\n",
		"func shorten() {}",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	// Every insertion is on an existing line, so the copy has as many lines as the original, plus the directive.
	if lines := strings.Count(got, "\n"); lines != strings.Count(src, "\n")+1 {
		t.Errorf("got %d lines, want %d", lines, strings.Count(src, "\n")+1)
	}
}

func TestFileMarksTestsAndSubtests(t *testing.T) {
	src := `package integration

import tt "testing"

func TestReminders(t *tt.T) {
	t.Run("#3/AC1 sends", func(t *tt.T) {})
}

func helper(t *tt.T) {}
`
	out, err := File("/repo/integration/reminders_test.go", []byte(src), settings)
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(out), `__bt.Test(t, "integration/reminders_test.go");`); n != 2 {
		t.Errorf("marked %d tests, want 2:\n%s", n, out)
	}
}

func TestFileLeavesOtherFilesAlone(t *testing.T) {
	for _, path := range []string{
		"/repo/cmd/worker/main.go",          // In no component.
		"/repo/internal/sms/test/fakes.go",  // A test folder.
		"/elsewhere/internal/sms/sender.go", // Outside the repo.
		"/repo/internal/sms/broken.go",      // Doesn't parse.
	} {
		src := "package x\n\nfunc Exported() {}\n"
		if strings.HasSuffix(path, "broken.go") {
			src = "package x\n\nfunc Exported( {}\n"
		}
		if out, err := File(path, []byte(src), settings); out != nil || err != nil {
			t.Errorf("%s: got %q, %v; want it left alone", path, out, err)
		}
	}
}

func TestTracedFunctions(t *testing.T) {
	src := `package x

func New() *Set[int] { return nil }
func helper() {}
type Set[T comparable] struct{}
func (s *Set[T]) Add(v T) {}
func (Set[T]) Len() int { return 0 }
func (s *Set[T]) grow() {}
type inner struct{}
func (inner) Exported() {}
func Assembly()
`
	want := []string{"New", "Set.Add", "Set.Len"}
	if got := TracedFunctions([]byte(src)); !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
