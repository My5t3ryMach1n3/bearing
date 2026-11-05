// Package bearingtrace is the Go trace hook's runtime. Instrumented code calls Span at the top of every traced
// function and Test at the top of every test function; nothing else in the code under test changes.
//
// It writes the same files as the TypeScript hook (src/trace/runtime.ts): OTLP JSON span lines to
// spans-<pid>-0.jsonl and test records to tests-<pid>-0.jsonl in the traces directory. `bearing test` passes the
// directory and the criterion tag template in $BEARING_TRACE, as it does to the TypeScript hook.
//
// Go has no goroutine-local storage, so the runtime keys its state by goroutine ID, and takes a new goroutine's
// test and parent span from the goroutine that started it. That way a call made from a goroutine the code under
// test starts still joins the test's trace.
//
// Bearing's Go adapter (src/lang/go.ts) adds this module to the build with an overlay; see
// docs/adrs/0001-trace-go-with-an-overlay.md.
package bearingtrace

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
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
	// Set on a span that continues a trace a message brought in, and on the spans under it: they join that trace
	// whichever test, if any, the goroutine is running.
	adopted bool
	// For a messaging span: the queue's name, "send" or "receive", and how the call ended.
	queue, operation string
	err              error
	// Spans that continue this one in a message's trace, which end when it does. See Consume.
	followers []*span
	// A span on the stack only as a parent for what follows, which is never written: a message's consumer span
	// when the code that received it wasn't in a traced call.
	marker bool
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

// The part of $BEARING_TRACE the runtime reads. See TraceSettings in src/trace/env.ts.
type settings struct {
	Dir string `json:"dir"`
	Tag string `json:"tag"`
}

func readSettings() settings {
	var s settings
	if v := os.Getenv("BEARING_TRACE"); v != "" {
		if err := json.Unmarshal([]byte(v), &s); err != nil {
			panic("bearing: can't read BEARING_TRACE: " + err.Error())
		}
	}
	return s
}

var (
	config  = readSettings()
	dir     = config.Dir
	tag     = parseTag(config.Tag)
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
	if n := len(g.stack); n > 0 && (g.stack[n-1].test == g.test || g.stack[n-1].adopted) {
		top := g.stack[n-1]
		s.traceID, s.parentID, s.test, s.adopted = top.traceID, top.spanID, top.test, top.adopted
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
	for _, f := range s.followers {
		record(f, stop)
	}
	record(s, stop)
	// The span and anything above it: a span continuing it in a message's trace, or a marker.
	if g := goroutines[id]; g != nil {
		for i := len(g.stack) - 1; i >= g.base; i-- {
			if g.stack[i] == s {
				g.stack = g.stack[:i]
				break
			}
		}
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
	coverOnce.Do(noteCoverage)
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

// record queues a span to be written. Called with mu held.
func record(s *span, stop int64) {
	pending = append(pending, spanJSON(s, stop))
	pendingBytes += len(pending[len(pending)-1])
}

func noop() {}

var coverOnce sync.Once

// noteCoverage leaves a go-cover-<pid> file in the traces directory if the test binary is collecting coverage. The
// go command hands the cover tool each covered package's files from disk rather than from the overlay, so a
// package that -cover or -coverpkg covers is built without its spans, and Bearing warns that traces are missing.
func noteCoverage() {
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "-test.gocoverdir=") || strings.HasPrefix(arg, "-test.coverprofile=") {
			os.MkdirAll(dir, 0o755)
			if f, err := os.Create(dir + "/go-cover-" + strconv.Itoa(os.Getpid())); err == nil {
				f.Close()
			}
			return
		}
	}
}

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
	kind, status := "1", `{"code":1}`
	var attrs []string
	if s.queue != "" {
		// OpenTelemetry's messaging conventions; the component is the queue, which Bearing finds by name.
		kind = map[string]string{"send": "4", "receive": "5"}[s.operation]
		attrs = []string{
			attr("messaging.system", "aws_sqs"),
			attr("messaging.operation.type", s.operation),
			attr("messaging.destination.name", s.queue),
		}
	} else {
		attrs = []string{
			attr("bearing.component", s.component),
			attr("code.function.name", s.name),
			attr("code.file.path", s.file),
		}
	}
	if s.err != nil {
		status = `{"code":2,"message":` + quote(s.err.Error()) + `}`
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
		`,"kind":` + kind + `,"startTimeUnixNano":"` + strconv.FormatInt(s.start, 10) + `","endTimeUnixNano":"` +
		strconv.FormatInt(stop, 10) + `","attributes":[` + strings.Join(attrs, ",") + `],"status":` + status + `}`
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

// A criterion tag template split at its placeholders: literal, digits, literal, digits, … literal. The config only
// allows templates holding both <issue> and <n>.
type template []string

func parseTag(tag string) template {
	if tag == "" {
		return nil
	}
	return strings.Split(strings.NewReplacer("<issue>", "\x00", "<n>", "\x00").Replace(tag), "\x00")
}

// criterion finds the first tag in a test's name, as the TypeScript runtime's criterionPattern does, and returns it
// as the template writes it. Go writes the spaces in a subtest's name as underscores, so a space in the template
// also matches an underscore.
func criterion(name string, t template) string {
	if len(t) < 2 {
		return ""
	}
	for i := 0; i < len(name); i++ {
		if numbers, ok := match(name[i:], t); ok {
			var b strings.Builder
			for j, part := range t {
				b.WriteString(part)
				if j < len(numbers) {
					b.WriteString(numbers[j])
				}
			}
			return b.String()
		}
	}
	return ""
}

func match(name string, t template) ([]string, bool) {
	var numbers []string
	at := 0
	for j, part := range t {
		for k := 0; k < len(part); k++ {
			if at >= len(name) || !(name[at] == part[k] || part[k] == ' ' && name[at] == '_') {
				return nil, false
			}
			at++
		}
		if j == len(t)-1 {
			break
		}
		digits := at
		for at < len(name) && name[at] >= '0' && name[at] <= '9' {
			at++
		}
		if at == digits {
			return nil, false
		}
		numbers = append(numbers, name[digits:at])
	}
	return numbers, true
}
