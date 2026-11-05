package bearingtrace

import (
	"context"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// Trace context crosses a queue in two message attributes, as W3C Trace Context and W3C Baggage put it in headers:
// `traceparent` names the span that sent the message, and `baggage` carries the test that sent it, so the code that
// receives it, in this process or another, continues that test's trace.
const (
	TraceparentAttribute = "traceparent"
	BaggageAttribute     = "baggage"
	testBaggageKey       = "bearing.test"
	criterionBaggageKey  = "bearing.criterion"
)

// SQS allows this many attributes on a message. The hook leaves out what doesn't fit rather than fail the send.
const maxAttributes = 10

// Produced is a producer span: one send of one or more messages to a queue.
type Produced struct {
	id uint64
	s  *span
}

// Produce starts a producer span for a send to queue, under the calling goroutine's current span. It returns nil
// when tracing is off.
func Produce(queue string) *Produced {
	if !enabled {
		return nil
	}
	id := goid()
	mu.Lock()
	defer mu.Unlock()
	g := state(id)
	s := &span{spanID: spanID(), name: "send " + queue, queue: queue, operation: "send", start: time.Now().UnixNano()}
	if n := len(g.stack); n > 0 && (g.stack[n-1].test == g.test || g.stack[n-1].adopted) {
		top := g.stack[n-1]
		s.traceID, s.parentID, s.test, s.adopted = top.traceID, top.spanID, top.test, top.adopted
	} else if g.test != nil {
		s.traceID, s.test = g.test.traceID, g.test
	} else {
		s.traceID = processTr
	}
	return &Produced{id, s}
}

// Attributes are the message attributes that carry the span's context: `traceparent`, and `baggage` naming the
// test when there is one.
func (p *Produced) Attributes() map[string]string {
	if p == nil {
		return nil
	}
	attributes := map[string]string{TraceparentAttribute: "00-" + p.s.traceID + "-" + p.s.spanID + "-01"}
	if p.s.test != nil {
		baggage := testBaggageKey + "=" + percentEncode(p.s.test.name)
		if p.s.test.criterion != "" {
			baggage += "," + criterionBaggageKey + "=" + percentEncode(p.s.test.criterion)
		}
		attributes[BaggageAttribute] = baggage
	}
	return attributes
}

// End records the span, with the send's error if it failed.
func (p *Produced) End(err error) {
	if p == nil {
		return
	}
	stop := time.Now().UnixNano()
	mu.Lock()
	defer mu.Unlock()
	p.s.err = err
	record(p.s, stop)
}

// Consume records a consumer span for messages received from queue, under the span that sent the first of them
// that carries a `traceparent`, and continues that trace in the calling goroutine: the traced call that received the
// messages carries on in it from here, so the calls it makes next join the sender's trace and test. Received outside
// a traced call, the calls the goroutine makes next join it instead. Each message's attributes are by name.
func Consume(queue string, messages []map[string]string) {
	if !enabled {
		return
	}
	var traceID, parentID, testName, testCriterion string
	for _, attributes := range messages {
		if trace, span, ok := parseTraceparent(attributes[TraceparentAttribute]); ok {
			traceID, parentID = trace, span
			testName = baggageMember(attributes[BaggageAttribute], testBaggageKey)
			testCriterion = baggageMember(attributes[BaggageAttribute], criterionBaggageKey)
			break
		}
	}
	if traceID == "" {
		return
	}
	now := time.Now().UnixNano()
	id := goid()
	mu.Lock()
	defer mu.Unlock()
	g := state(id)
	var te *test
	if testName != "" {
		// The sender's criterion can come from where only it can see, such as a pytest marker.
		if testCriterion == "" {
			testCriterion = criterion(testName, tag)
		}
		te = &test{name: testName, criterion: testCriterion, traceID: traceID}
	}
	consumer := &span{traceID: traceID, spanID: spanID(), parentID: parentID, test: te, name: "receive " + queue,
		queue: queue, operation: "receive", start: now, adopted: true}
	record(consumer, now)
	marker := &span{traceID: traceID, spanID: consumer.spanID, test: te, adopted: true, marker: true}
	n := len(g.stack)
	switch {
	case n > g.base && !g.stack[n-1].marker:
		// Received in a traced call: it carries on in the message's trace until it returns.
		top := g.stack[n-1]
		continued := &span{traceID: traceID, spanID: spanID(), parentID: consumer.spanID, test: te,
			component: top.component, name: top.name, file: top.file, start: now, adopted: true}
		top.followers = append(top.followers, continued)
		g.stack = append(g.stack, continued)
	case n > g.base:
		// Received outside a traced call again: the newer message's trace replaces the last one's.
		g.stack[n-1] = marker
	default:
		g.stack = append(g.stack, marker)
	}
}

// parseTraceparent reads a version 00 `traceparent`: 00-<32 hex trace ID>-<16 hex span ID>-<flags>.
func parseTraceparent(value string) (trace, span string, ok bool) {
	parts := strings.Split(strings.TrimSpace(value), "-")
	if len(parts) != 4 || parts[0] != "00" || len(parts[1]) != 32 || len(parts[2]) != 16 || !hex(parts[1]) ||
		!hex(parts[2]) {
		return "", "", false
	}
	return parts[1], parts[2], true
}

func hex(s string) bool {
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// baggageMember finds a member's value in a `baggage` value: comma-separated key=value members, each value
// percent-encoded and maybe followed by ;properties.
func baggageMember(value, name string) string {
	for _, member := range strings.Split(value, ",") {
		key, rest, found := strings.Cut(strings.TrimSpace(member), "=")
		if !found || strings.TrimSpace(key) != name {
			continue
		}
		rest, _, _ = strings.Cut(rest, ";")
		return percentDecode(strings.TrimSpace(rest))
	}
	return ""
}

// percentEncode leaves only unreserved characters as they are, so a value never holds a comma, semicolon or space.
func percentEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-._~", c) >= 0 {
			b.WriteByte(c)
		} else {
			b.WriteString("%" + strings.ToUpper(strconv.FormatUint(uint64(c)>>4, 16)+strconv.FormatUint(uint64(c)&15, 16)))
		}
	}
	return b.String()
}

func percentDecode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				b.WriteByte(byte(n))
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// The SQS calls the rewriter routes through the hook. `bearing-go overlay` rewrites a call such as
// `client.SendMessage(ctx, input, opts...)` in a file that imports the AWS SDK for Go v2's SQS package into
// `__bt.SQSSendMessage(client.SendMessage, ctx, input, opts...)`. The hook reads and changes the input and output
// through reflection, so this package doesn't depend on the SDK; anything shaped differently passes through as it
// is.

// SQSSendMessage adds the trace context to a SendMessageInput's MessageAttributes and records a producer span.
func SQSSendMessage[In, Out, Opt any](call func(context.Context, In, ...Opt) (Out, error), ctx context.Context,
	in In, opts ...Opt) (Out, error) {
	return send(call, ctx, in, opts, func(input reflect.Value, attributes map[string]string) bool {
		return withAttributes(input, attributes)
	})
}

// SQSSendMessageBatch adds the trace context to each entry of a SendMessageBatchInput and records one producer
// span for the batch.
func SQSSendMessageBatch[In, Out, Opt any](call func(context.Context, In, ...Opt) (Out, error),
	ctx context.Context, in In, opts ...Opt) (Out, error) {
	return send(call, ctx, in, opts, func(input reflect.Value, attributes map[string]string) bool {
		entries := input.FieldByName("Entries")
		if !entries.IsValid() || entries.Kind() != reflect.Slice {
			return false
		}
		copied := reflect.MakeSlice(entries.Type(), entries.Len(), entries.Len())
		reflect.Copy(copied, entries)
		for i := 0; i < copied.Len(); i++ {
			if !withAttributes(copied.Index(i), attributes) {
				return false
			}
		}
		entries.Set(copied)
		return true
	})
}

// SQSReceiveMessage asks for the trace context's attributes as well as those the caller asked for, takes them out
// of what it returns if the caller didn't ask for them, and continues the first message's trace (see Consume).
func SQSReceiveMessage[In, Out, Opt any](call func(context.Context, In, ...Opt) (Out, error),
	ctx context.Context, in In, opts ...Opt) (Out, error) {
	if !enabled {
		return call(ctx, in, opts...)
	}
	input, ok := structCopy(in)
	if !ok {
		return call(ctx, in, opts...)
	}
	names := input.Elem().FieldByName("MessageAttributeNames")
	if !names.IsValid() || names.Type() != reflect.TypeOf([]string(nil)) {
		return call(ctx, in, opts...)
	}
	asked := names.Interface().([]string)
	var added []string
	if !askedFor(asked, TraceparentAttribute) {
		added = append(added, TraceparentAttribute)
	}
	if !askedFor(asked, BaggageAttribute) {
		added = append(added, BaggageAttribute)
	}
	names.Set(reflect.ValueOf(append(append([]string{}, asked...), added...)))
	out, err := call(ctx, input.Interface().(In), opts...)
	if err != nil {
		return out, err
	}
	output := reflect.ValueOf(out)
	if output.Kind() != reflect.Pointer || output.IsNil() || output.Elem().Kind() != reflect.Struct {
		return out, err
	}
	messages := output.Elem().FieldByName("Messages")
	if !messages.IsValid() || messages.Kind() != reflect.Slice {
		return out, err
	}
	var received []map[string]string
	for i := 0; i < messages.Len(); i++ {
		attributes := messages.Index(i).FieldByName("MessageAttributes")
		if !attributes.IsValid() || attributes.Kind() != reflect.Map {
			continue
		}
		found := map[string]string{}
		for _, name := range []string{TraceparentAttribute, BaggageAttribute} {
			if value := attributes.MapIndex(reflect.ValueOf(name)); value.IsValid() {
				found[name] = stringValue(value)
			}
		}
		received = append(received, found)
		for _, name := range added {
			if attributes.MapIndex(reflect.ValueOf(name)).IsValid() {
				attributes.SetMapIndex(reflect.ValueOf(name), reflect.Value{})
			}
		}
	}
	Consume(queueName(input.Elem()), received)
	return out, err
}

func send[In, Out, Opt any](call func(context.Context, In, ...Opt) (Out, error), ctx context.Context, in In,
	opts []Opt, inject func(input reflect.Value, attributes map[string]string) bool) (Out, error) {
	if !enabled {
		return call(ctx, in, opts...)
	}
	input, ok := structCopy(in)
	if !ok {
		return call(ctx, in, opts...)
	}
	p := Produce(queueName(input.Elem()))
	if inject(input.Elem(), p.Attributes()) {
		in = input.Interface().(In)
	}
	out, err := call(ctx, in, opts...)
	p.End(err)
	return out, err
}

// structCopy returns a pointer to a shallow copy of the struct `in` points to, so the caller's input isn't changed.
func structCopy(in any) (reflect.Value, bool) {
	value := reflect.ValueOf(in)
	if value.Kind() != reflect.Pointer || value.IsNil() || value.Elem().Kind() != reflect.Struct {
		return reflect.Value{}, false
	}
	copied := reflect.New(value.Elem().Type())
	copied.Elem().Set(value.Elem())
	return copied, true
}

// withAttributes replaces a struct's MessageAttributes with a copy holding the trace context's attributes too, as
// far as SQS's limit allows. An attribute the caller set is left as it is.
func withAttributes(message reflect.Value, attributes map[string]string) bool {
	field := message.FieldByName("MessageAttributes")
	if !field.IsValid() || field.Kind() != reflect.Map || field.Type().Key().Kind() != reflect.String {
		return false
	}
	element := field.Type().Elem()
	dataType, ok := element.FieldByName("DataType")
	stringField, ok2 := element.FieldByName("StringValue")
	pointer := reflect.TypeOf((*string)(nil))
	if element.Kind() != reflect.Struct || !ok || !ok2 || dataType.Type != pointer || stringField.Type != pointer {
		return false
	}
	copied := reflect.MakeMapWithSize(field.Type(), field.Len()+len(attributes))
	for iter := field.MapRange(); iter.Next(); {
		copied.SetMapIndex(iter.Key(), iter.Value())
	}
	for _, name := range []string{TraceparentAttribute, BaggageAttribute} {
		text, has := attributes[name]
		if !has || copied.MapIndex(reflect.ValueOf(name)).IsValid() || copied.Len() >= maxAttributes {
			continue
		}
		value := reflect.New(element).Elem()
		kind := "String"
		value.FieldByName("DataType").Set(reflect.ValueOf(&kind))
		value.FieldByName("StringValue").Set(reflect.ValueOf(&text))
		copied.SetMapIndex(reflect.ValueOf(name), value)
	}
	field.Set(copied)
	return true
}

func stringValue(attribute reflect.Value) string {
	if attribute.Kind() != reflect.Struct {
		return ""
	}
	field := attribute.FieldByName("StringValue")
	if !field.IsValid() || field.Kind() != reflect.Pointer || field.IsNil() || field.Elem().Kind() != reflect.String {
		return ""
	}
	return field.Elem().String()
}

// queueName is the last part of the input's QueueUrl, e.g. "appointment-events".
func queueName(input reflect.Value) string {
	field := input.FieldByName("QueueUrl")
	if !field.IsValid() || field.Kind() != reflect.Pointer || field.IsNil() || field.Elem().Kind() != reflect.String {
		return ""
	}
	url := strings.TrimRight(field.Elem().String(), "/")
	return url[strings.LastIndex(url, "/")+1:]
}

func askedFor(names []string, name string) bool {
	for _, asked := range names {
		if asked == name || asked == "All" || asked == ".*" {
			return true
		}
		if prefix, ok := strings.CutSuffix(asked, ".*"); ok && strings.HasPrefix(name, prefix+".") {
			return true
		}
	}
	return false
}
