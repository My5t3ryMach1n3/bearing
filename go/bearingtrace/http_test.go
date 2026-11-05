package bearingtrace

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// answer stands in for the network: it answers every request with its URL.
type answer struct{ got []string }

func (a *answer) RoundTrip(req *http.Request) (*http.Response, error) {
	a.got = append(a.got, req.Method+" "+req.URL.String())
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(req.URL.String())), Request: req}, nil
}

func TestHTTPTransportRecordsRequestsFromTracedCalls(t *testing.T) {
	d := tracing(t)
	network := &answer{}
	client := &http.Client{Transport: HTTPTransport(network)}
	mu.Lock()
	state(goid()).test = &test{name: "TestBooking/#1/AC1_books_a_slot", criterion: "#1/AC1", traceID: traceID()}
	mu.Unlock()

	// The test's own request comes from no component.
	if _, err := client.Get("http://booking-api:8000/health"); err != nil {
		t.Fatal(err)
	}
	func() {
		defer Span("bookingClient", "Client.ListSlots", "web/client/client.go")()
		if _, err := client.Get("http://booking-api:8000/slots"); err != nil {
			t.Fatal(err)
		}
		req, _ := http.NewRequest("", "http://booking-api.chairside.svc.cluster.local/bookings", nil)
		if _, err := client.Do(req); err != nil {
			t.Fatal(err)
		}
	}()
	if len(network.got) != 3 {
		t.Fatalf("sent %v, want all three requests", network.got)
	}
	spans := written(t, d)
	call := byName(spans, "Client.ListSlots")
	var requests []string
	for _, s := range spans {
		if s.Kind != 3 {
			continue
		}
		if s.ParentSpanID != call.SpanID || s.TraceID != call.TraceID {
			t.Errorf("%s isn't under the call that sent it", s.Name)
		}
		if s.attr("bearing.test") != "TestBooking/#1/AC1_books_a_slot" || s.attr("bearing.criterion") != "#1/AC1" {
			t.Errorf("%s isn't the test's: %+v", s.Name, s.Attributes)
		}
		if s.attr("bearing.component") != "" {
			t.Errorf("%s has a component", s.Name)
		}
		requests = append(requests, s.Name+" "+s.attr("http.request.method")+" "+s.attr("server.address"))
	}
	want := []string{
		"GET booking-api GET booking-api",
		"GET booking-api.chairside.svc.cluster.local GET booking-api.chairside.svc.cluster.local",
	}
	if strings.Join(requests, "\n") != strings.Join(want, "\n") {
		t.Errorf("got requests\n%s\nwant\n%s", strings.Join(requests, "\n"), strings.Join(want, "\n"))
	}
}

func TestHTTPTransportWritesThePortTheURLGives(t *testing.T) {
	d := tracing(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer server.Close()
	address, _ := url.Parse(server.URL)
	func() {
		defer Span("bookingClient", "Client.Ping", "web/client/client.go")()
		// A nil transport is http.DefaultTransport's.
		resp, err := (&http.Client{Transport: HTTPTransport(nil)}).Get(server.URL)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}()
	mu.Lock()
	flush()
	mu.Unlock()
	data, err := os.ReadFile(filepath.Join(d, "spans-"+strconv.Itoa(os.Getpid())+"-0.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	raw := string(data)
	if !strings.Contains(raw, `{"key":"server.port","value":{"intValue":"`+address.Port()+`"}}`) {
		t.Errorf("no server.port %s in %s", address.Port(), raw)
	}
}

func TestHTTPTransportIsTheTransportWithTracingOff(t *testing.T) {
	network := &answer{}
	if got := HTTPTransport(network); got != http.RoundTripper(network) {
		t.Errorf("wrapped the transport with tracing off")
	}
	if HTTPTransport(nil) != nil {
		t.Errorf("a nil transport isn't left nil with tracing off")
	}
	tracing(t)
	once := HTTPTransport(network)
	if HTTPTransport(once) != once {
		t.Errorf("wrapped a wrapped transport again")
	}
}
