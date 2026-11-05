package bearingtrace

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// A request to another service is recorded as a client span under the traced call that sent it, named for its
// method and host. Only the caller is traced: the request goes out as the code made it, and Bearing's trace path
// check finds the container its host reaches from the Kubernetes Services.
//
// The standard library can't be changed through the overlay, so the hook wraps transports instead. `bearing-go
// overlay` routes the Transport of each http.Client composite literal in a file that imports net/http through
// HTTPTransport, and tracing on wraps http.DefaultClient's, which http.Get, http.Post and the like send through.

func init() {
	if enabled && http.DefaultClient.Transport == nil {
		http.DefaultClient.Transport = HTTPTransport(nil)
	}
}

// HTTPTransport wraps a client's transport so each request it sends is recorded. A nil transport stands for
// http.DefaultTransport, read when the request goes out, as http.Client reads it. With tracing off it returns the
// transport as it is.
func HTTPTransport(base http.RoundTripper) http.RoundTripper {
	if !enabled {
		return base
	}
	if _, ok := base.(*transport); ok {
		return base
	}
	return &transport{base}
}

type transport struct{ base http.RoundTripper }

func (t *transport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	s := startRequest(req)
	resp, err := base.RoundTrip(req)
	if s != nil {
		stop := time.Now().UnixNano()
		mu.Lock()
		s.err = err
		record(s, stop)
		mu.Unlock()
	}
	return resp, err
}

// CloseIdleConnections passes on to the wrapped transport, as http.Client.CloseIdleConnections expects.
func (t *transport) CloseIdleConnections() {
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	if closer, ok := base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

// startRequest starts a client span for req under the calling goroutine's current span. A request sent outside
// every traced call, such as the test's own, comes from no component, so it isn't recorded. http.Client sends
// through its transport on the goroutine that called it.
func startRequest(req *http.Request) *span {
	if req == nil || req.URL == nil {
		return nil
	}
	method := strings.ToUpper(req.Method)
	if method == "" {
		method = http.MethodGet
	}
	host := req.URL.Hostname()
	port, _ := strconv.Atoi(req.URL.Port())
	id := goid()
	mu.Lock()
	defer mu.Unlock()
	g := state(id)
	n := len(g.stack)
	if n == 0 {
		return nil
	}
	s := &span{spanID: spanID(), name: method + " " + host, method: method, host: host, port: port,
		start: time.Now().UnixNano()}
	// Under the current span, as Span nests a call, unless that span outlived its test.
	if top := g.stack[n-1]; top.test == g.test || top.adopted {
		s.traceID, s.parentID, s.test, s.adopted = top.traceID, top.spanID, top.test, top.adopted
	} else if g.test != nil {
		s.traceID, s.test = g.test.traceID, g.test
	} else {
		s.traceID = processTr
	}
	return s
}
