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

func TestFileRoutesSQSCallsThroughTheHook(t *testing.T) {
	src := `package awsqueue

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

type Queue struct{ client *sqs.Client }

func (q Queue) send(ctx context.Context, in *sqs.SendMessageInput) error {
	_, err := q.client.SendMessage(ctx, in, func(*sqs.Options) {})
	return err
}

func (q Queue) receive(ctx context.Context, opts []func(*sqs.Options)) {
	q.client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{}, opts...)
	q.client.SendMessageBatch(ctx)
}
`
	// In no component, so only the SQS calls change.
	out, err := File("/repo/internal/awsqueue/queue.go", []byte(src), settings)
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	for _, want := range []string{
		`package awsqueue; import __bt "example.com/bearingtrace"`,
		`_, err := __bt.SQSSendMessage(/*line /repo/internal/awsqueue/queue.go:12:12*/q.client.SendMessage, ` +
			`/*line /repo/internal/awsqueue/queue.go:12:33*/ctx, in, func(*sqs.Options) {})`,
		`__bt.SQSReceiveMessage(/*line /repo/internal/awsqueue/queue.go:17:2*/q.client.ReceiveMessage, ` +
			`/*line /repo/internal/awsqueue/queue.go:17:26*/ctx, &sqs.ReceiveMessageInput{}, opts...)`,
		// One argument isn't the SDK's method.
		"q.client.SendMessageBatch(ctx)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if lines := strings.Count(got, "\n"); lines != strings.Count(src, "\n")+1 {
		t.Errorf("got %d lines, want %d", lines, strings.Count(src, "\n")+1)
	}
	// Without the SDK's import, a method of the same name is someone else's.
	plain := strings.Replace(src, `"github.com/aws/aws-sdk-go-v2/service/sqs"`, `sqs "example.com/fake"`, 1)
	if out, _ := File("/repo/internal/awsqueue/queue.go", []byte(plain), settings); out != nil {
		t.Errorf("rewrote a file that doesn't import the SDK:\n%s", out)
	}
}

func TestFileRoutesHTTPClientTransportsThroughTheHook(t *testing.T) {
	src := `package booking

import (
	"net/http"
	"time"
)

var plain = &http.Client{}
var timed = http.Client{Timeout: time.Second}
var multi = &http.Client{
	Timeout: time.Second,
}
var given = &http.Client{Transport: http.DefaultTransport, Timeout: time.Second}

type Client struct{ Transport http.RoundTripper }

var other = Client{}
`
	out, err := File("/repo/internal/booking/client.go", []byte(src), settings)
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	for _, want := range []string{
		`package booking; import __bt "example.com/bearingtrace"`,
		`var plain = &http.Client{Transport: __bt.HTTPTransport(nil)/*line /repo/internal/booking/client.go:8:26*/}`,
		`var timed = http.Client{Timeout: time.Second, Transport: __bt.HTTPTransport(nil)` +
			`/*line /repo/internal/booking/client.go:9:45*/}`,
		`Timeout: time.Second, Transport: __bt.HTTPTransport(nil)/*line /repo/internal/booking/client.go:11:22*/,`,
		`var given = &http.Client{Transport: __bt.HTTPTransport(/*line /repo/internal/booking/client.go:13:37*/` +
			`http.DefaultTransport)/*line /repo/internal/booking/client.go:13:58*/, Timeout: time.Second}`,
		// Another package's Client is someone else's.
		"var other = Client{}",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if lines := strings.Count(got, "\n"); lines != strings.Count(src, "\n")+1 {
		t.Errorf("got %d lines, want %d", lines, strings.Count(src, "\n")+1)
	}
	// Without net/http, an http.Client is someone else's.
	fake := strings.Replace(src, `"net/http"`, `http "example.com/fake"`, 1)
	if out, _ := File("/repo/internal/booking/client.go", []byte(fake), settings); out != nil {
		t.Errorf("rewrote a file that doesn't import net/http:\n%s", out)
	}
}
