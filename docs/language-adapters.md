# Writing a language adapter

Bearing reads code through one adapter per language. The checks themselves (boundaries, coverage, trace paths and surplus) never look at a language's syntax: they work from what the adapters return. Adding a language means writing an adapter. No check needs to change.

The interface is in [`src/lang/adapter.ts`](../src/lang/adapter.ts). The TypeScript adapter in [`src/lang/typescript.ts`](../src/lang/typescript.ts) is the reference implementation. The Go adapter in [`src/lang/go.ts`](../src/lang/go.ts) shows how to handle a language whose code can't be wrapped as it loads. It shells out to a small Go command in [`go/`](../go) for parsing and rewriting, and Bearing builds that command on first use. The Python adapter in [`src/lang/python.ts`](../src/lang/python.ts) runs Python code it ships in [`python/`](../python) with the system's interpreter to read code, and loads it into the project's tests as a pytest plugin.

## What an adapter provides

| Member | Used by | What it does |
| --- | --- | --- |
| `name` | config | The value of `name` under `languages:`, e.g. `python`. |
| `sourceFile` | derive, claim, surplus | A pattern matching the language's source files by repo-relative path. Bearing uses it to decide which language owns a file. |
| `extractImports` | `bearing derive`, Boundaries check | Reads the code under one configured root without running it. Returns every source file found and each import that reaches from one component's code into another's. |
| `traceHook.env` | `bearing test` | Returns the environment the test command runs with, so the language's test processes write spans and test records to `.bearing/traces/`. |
| `traceHook.warnings` | `bearing test` | Optional. Called after the test command exits. Returns anything that left the traces incomplete, such as Go coverage, for `bearing test` to print. |
| `traceHook.tracedFunctions` | Surplus check | Lists the functions in a file that the hook records spans for. The surplus check flags any of them that no tagged test called. |
| `tagCarrier.where` | coverage and context messages | Says where a test writes its criterion tag, such as "in its name", so Bearing can tell people and agents where to put one. |

### `extractImports(root, language, components)`

- `root` is the repo root. `language` is one `languages:` entry, with `root` and `project` already normalized, and `project` relative to `root`.
- `components` are the target's component paths, ordered longest first. Use `componentOf` from `src/paths.ts` to find which component owns a file.
- Return repo-relative paths with forward slashes. Leave out tests and declaration files (`testFile` and `declarationFile` in `src/paths.ts`).
- An import counts towards the component that declares the code it uses, not the module it names. Follow re-exports and barrels where the language has them. Leave out packages, code outside the repo, and imports within one component.
- Throw `DeriveError` with a message that names the config key to fix when the project file is missing or broken.

Bearing merges every language's result. When two configured roots hold the same file, it counts once, for the deepest root whose adapter's `sourceFile` matches.

### The trace hook

The hook runs inside the test processes and reports through files, not through Bearing's own process. `bearing test` passes it a `TraceSettings` (see [`src/trace/env.ts`](../src/trace/env.ts)) holding the repo root, the traces directory, the tag template and the component paths. The TypeScript hook receives them as JSON in the `BEARING_TRACE` environment variable.

For each call into a function under a component path, the hook writes one span as an OTLP JSON line to a `spans-<pid>-<thread>.jsonl` file in the traces directory. The span carries these attributes from [`src/trace/runtime.ts`](../src/trace/runtime.ts):

- `bearing.component`
- `code.function.name`, the function's name as `tracedFunctions` gives it
- `code.file.path`, the repo-relative file
- `bearing.test`, the running test's full name
- `bearing.criterion`, the test's criterion tag, when it has one

Calls nested inside a span are its children.

Where the language's SQS client can be reached, the hook should also carry the trace through queues, as the Python and Go hooks do (see [Traces across a queue](product-spec.md#traces-across-a-queue)). A message sent to a queue gets a producer span with `messaging.operation.type` set to `send` and `messaging.destination.name` to the queue's name, the last part of its URL, and the `traceparent` and `baggage` attributes (`bearing.test` and `bearing.criterion`, percent-encoded). A message received with a `traceparent` gets a consumer span under the producer span, with `messaging.operation.type` set to `receive`, and the call that received it carries on in that trace and test. Messaging spans have no `bearing.component` or `code.*` attributes: the trace path check finds the queue's element by name.

The hook should also record the HTTP requests a traced call sends through the language's common HTTP clients, as the Python, Go and TypeScript hooks do (see [Traces across HTTP](product-spec.md#traces-across-http)). Each gets a client span under the call that sent it, named for its method and host, with `http.request.method`, `server.address` and, when the URL gives one, `server.port` as an integer. Leave the request as the code made it, and don't record a request made outside every traced call. HTTP spans have no `bearing.component` or `code.*` attributes: the trace path check finds the container the host's Kubernetes Service reaches.

When each test ends, the hook writes one record to a `tests-<pid>-<thread>.jsonl` file, in the `TestRecord` shape: name, file, status (`passed`, `failed` or `skipped`) and criterion. Use `criterionPattern(tag)` to find the tag wherever `tagCarrier` says tests carry it.

`env` gets the environment as other adapters have left it, and must add to it rather than replace it. It also gets the `languages:` entries the adapter reads, so it can find each one's project. If tracing can't work, for example because the runtime is too old, throw `TraceHookError`.

`tracedFunctions` must agree with the hook. If the hook only wraps exported functions, list only exported functions. Otherwise surplus will flag code the hook could never have seen called.

## Adding one

1. Add the language to `languageNames` in `src/config.ts`. Give it a default project file in `defaultProject`.
2. Write the adapter in `src/lang/<language>.ts`, and register it in `adapters` in `src/lang/index.ts`.
3. Test it against a small repo in the language, the way `test/derive.test.ts` and `test/trace.test.ts` test TypeScript. The bar is the same checks on the same model: a fixture in the new language should give the same Boundaries, Criteria coverage, Trace paths and Surplus results as the TypeScript basket service.
4. Document the language's project file and how its tests carry tags in the Config section of the [product spec](product-spec.md).

## Config

A repo in one language can keep using `language:` and `tsconfig:`. A repo with several languages, or with code that isn't at the repo root, lists each one under `languages:`:

```yaml
languages:
  - name: typescript
    root: services/web        # default: the repo root
    project: tsconfig.json    # relative to root; default: the language's own
  - name: typescript
    root: services/api
```

The same language can be listed more than once, once per root.
