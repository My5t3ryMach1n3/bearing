package bearingtrace

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Shaped like the AWS SDK for Go v2's SQS types, which this package doesn't import.
type attributeValue struct {
	DataType    *string
	StringValue *string
}

type sendInput struct {
	QueueUrl          *string
	MessageBody       *string
	MessageAttributes map[string]attributeValue
}

type batchEntry struct {
	Id                *string
	MessageAttributes map[string]attributeValue
}

type batchInput struct {
	QueueUrl *string
	Entries  []batchEntry
}

type receiveInput struct {
	QueueUrl              *string
	MessageAttributeNames []string
}

type message struct {
	Body              *string
	MessageAttributes map[string]attributeValue
}

type receiveOutput struct{ Messages []message }

type options struct{}

func str(s string) *string { return &s }

const queueURL = "http://localhost:4566/000000000000/appointment-events"

// tracing turns the runtime on, writing to a new directory, until the test ends.
func tracing(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	mu.Lock()
	oldDir, oldEnabled, oldTag := dir, enabled, tag
	dir, enabled, tag, spansOut, pending = d, true, parseTag("#<issue>/AC<n>"), nil, nil
	goroutines = map[uint64]*goroutine{}
	mu.Unlock()
	t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		if spansOut != nil {
			spansOut.Close()
		}
		dir, enabled, tag, spansOut, pending = oldDir, oldEnabled, oldTag, nil, nil
		goroutines = map[uint64]*goroutine{}
	})
	return d
}

type spanLine struct {
	TraceID, SpanID, ParentSpanID, Name string
	Kind                                int
	Attributes                          []struct {
		Key   string
		Value struct{ StringValue string }
	}
}

func (s spanLine) attr(key string) string {
	for _, a := range s.Attributes {
		if a.Key == key {
			return a.Value.StringValue
		}
	}
	return ""
}

// written flushes the runtime and reads back every span it wrote.
func written(t *testing.T, d string) []spanLine {
	t.Helper()
	mu.Lock()
	flush()
	mu.Unlock()
	data, err := os.ReadFile(filepath.Join(d, "spans-"+strconv.Itoa(os.Getpid())+"-0.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var spans []spanLine
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var request struct {
			ResourceSpans []struct{ ScopeSpans []struct{ Spans []spanLine } }
		}
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			t.Fatal(err)
		}
		for _, r := range request.ResourceSpans {
			for _, s := range r.ScopeSpans {
				spans = append(spans, s.Spans...)
			}
		}
	}
	return spans
}

func byName(spans []spanLine, name string) spanLine {
	for _, s := range spans {
		if s.Name == name || s.attr("messaging.operation.type") == name {
			return s
		}
	}
	return spanLine{}
}

func TestSendMessageCarriesTheTraceInItsAttributes(t *testing.T) {
	d := tracing(t)
	mu.Lock()
	state(goid()).test = &test{name: "TestBooking/#3/AC1 books", criterion: "#3/AC1", traceID: traceID()}
	mu.Unlock()
	end := Span("eventPublisher", "Publish", "app/events/publisher.go")
	in := &sendInput{QueueUrl: str(queueURL), MessageBody: str("{}"),
		MessageAttributes: map[string]attributeValue{"type": {DataType: str("String"), StringValue: str("confirmed")}}}
	var sent *sendInput
	call := func(_ context.Context, in *sendInput, _ ...func(*options)) (string, error) {
		sent = in
		return "ok", nil
	}
	if out, err := SQSSendMessage(call, context.Background(), in); out != "ok" || err != nil {
		t.Fatalf("got %q, %v", out, err)
	}
	end()

	if len(in.MessageAttributes) != 1 {
		t.Errorf("changed the caller's input: %v", in.MessageAttributes)
	}
	spans := written(t, d)
	publish, producer := byName(spans, "Publish"), byName(spans, "send")
	if producer.Kind != 4 || producer.ParentSpanID != publish.SpanID || producer.TraceID != publish.TraceID ||
		producer.attr("messaging.destination.name") != "appointment-events" ||
		producer.attr("bearing.test") != "TestBooking/#3/AC1 books" {
		t.Errorf("producer span %+v under %+v", producer, publish)
	}
	if got := *sent.MessageAttributes["traceparent"].StringValue; got != "00-"+producer.TraceID+"-"+producer.SpanID+"-01" {
		t.Errorf("traceparent %q", got)
	}
	if got := *sent.MessageAttributes["baggage"].StringValue; got !=
		"bearing.test=TestBooking%2F%233%2FAC1%20books,bearing.criterion=%233%2FAC1" {
		t.Errorf("baggage %q", got)
	}
	if *sent.MessageAttributes["type"].StringValue != "confirmed" {
		t.Error("lost the caller's attribute")
	}
}

func TestSendMessageBatchAndTheAttributeLimit(t *testing.T) {
	tracing(t)
	full := map[string]attributeValue{}
	for i := 0; i < 9; i++ {
		full["a"+strconv.Itoa(i)] = attributeValue{DataType: str("String"), StringValue: str("x")}
	}
	in := &batchInput{QueueUrl: str(queueURL), Entries: []batchEntry{{Id: str("1")}, {Id: str("2"), MessageAttributes: full}}}
	var sent *batchInput
	call := func(_ context.Context, in *batchInput, _ ...func(*options)) (int, error) {
		sent = in
		return 0, nil
	}
	SQSSendMessageBatch(call, context.Background(), in)
	if _, ok := sent.Entries[0].MessageAttributes["traceparent"]; !ok {
		t.Error("no traceparent on the first entry")
	}
	// Outside a test there's no baggage, and nine attributes leave room for one more.
	if n := len(sent.Entries[1].MessageAttributes); n != 10 {
		t.Errorf("second entry has %d attributes, want 10", n)
	}
	if in.Entries[0].MessageAttributes != nil {
		t.Error("changed the caller's entries")
	}
}

func TestReceiveMessageContinuesTheSendersTrace(t *testing.T) {
	d := tracing(t)
	const trace, parent = "0123456789abcdef0123456789abcdef", "00000000000000aa"
	call := func(_ context.Context, in *receiveInput, _ ...func(*options)) (*receiveOutput, error) {
		if strings.Join(in.MessageAttributeNames, ",") != "type,traceparent,baggage" {
			t.Errorf("asked for %v", in.MessageAttributeNames)
		}
		return &receiveOutput{Messages: []message{{Body: str("{}"), MessageAttributes: map[string]attributeValue{
			"type":        {StringValue: str("confirmed")},
			"traceparent": {StringValue: str("00-" + trace + "-" + parent + "-01")},
			"baggage":     {StringValue: str("other=1, bearing.test=TestBooking%2F%233%2FAC1%20books;p=1")},
		}}}}, nil
	}
	poll := Span("eventConsumer", "Consumer.Poll", "internal/consumer/consumer.go")
	out, _ := SQSReceiveMessage(call, context.Background(),
		&receiveInput{QueueUrl: str(queueURL), MessageAttributeNames: []string{"type"}})
	Span("scheduler", "Scheduler.Schedule", "internal/schedule/scheduler.go")()
	poll()

	if got := out.Messages[0].MessageAttributes; len(got) != 1 {
		t.Errorf("left attributes the caller didn't ask for: %v", got)
	}
	spans := written(t, d)
	consumer := byName(spans, "receive")
	if consumer.Kind != 5 || consumer.Name != "receive appointment-events" || consumer.TraceID != trace || consumer.ParentSpanID != parent ||
		consumer.attr("bearing.test") != "TestBooking/#3/AC1 books" || consumer.attr("bearing.criterion") != "#3/AC1" {
		t.Errorf("consumer span %+v", consumer)
	}
	var continued, schedule spanLine
	for _, s := range spans {
		if s.Name == "Consumer.Poll" && s.TraceID == trace {
			continued = s
		}
		if s.Name == "Scheduler.Schedule" {
			schedule = s
		}
	}
	if continued.ParentSpanID != consumer.SpanID || continued.attr("bearing.component") != "eventConsumer" {
		t.Errorf("Poll isn't continued under the consumer span: %+v", continued)
	}
	if schedule.TraceID != trace || schedule.ParentSpanID != continued.SpanID ||
		schedule.attr("bearing.test") != "TestBooking/#3/AC1 books" {
		t.Errorf("Schedule didn't join the sender's trace: %+v", schedule)
	}
	// Poll itself still ends in the trace it started in.
	elsewhere := 0
	for _, s := range spans {
		if s.Name == "Consumer.Poll" && s.TraceID != trace {
			elsewhere++
		}
	}
	if elsewhere != 1 {
		t.Errorf("got %d Poll spans in their own trace, want 1", elsewhere)
	}
	mu.Lock()
	defer mu.Unlock()
	if g := goroutines[goid()]; len(g.stack) != 0 {
		t.Errorf("left %d spans on the stack", len(g.stack))
	}
}

func TestReceivedOutsideATracedCall(t *testing.T) {
	d := tracing(t)
	Consume("appointment-events", []map[string]string{
		{},
		{"traceparent": "00-0123456789abcdef0123456789abcdef-00000000000000aa-01"},
	})
	Span("eventConsumer", "Handle", "internal/consumer/consumer.go")()
	spans := written(t, d)
	handle, consumer := byName(spans, "Handle"), byName(spans, "receive")
	if handle.ParentSpanID != consumer.SpanID || handle.TraceID != consumer.TraceID {
		t.Errorf("Handle %+v isn't under %+v", handle, consumer)
	}
}

func TestParsingTraceContext(t *testing.T) {
	for _, bad := range []string{"", "01-0123456789abcdef0123456789abcdef-00000000000000aa-01",
		"00-0123-00000000000000aa-01", "00-0123456789ABCDEF0123456789abcdef-00000000000000aa-01"} {
		if _, _, ok := parseTraceparent(bad); ok {
			t.Errorf("parsed %q", bad)
		}
	}
	if got := baggageMember("x=1,bearing.test=a%2Cb%3Bc%25;p", "bearing.test"); got != "a,b;c%" {
		t.Errorf("got %q", got)
	}
	if got := percentDecode(percentEncode("TestX/#3/AC1 ü,;")); got != "TestX/#3/AC1 ü,;" {
		t.Errorf("round trip got %q", got)
	}
}
