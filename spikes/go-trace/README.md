# Spike: tracing Go without hand instrumentation

Prototypes for [#29](https://github.com/My5t3ryMach1n3/bearing/issues/29). The decision and the measurements are in [ADR 0001](../../docs/adrs/0001-trace-go-with-an-overlay.md). This code is a reference for the Go adapter ([#30](https://github.com/My5t3ryMach1n3/bearing/issues/30)), not part of Bearing, and nothing builds or tests it in CI.

| Path | What it is |
| --- | --- |
| `reminder-worker/` | A cut-down Chairside reminder worker: components `internal/consumer`, `internal/schedule`, `internal/sms` and `internal/store`, with `#3/AC1` to `#3/AC3` subtests in `integration/`. |
| `tools/rewrite/` | The source rewriter both prototypes use. |
| `tools/bearingtrace/` | The runtime that instrumented code calls. It writes spans and test records in the TypeScript hook's format. |
| `tools/cmd/overlay/` | Prototype A, the chosen approach: writes instrumented copies and an overlay file for `GOFLAGS=-overlay=…`. |
| `tools/cmd/toolexec/` | Prototype B: a `GOFLAGS=-toolexec=…` wrapper that rewrites each compile as it runs. |
| `bench.sh` | Measures build time and per-call overhead for no tracing, A and B. |

## Running it

Needs Go 1.21 or later.

```sh
./bench.sh            # the ADR's table; ./bench.sh 1 for a quick run
```

To see the traces from prototype A:

```sh
W=$PWD/work R=$PWD/reminder-worker
mkdir -p $W && cat > $W/settings.json <<JSON
{"root":"$R","components":[{"id":"eventConsumer","path":"internal/consumer"},
 {"id":"scheduler","path":"internal/schedule"},{"id":"smsSender","path":"internal/sms"},
 {"id":"reminderStore","path":"internal/store"}]}
JSON
(cd tools && go build -o $W/overlay ./cmd/overlay)
$W/overlay -settings $W/settings.json -module $R -runtime tools/bearingtrace/trace.go -out $W/a
(cd $R && BEARING_GO_TRACE_DIR=$W/traces BEARING_GO_TRACE_TAG='#<issue>/AC<n>' BEARING_GO_TRACE_RUN=$RANDOM \
  GOFLAGS=-overlay=$W/a/overlay.json go test ./...)
cat $W/traces/tests-*.jsonl
```

For prototype B, build `./cmd/toolexec`. Then run the tests with `GOFLAGS=-toolexec=$W/toolexec`, `BEARING_GO_TRACE_SETTINGS=$W/settings.json` and `BEARING_GO_TRACE_RUNTIME_SRC=$PWD/tools/bearingtrace`.

## Left for #30

- The runtime reads `BEARING_GO_TRACE_DIR` and `BEARING_GO_TRACE_TAG`. The adapter should read them from `BEARING_TRACE` instead, the way the TypeScript hook does.
- Templates for the criterion tag are limited to text with `<issue>` and `<n>` holes in it. The default template, `#<issue>/AC<n>`, is one of these.
- Spans don't record errors yet. TypeScript sets status code 2 when a call throws.
- There's no `-mod=vendor` support (see the ADR).
- `tracedFunctions` is `rewrite.TracedFunctions`. The adapter calls it, or ports it to TypeScript.
