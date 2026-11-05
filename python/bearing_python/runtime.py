"""The span runtime instrumented modules call, and the import hook that instruments them.

Writes the same files as the TypeScript runtime in src/trace/runtime.ts: one OTLP JSON `ExportTraceServiceRequest`
per line in `spans-<pid>-<thread>.jsonl`, and one test record per line in `tests-<pid>-<thread>.jsonl`. Runs on
Python 3.9 and later.
"""

from __future__ import annotations

import ast
import atexit
import contextvars
import functools
import importlib.abc
import importlib.machinery
import inspect
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.parse
from typing import Any, Callable, Optional

from .instrument import RUNTIME_NAME, instrument, is_test_file

TRACEPARENT = "traceparent"
BAGGAGE = "baggage"
TEST_BAGGAGE_KEY = "bearing.test"
CRITERION_BAGGAGE_KEY = "bearing.criterion"
# SQS allows this many attributes on a message. The hook leaves out what doesn't fit rather than fail the send.
MAX_ATTRIBUTES = 10

ATTRIBUTES = {
    "component": "bearing.component",
    "criterion": "bearing.criterion",
    "test": "bearing.test",
    "function": "code.function.name",
    "file": "code.file.path",
}


def criterion_pattern(tag: str) -> "re.Pattern[str]":
    """Matches a criterion tag, e.g. "#2/AC1" for the template "#<issue>/AC<n>". See `criterionPattern`."""
    escaped = re.escape(tag)
    return re.compile(escaped.replace(re.escape("<issue>"), r"\d+", 1).replace(re.escape("<n>"), r"\d+", 1))


class _Span:
    __slots__ = (
        "trace_id",
        "span_id",
        "parent_id",
        "test",
        "criterion",
        "name",
        "component",
        "file",
        "start",
        "adopted",
        "queue",
        "operation",
        "request",
        "followers",
    )

    def __init__(self, trace_id, span_id, parent_id, test, criterion, name, component, file, adopted=False):
        self.trace_id = trace_id
        self.span_id = span_id
        self.parent_id = parent_id
        self.test = test
        self.criterion = criterion
        self.name = name
        self.component = component
        self.file = file
        self.start = time.time_ns()
        # Set on a span that continues a trace a message brought in, and on the spans under it: they join that trace
        # whichever test, if any, is running.
        self.adopted = adopted
        # For a messaging span: the queue's name, and "send" or "receive".
        self.queue: Optional[str] = None
        self.operation: Optional[str] = None
        # For an outgoing HTTP request: (method, host, port), the port None when the URL gives none.
        self.request: Optional[tuple] = None
        # Spans continuing this one in a message's trace, which end when it does. See `Runtime.consume`.
        self.followers: list = []


class _Test:
    __slots__ = ("name", "criterion", "trace_id")

    def __init__(self, name: str, criterion: Optional[str]):
        self.name = name
        self.criterion = criterion
        self.trace_id = secrets.token_hex(16)


_current: "contextvars.ContextVar[Optional[_Span]]" = contextvars.ContextVar("bearing_span", default=None)


class Runtime:
    """One per process, from the settings `bearing test` passes in BEARING_TRACE."""

    def __init__(self, settings: dict):
        self.root = os.path.realpath(settings["root"])
        self.dir = settings["dir"]
        self.pattern = criterion_pattern(settings["tag"])
        # Longest path first, as `componentPaths` sorts them.
        self.components = sorted(settings["components"], key=lambda component: -len(component["path"]))
        self._lock = threading.Lock()
        self._pending: list = []
        self._id_prefix = secrets.token_hex(4)
        self._next_id = 0
        self._process_trace = secrets.token_hex(16)
        self._test: Optional[_Test] = None
        # One file per process: every thread writes through the lock.
        self._spans_path = os.path.join(self.dir, f"spans-{os.getpid()}-{threading.get_ident()}.jsonl")
        self._tests_path = os.path.join(self.dir, f"tests-{os.getpid()}-{threading.get_ident()}.jsonl")
        atexit.register(self.flush)

    # Which files are traced.

    def traced_file(self, path: str) -> Optional[tuple]:
        """(component, repo-relative file) for source under a component path, or None."""
        real = os.path.realpath(path)
        file = os.path.relpath(real, self.root).replace(os.sep, "/")
        if file == ".." or file.startswith("../"):
            return None
        parts = file.split("/")
        if "site-packages" in parts or "node_modules" in parts or is_test_file(file):
            return None
        for component in self.components:
            folder = component["path"]
            if folder == "." or file == folder or file.startswith(folder + "/"):
                return component["id"], file
        return None

    # Tests.

    def criterion(self, text: str) -> Optional[str]:
        match = self.pattern.search(text)
        return match.group(0) if match else None

    def test_started(self, name: str, criterion: Optional[str]) -> None:
        self._test = _Test(name, criterion)

    def test_finished(self, name: str, file: Optional[str], status: str, criterion: Optional[str]) -> None:
        self._test = None
        record: dict = {"name": name}
        if file is not None:
            record["file"] = file
        record["status"] = status
        if criterion is not None:
            record["criterion"] = criterion
        with self._lock:
            os.makedirs(self.dir, exist_ok=True)
            with open(self._tests_path, "a", encoding="utf-8") as out:
                out.write(json.dumps(record) + "\n")

    # Spans.

    def _span_id(self) -> str:
        with self._lock:
            span_id = f"{self._id_prefix}{self._next_id:08x}"
            self._next_id += 1
        return span_id

    def _start(self, name: str, component: str, file: str) -> _Span:
        test = self._test
        parent = _current.get()
        span_id = self._span_id()
        test_name = None if test is None else test.name
        # A call that outlives its test, such as a background thread's, starts a new trace, unless it carries on a
        # trace a message brought in.
        if parent is not None and (parent.test == test_name or parent.adopted):
            return _Span(
                parent.trace_id,
                span_id,
                parent.span_id,
                parent.test,
                parent.criterion,
                name,
                component,
                file,
                parent.adopted,
            )
        trace_id = self._process_trace if test is None else test.trace_id
        criterion = None if test is None else test.criterion
        return _Span(trace_id, span_id, None, test_name, criterion, name, component, file)

    def _end(self, span: _Span, error: Optional[BaseException] = None) -> None:
        for follower in span.followers:
            self._end(follower)
        if span.request is not None:
            # OpenTelemetry's HTTP conventions; the component is the container the host reaches, which Bearing finds
            # from the Kubernetes Services.
            kind = 3
            method, host, port = span.request
            attributes = [
                _attribute("http.request.method", method),
                _attribute("server.address", host),
            ]
            if port is not None:
                attributes.append(_attribute("server.port", port))
        elif span.queue is not None:
            # OpenTelemetry's messaging conventions; the component is the queue, which Bearing finds by name.
            kind = 4 if span.operation == "send" else 5
            attributes = [
                _attribute("messaging.system", "aws_sqs"),
                _attribute("messaging.operation.type", span.operation),
                _attribute("messaging.destination.name", span.queue),
            ]
        else:
            kind = 1
            attributes = [
                _attribute(ATTRIBUTES["component"], span.component),
                _attribute(ATTRIBUTES["function"], span.name),
                _attribute(ATTRIBUTES["file"], span.file),
            ]
        if span.test is not None:
            attributes.append(_attribute(ATTRIBUTES["test"], span.test))
            if span.criterion is not None:
                attributes.append(_attribute(ATTRIBUTES["criterion"], span.criterion))
        record: dict = {"traceId": span.trace_id, "spanId": span.span_id}
        if span.parent_id is not None:
            record["parentSpanId"] = span.parent_id
        record.update(
            {
                "name": span.name,
                "kind": kind,
                "startTimeUnixNano": str(span.start),
                "endTimeUnixNano": str(time.time_ns()),
                "attributes": attributes,
                "status": {"code": 1} if error is None else {"code": 2, "message": _error_message(error)},
            }
        )
        with self._lock:
            self._pending.append(record)
        if span.parent_id is None:
            self.flush()

    # Messaging. Trace context crosses a queue in two message attributes, as W3C Trace Context and W3C Baggage put it
    # in headers: `traceparent` names the span that sent the message, and `baggage` carries the test that sent it, so
    # the code that receives it, in this process or another, continues that test's trace. The Go runtime does the
    # same; see go/bearingtrace/messaging.go.

    def produce(self, queue: str) -> _Span:
        """Starts a producer span for a send to `queue`, under the current span."""
        span = self._start(f"send {queue}", "", "")
        span.queue, span.operation = queue, "send"
        return span

    @staticmethod
    def context_attributes(span: _Span) -> dict:
        """The message attributes carrying a producer span's context."""
        attributes = {TRACEPARENT: f"00-{span.trace_id}-{span.span_id}-01"}
        if span.test is not None:
            members = [f"{TEST_BAGGAGE_KEY}={urllib.parse.quote(span.test, safe='')}"]
            if span.criterion is not None:
                members.append(f"{CRITERION_BAGGAGE_KEY}={urllib.parse.quote(span.criterion, safe='')}")
            attributes[BAGGAGE] = ",".join(members)
        return attributes

    def consume(self, queue: str, messages: list) -> None:
        """Records a consumer span for messages received from `queue`, under the span that sent the first of them
        that carries a `traceparent`, and continues that trace here: the traced call that received them carries on
        in it, so the calls it makes next join the sender's trace and test. Received outside a traced call, the calls
        made next in this context join it instead. Each message is a dict of its attributes' string values."""
        found = None
        for attributes in messages:
            parsed = _parse_traceparent(attributes.get(TRACEPARENT, ""))
            if parsed is not None:
                found = (parsed, _baggage(attributes.get(BAGGAGE, "")))
                break
        if found is None:
            return
        (trace_id, parent_id), baggage = found
        test = baggage.get(TEST_BAGGAGE_KEY)
        # The sender's criterion can come from where only it can see, such as a pytest marker.
        criterion = baggage.get(CRITERION_BAGGAGE_KEY) or (None if test is None else self.criterion(test))
        consumer = _Span(trace_id, self._span_id(), parent_id, test, criterion, f"receive {queue}", "", "", True)
        consumer.queue, consumer.operation = queue, "receive"
        self._end(consumer)
        top = _current.get()
        if top is not None and top.component != "":
            continued = _Span(
                trace_id, self._span_id(), consumer.span_id, test, criterion, top.name, top.component, top.file, True
            )
            top.followers.append(continued)
            _current.set(continued)
        else:
            # A marker, never written: what this context calls next goes under the consumer span.
            marker = _Span(trace_id, consumer.span_id, None, test, criterion, "", "", "", True)
            _current.set(marker)

    # HTTP. A request to another service is recorded as a client span under the call that made it, named for its
    # method and host. Only the caller is traced: the request goes out as the code made it, and the trace path check
    # finds the container its host reaches. See http_client.py.

    def request(self, method: str, url: str) -> Optional[_Span]:
        """Starts a client span for an HTTP request to `url`, under the current span. A request made outside every
        traced call, such as the test's own through a test client, comes from no component, so it isn't recorded."""
        if _current.get() is None:
            return None
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or ""
        try:
            port = parsed.port
        except ValueError:
            port = None
        method = method.upper()
        span = self._start(f"{method} {host}", "", "")
        span.request = (method, host, port)
        return span

    def flush(self) -> None:
        with self._lock:
            if not self._pending:
                return
            request = {
                "resourceSpans": [
                    {
                        "resource": {
                            "attributes": [
                                _attribute("service.name", "bearing-test"),
                                _attribute("process.pid", os.getpid()),
                            ]
                        },
                        "scopeSpans": [{"scope": {"name": "bearing"}, "spans": self._pending}],
                    }
                ]
            }
            self._pending = []
            os.makedirs(self.dir, exist_ok=True)
            with open(self._spans_path, "a", encoding="utf-8") as out:
                out.write(json.dumps(request) + "\n")

    def module(self, component: str, file: str) -> "TracedModule":
        return TracedModule(self, component, file)


class TracedModule:
    """What an instrumented module finds as `__bearing_trace__`."""

    def __init__(self, runtime: Runtime, component: str, file: str):
        self._runtime = runtime
        self._component = component
        self._file = file

    def wrap(self, name: str) -> Callable[[Any], Any]:
        """A decorator recording a span around each call, with a wrapper of the same kind: plain, coroutine,
        generator or async generator, so frameworks that inspect a function see what they'd see unwrapped."""
        runtime, component, file = self._runtime, self._component, self._file

        def decorate(fn: Any) -> Any:
            if not callable(fn) or getattr(fn, "__bearing_traced__", False):
                return fn
            start = functools.partial(runtime._start, name, component, file)
            if inspect.iscoroutinefunction(fn):
                wrapper = _coroutine(fn, start, runtime._end)
            elif inspect.isasyncgenfunction(fn):
                wrapper = _async_generator(fn, start, runtime._end)
            elif inspect.isgeneratorfunction(fn):
                wrapper = _generator(fn, start, runtime._end)
            else:
                wrapper = _plain(fn, start, runtime._end)
            functools.update_wrapper(wrapper, fn)
            wrapper.__bearing_traced__ = True  # type: ignore[attr-defined]
            return wrapper

        return decorate


def _plain(fn, start, end):
    def wrapper(*args, **kwargs):
        span = start()
        token = _current.set(span)
        try:
            result = fn(*args, **kwargs)
        except BaseException as error:
            end(span, error)
            raise
        finally:
            _current.reset(token)
        end(span)
        return result

    return wrapper


def _coroutine(fn, start, end):
    async def wrapper(*args, **kwargs):
        span = start()
        token = _current.set(span)
        try:
            result = await fn(*args, **kwargs)
        except BaseException as error:
            end(span, error)
            raise
        finally:
            _current.reset(token)
        end(span)
        return result

    return wrapper


# A generator runs in its consumer's context between steps, so the span is current only while it runs a step. The
# span covers the generator from its call until it finishes or is closed.


def _generator(fn, start, end):
    def wrapper(*args, **kwargs):
        span = start()

        def step(call, *arguments):
            token = _current.set(span)
            try:
                return call(*arguments)
            finally:
                _current.reset(token)

        # Calling a generator function runs none of its code.
        generator = fn(*args, **kwargs)
        try:
            item = step(next, generator)
            while True:
                try:
                    sent = yield item
                except GeneratorExit:
                    step(generator.close)
                    end(span)
                    raise
                except BaseException as thrown:
                    item = step(generator.throw, thrown)
                else:
                    item = step(generator.send, sent)
        except StopIteration as stop:
            end(span)
            return stop.value
        except GeneratorExit:
            raise
        except BaseException as error:
            end(span, error)
            raise

    return wrapper


def _async_generator(fn, start, end):
    async def wrapper(*args, **kwargs):
        span = start()

        async def step(call, *arguments):
            token = _current.set(span)
            try:
                return await call(*arguments)
            finally:
                _current.reset(token)

        generator = fn(*args, **kwargs)
        try:
            item = await step(generator.__anext__)
            while True:
                try:
                    sent = yield item
                except GeneratorExit:
                    await step(generator.aclose)
                    end(span)
                    raise
                except BaseException as thrown:
                    item = await step(generator.athrow, thrown)
                else:
                    item = await step(generator.asend, sent)
        except StopAsyncIteration:
            end(span)
        except GeneratorExit:
            raise
        except BaseException as error:
            end(span, error)
            raise

    return wrapper


# The import hook.


class _Finder(importlib.abc.MetaPathFinder):
    """Finds modules as the path finder would, and loads those under a component path through `_Loader`."""

    def __init__(self, runtime: Runtime):
        self._runtime = runtime

    def find_spec(self, fullname, path, target=None):
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if spec is None or spec.origin is None or not isinstance(spec.loader, importlib.machinery.SourceFileLoader):
            return None
        traced = self._runtime.traced_file(spec.origin)
        if traced is None:
            return None
        spec.loader = _Loader(fullname, spec.origin, self._runtime, *traced)
        return spec


class _Loader(importlib.machinery.SourceFileLoader):
    """Compiles the module from its source with the trace decorators added. It never reads or writes bytecode, so
    no instrumented code is left in __pycache__ for a run without the hook to load."""

    def __init__(self, fullname: str, path: str, runtime: Runtime, component: str, file: str):
        super().__init__(fullname, path)
        self._runtime = runtime
        self._component = component
        self._file = file

    def get_code(self, fullname):
        source = self.get_data(self.path)
        tree = ast.parse(source, self.path)
        return compile(instrument(tree), self.path, "exec", dont_inherit=True)

    def exec_module(self, module):
        module.__dict__[RUNTIME_NAME] = self._runtime.module(self._component, self._file)
        super().exec_module(module)


_runtime: Optional[Runtime] = None


def install(settings: dict) -> Runtime:
    """Starts the runtime and the import hook, once per process."""
    global _runtime
    if _runtime is None:
        _runtime = Runtime(settings)
        sys.meta_path.insert(0, _Finder(_runtime))
        from . import http_client, sqs

        sqs.install(_runtime)
        http_client.install(_runtime)
        # Drop finders cached for path entries, so nothing found before the hook skips it.
        importlib.invalidate_caches()
    return _runtime


_TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$")


def _parse_traceparent(value: str) -> Optional[tuple]:
    match = _TRACEPARENT.match(value.strip())
    return None if match is None else (match.group(1), match.group(2))


def _baggage(value: str) -> dict:
    """A `baggage` value's members: comma-separated key=value, each value percent-encoded and maybe followed by
    ;properties."""
    members = {}
    for member in value.split(","):
        key, equals, rest = member.strip().partition("=")
        if equals:
            members.setdefault(key.strip(), urllib.parse.unquote(rest.split(";", 1)[0].strip()))
    return members


def _attribute(key: str, value):
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    return {"key": key, "value": {"stringValue": value}}


def _error_message(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"
