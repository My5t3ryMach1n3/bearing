# 0001. Trace Go by rewriting source into a build overlay

Date: 2026-11-03

## Status

Accepted. Building the adapter in [#30](https://github.com/My5t3ryMach1n3/bearing/issues/30) changed how goroutine IDs get into the runtime and corrected the `-cover` row below; see [What building the adapter found](#what-building-the-adapter-found).

## Context

The Go adapter ([#30](https://github.com/My5t3ryMach1n3/bearing/issues/30)) needs a trace hook that records a span for each call into a component's code, plus a record for each test, in the format the TypeScript hook writes (see [Writing a language adapter](../language-adapters.md#the-trace-hook)). It has to work without anyone instrumenting code by hand. Node modules can be wrapped at runtime as they load. Go code can't, so the wrapping has to happen when the code is built.

The spike for [#29](https://github.com/My5t3ryMach1n3/bearing/issues/29) prototyped both options the issue named. It ran them on a cut-down Chairside reminder worker with four components (`consumer`, `schedule`, `sms` and `store`) and the `#3/AC1` to `#3/AC3` subtests from the [worked example](https://claude.ai/code/artifact/4b47956a-6da1-4208-a2cf-df0dd14c2e04). The code is in [`spikes/go-trace`](../../spikes/go-trace).

The two prototypes share everything except how the rewritten code gets into the build:

- **A rewriter**, using `go/ast`. It inserts `defer __bt.Span(component, name, file)()` at the top of each exported function and of each exported method on an exported type. That matches the TypeScript hook, which wraps exports only. It inserts `__bt.Test(t, file)` at the top of each `TestXxx` function and each function literal passed to `t.Run`. Every insertion is followed by a `/*line*/` directive, so compile errors, panics and coverage report the original file, line and column.
- **A runtime package**, using only the standard library. Go has no goroutine-local storage, so it keys state by goroutine ID. A goroutine started by the code under test takes its test and parent span from the goroutine that started it, which keeps work done in a consumer's own goroutine inside the test's trace.
- **One file added to the `runtime` package** that returns the goroutine's ID and its parent's (`g.goid` and `g.parentGoid`). Reading them from `runtime.Stack` instead cost 11 µs a call at a shallow stack and 40 µs at 50 frames deep. Reading the fields directly costs a constant amount.

The prototypes:

- **A. Generated wrappers through `-overlay`.** Before the test command runs, Bearing writes instrumented copies of the traced files and an overlay file that maps each original to its copy. The overlay also replaces `go.mod` with one that `require`s the runtime module and `replace`s it with a directory under `.bearing/`. `bearing test` runs the test command with `GOFLAGS=-overlay=<file>`. Nothing in the working tree changes.
- **B. `go build -toolexec`.** `bearing test` runs the test command with `GOFLAGS=-toolexec=<wrapper>`. The wrapper rewrites the files of each `compile` it sees, and adds the runtime's archive to that compile's and the link's `importcfg`. The runtime isn't in the module's build graph, so the wrapper builds it separately on first use. It also has to add its own hash to the `-V=full` output of `compile` and `link` to keep the go command's cache correct.

Both prototypes produce the same traces: 6 test records and 38 spans. In each criterion's trace they show the dynamic view's path, `Consumer.Poll → Scheduler.Schedule` and `Scheduler.RunDue → Sender.Send`. `FormatWelsh` is never called, which is what the surplus check needs.

### Measurements

These are medians of 3 runs of `go test -count=1 ./...` on the reminder worker, with Go 1.26.2 on an i7-13620H (16 threads). [`bench.sh`](../../spikes/go-trace/bench.sh) reproduces them. A's times include writing the overlay.

| Mode | Cold cache (s) | Cache from a plain build (s) | Warm (s) | After editing one file (s) | Per traced call (ns) | Per call, 50 frames deep (ns) |
| --- | --- | --- | --- | --- | --- | --- |
| No tracing | 6.00 | 0.33 | 0.29 | 0.29 | 291 | 315 |
| A. Overlay | 6.04 | 4.74 | 0.42 | 0.49 | 3,129 | 3,394 |
| B. Toolexec | 9.04 | 6.18 | 0.32 | 0.39 | 3,325 | 3,142 |

- The "Cache from a plain build" column is the usual first CI run. Both approaches rebuild the standard library there, because of the file they add to `runtime`. That happens once per cache.
- B's cold build takes half as long again, because every one of the roughly 300 compiles in a cold build goes through the wrapper process. B also changes the tool ID whenever the hook or the component paths change, which forces a full rebuild of the standard library. A only changes the files it rewrites.
- Per-call cost is the runtime's, so it's the same for both approaches: about 3 µs a call, flat with stack depth. Most of it is building the span's JSON. A test making 1,000 traced calls pays about 3 ms.
- Both tools take about 5 to 9 s to build the first time. After that the go cache keeps them.

### Compatibility

| Case | A. Overlay | B. Toolexec |
| --- | --- | --- |
| `-race` | Works | Fails to link: the separately built runtime doesn't match the race-built standard library (`fingerprint mismatch`). B would have to copy every flag that changes compiled code into its own build. |
| `-cover` | Builds, but the packages it covers go untraced (see below) | Works |
| Cached test results | Works once the runtime reads `BEARING_GO_TRACE_RUN` while a test runs | Also needed its hash added to `link -V=full`. Without it, a changed runtime left a stale test binary in the cache. |
| `go.work` workspace | Works | Works |
| `-mod=vendor` | Fails: `vendor/modules.txt` doesn't list the runtime, and the overlay doesn't reach that file | Works |
| Positions in errors and panics | Original file, line and column | Original file, line and column |

## Decision

The Go trace hook uses approach A. The adapter's `traceHook.env` writes instrumented copies of the traced files and an overlay file to `.bearing/`, then adds `-overlay=<file>` to `GOFLAGS` and a fresh `BEARING_GO_TRACE_RUN`. The go command builds the runtime like any other dependency.

This settles the build plan's open question on tracing Go without hand instrumentation.

## Alternatives considered

- B. Toolexec: rejected. It works only by acting like the go command: building a package outside the build graph, copying build flags and managing cache keys. The spike hit two bugs from that (`-race` and a stale cached binary), and its cold build takes 50% longer. Its one advantage over A is vendor mode, and A can get that by writing the runtime into `vendor/`.
- Reading goroutine IDs from `runtime.Stack`, so the standard library isn't touched: rejected. It costs 3.5 to 12 times as much per call, and the cost grows with stack depth. It would save about 4 s on the first build per cache.
- Asking teams to add `defer bearing.Span()` or a blank import themselves: rejected. That is the hand instrumentation the issue rules out, and agents would have to keep it up.

## Consequences

- Only documented go command features are involved: `-overlay`, `GOFLAGS`, and a `replace` to a local directory. `-race`, `-cover`, build caching and test caching keep working without extra code.
- The added `runtime` file depends on two unexported fields of the goroutine struct, `goid` and `parentGoid`, and on `//go:linkname`. A new Go release could rename them. #30 needs a CI job on the latest Go and the oldest version Bearing supports. `parentGoid` arrived in Go 1.21, so that's the floor.
- Vendored modules aren't supported yet. #30 should write the runtime into `vendor/` for the run, or say clearly that Bearing can't trace a vendored module.
- A goroutine inherits whatever span is current when it makes its first traced call, not the span that was current when it started. A goroutine started by `Consumer.Run` shows up beside `Run` in the test's trace, not under it. Trace paths still match. If they ever need the exact parent, the rewriter can wrap `go` statements in component code.
- The hook only reaches processes the go command builds with these `GOFLAGS`. A worker started from a prebuilt binary or a separate container isn't traced, the same as the TypeScript hook.
- Spans from code that runs after a binary's last test ends are lost: test binaries exit without running exit hooks. They belong to no test, so no check reads them.
- Worth revisiting if the go command gains a supported way to add instrumentation, or if `-overlay` stops applying to the standard library.

## What building the adapter found

The spike only ran Go 1.26 from a normal install. Running the adapter on Go 1.21 to 1.26, and on toolchains the go command downloads itself, showed three things the spike missed. The approach still stands.

- **Before Go 1.24, `go vet` reads the standard library from disk.** `go test` runs vet over every dependency, and vet couldn't open the file the overlay *added* to `runtime`, so every run failed. The overlay now replaces `runtime/stubs.go` with a copy that has `bearingGoids` appended. `stubs.go` exists without build constraints, and imports `unsafe`, in every release from 1.21 to 1.26. Vet reads the original and the compiler reads the copy.
- **Go 1.25 and later refuse an overlay of any file under `GOMODCACHE`.** That's where the go command keeps a toolchain it downloads for `GOTOOLCHAIN` or a `toolchain` line in `go.mod`. For those toolchains, the runtime reads goroutine IDs from `runtime.Stack` instead, the alternative rejected above for its cost. `bearingtrace/goids.go` on disk is that version. Where every module's toolchain allows it, the overlay swaps in the version that reads `g.goid` directly.
- **`-cover` and `-coverpkg` drop the overlay.** The go command hands the cover tool each covered package's files by their path on disk ([`cmd/go/internal/work/exec.go`](https://github.com/golang/go/blob/master/src/cmd/go/internal/work/exec.go), `sourceFile := filepath.Join(p.Dir, file)`). So a covered package is built without its spans. Packages that aren't covered are still traced. The runtime notes when a test binary collects coverage, and `bearing test` warns that the traces are incomplete. Fixing it would take a `-toolexec` wrapper for the cover tool alone, which brings back the toolexec problems above.

CI runs the adapter's tests on Go 1.21, on the latest Go, and on a downloaded Go 1.25 toolchain for the stack trace fallback. Vendored modules are still unsupported: `bearing test` stops with a message asking for `GOFLAGS=-mod=mod`.
