// Package bearingtrace is the Go trace hook's runtime. Instrumented code calls Span at the top of every traced
// function and Test at the top of every test function; nothing else in the code under test changes.
//
// It writes the same files as the TypeScript hook (src/trace/runtime.ts): OTLP JSON span lines to
// spans-<pid>-0.jsonl and test records to tests-<pid>-0.jsonl in $BEARING_GO_TRACE_DIR.
//
// Go has no goroutine-local storage, so the runtime keys its state by goroutine ID, and takes a new goroutine's
// test and parent span from the goroutine that started it. That way a call made from a goroutine the code under
// test starts still joins the test's trace.
//
// It imports only packages every test binary already links (via "testing"), so the toolexec prototype can add it
// to a link without the linker needing anything new.
package bearingtrace

import (
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "unsafe" // for go:linkname
)

// T is the part of *testing.T the hook uses. Taking an interface keeps "testing" out of non-test binaries.
type T interface {
	Name() string
	Failed() bool
	Skipped() bool
	Cleanup(func())
}

type span struct {
	traceID, spanID, parentID string
	test                      *test
	component, name, file     string
	start                     int64
}

type test struct {
	name, criterion, traceID string
}

type goroutine struct {
	test  *test
	stack []*span
	// How many spans at the bottom of stack were inherited from the goroutine that started this one.
	base int
}

var (
	dir     = os.Getenv("BEARING_GO_TRACE_DIR")
	tag     = os.Getenv("BEARING_GO_TRACE_TAG")
	enabled = dir != ""

	mu           sync.Mutex
	goroutines   = map[uint64]*goroutine{}
	pending      []string
	pendingBytes int
	spansOut     *os.File
	testsOut     *os.File
	nextID       uint64
	seen         = map[T]bool{}
	prefix       = strconv.FormatUint(uint64(os.Getpid())&0xffffffff, 16)
	processTr    = traceID()
)

// Span starts a span for a call into a component's function and returns the function that ends it. Instrumented
// code calls it as `defer bearingtrace.Span(component, name, file)()`.
func Span(component, name, file string) func() {
	if !enabled {
		return noop
	}
	id := goid()
	mu.Lock()
	g := state(id)
	s := &span{spanID: spanID(), component: component, name: name, file: file, start: time.Now().UnixNano()}
	if n := len(g.stack); n > 0 && g.stack[n-1].test == g.test {
		top := g.stack[n-1]
		s.traceID, s.parentID, s.test = top.traceID, top.spanID, top.test
	} else if g.test != nil {
		s.traceID, s.test = g.test.traceID, g.test
	} else {
		s.traceID = processTr
	}
	g.stack = append(g.stack, s)
	mu.Unlock()
	return func() { end(id, s) }
}

func end(id uint64, s *span) {
	stop := time.Now().UnixNano()
	mu.Lock()
	defer mu.Unlock()
	pending = append(pending, spanJSON(s, stop))
	pendingBytes += len(pending[len(pending)-1])
	if g := goroutines[id]; g != nil && len(g.stack) > g.base {
		g.stack = g.stack[:len(g.stack)-1]
	}
	// Spans are written when each test ends (see Test), or here once a lot have built up. A test binary exits
	// without running exit hooks, so spans from after the last test ends are lost; they belong to no test anyway.
	if pendingBytes > 1<<20 {
		flush()
	}
}

// Test marks the calling goroutine as running t, and records how t ended once it has.
func Test(t T, file string) {
	if !enabled {
		return
	}
	// Different on every `bearing test`. The go command keys a cached test result on the environment variables the
	// test read while it ran (not during package init), so reading this one here means every test runs, and writes
	// its spans, under the hook.
	os.Getenv("BEARING_GO_TRACE_RUN")
	id := goid()
	te := &test{name: t.Name(), criterion: criterion(t.Name(), tag), traceID: traceID()}
	mu.Lock()
	state(id).test = te
	first := !seen[t]
	seen[t] = true
	mu.Unlock()
	if !first {
		return
	}
	t.Cleanup(func() {
		status := "passed"
		if t.Skipped() {
			status = "skipped"
		} else if t.Failed() {
			status = "failed"
		}
		line := `{"name":` + quote(te.name) + `,"file":` + quote(file) + `,"status":"` + status + `"`
		if te.criterion != "" {
			line += `,"criterion":` + quote(te.criterion)
		}
		mu.Lock()
		defer mu.Unlock()
		flush()
		if testsOut == nil {
			testsOut = open("tests")
		}
		testsOut.WriteString(line + "}\n")
	})
}

func noop() {}

// state returns the goroutine's state, creating it from the goroutine that started it the first time. Called with
// mu held, from the goroutine itself.
func state(id uint64) *goroutine {
	g := goroutines[id]
	if g == nil {
		g = &goroutine{}
		if p := goroutines[parentGoid()]; p != nil {
			g.test = p.test
			if n := len(p.stack); n > 0 {
				g.stack, g.base = []*span{p.stack[n-1]}, 1
			}
		}
		goroutines[id] = g
	}
	return g
}

// goids returns the calling goroutine's ID and the ID of the goroutine that started it. Both hooks add it to the
// runtime package (see rewrite.GoroutineIDs), because the runtime keeps both in the goroutine but exports neither.
//
//go:linkname goids runtime.bearingGoids
func goids() (id, parent uint64)

func goid() uint64 {
	id, _ := goids()
	return id
}

func parentGoid() uint64 {
	_, parent := goids()
	return parent
}

func flush() {
	if len(pending) == 0 {
		return
	}
	if spansOut == nil {
		spansOut = open("spans")
	}
	spansOut.WriteString(`{"resourceSpans":[{"resource":{"attributes":[` + attr("service.name", "bearing-test") +
		`,{"key":"process.pid","value":{"intValue":"` + strconv.Itoa(os.Getpid()) + `"}}]},` +
		`"scopeSpans":[{"scope":{"name":"bearing"},"spans":[` + strings.Join(pending, ",") + "]}]}]}\n")
	pending, pendingBytes = pending[:0], 0
}

func open(kind string) *os.File {
	os.MkdirAll(dir, 0o755)
	f, err := os.OpenFile(dir+"/"+kind+"-"+strconv.Itoa(os.Getpid())+"-0.jsonl", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		panic("bearing: can't write traces: " + err.Error())
	}
	return f
}

func spanJSON(s *span, stop int64) string {
	attrs := []string{
		attr("bearing.component", s.component),
		attr("code.function.name", s.name),
		attr("code.file.path", s.file),
	}
	if s.test != nil {
		attrs = append(attrs, attr("bearing.test", s.test.name))
		if s.test.criterion != "" {
			attrs = append(attrs, attr("bearing.criterion", s.test.criterion))
		}
	}
	parent := ""
	if s.parentID != "" {
		parent = `"parentSpanId":"` + s.parentID + `",`
	}
	return `{"traceId":"` + s.traceID + `","spanId":"` + s.spanID + `",` + parent + `"name":` + quote(s.name) +
		`,"kind":1,"startTimeUnixNano":"` + strconv.FormatInt(s.start, 10) + `","endTimeUnixNano":"` +
		strconv.FormatInt(stop, 10) + `","attributes":[` + strings.Join(attrs, ",") + `],"status":{"code":1}}`
}

func attr(key, value string) string {
	return `{"key":"` + key + `","value":{"stringValue":` + quote(value) + `}}`
}

// quote writes s as a JSON string.
func quote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r < 0x20:
			b.WriteString(`\u00`)
			b.WriteByte("0123456789abcdef"[r>>4])
			b.WriteByte("0123456789abcdef"[r&0xf])
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// Span IDs only need to be unique within a trace: the process ID and a counter. Called with mu held.
func spanID() string {
	nextID++
	id := prefix + strconv.FormatUint(nextID, 16)
	return strings.Repeat("0", 16-len(id)) + id
}

func traceID() string {
	id := strconv.FormatInt(time.Now().UnixNano(), 16) + prefix
	nextID++
	id += strconv.FormatUint(nextID, 16)
	if len(id) < 32 {
		id = strings.Repeat("0", 32-len(id)) + id
	}
	return id[len(id)-32:]
}

// criterion finds the tag in a test's name for a template like "#<issue>/AC<n>", where each placeholder is digits.
// Go writes spaces in subtest names as underscores, which the default template doesn't contain.
func criterion(name, template string) string {
	if template == "" {
		return ""
	}
	parts := strings.FieldsFunc(strings.NewReplacer("<issue>", "\x00", "<n>", "\x00").Replace(template),
		func(r rune) bool { return r == 0 })
	holes := strings.Count(strings.NewReplacer("<issue>", "\x00", "<n>", "\x00").Replace(template), "\x00")
	if len(parts) == 0 || holes != len(parts) {
		return "" // The spike handles templates of the form literal<hole>literal<hole>…
	}
	for i := 0; i < len(name); i++ {
		if end := match(name, i, parts); end > 0 {
			return name[i:end]
		}
	}
	return ""
}

func match(name string, at int, parts []string) int {
	for _, part := range parts {
		if !strings.HasPrefix(name[at:], part) {
			return -1
		}
		at += len(part)
		digits := at
		for at < len(name) && name[at] >= '0' && name[at] <= '9' {
			at++
		}
		if at == digits {
			return -1
		}
	}
	return at
}
