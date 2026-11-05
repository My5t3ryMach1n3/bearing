"""Records the HTTP requests code sends with requests or httpx, so the trace path check can follow a call into another
service by the Kubernetes Service name it's sent to.

The trace hook patches `requests.sessions.Session.send` once `requests.sessions` loads, and `Client.send` and
`AsyncClient.send` once `httpx` loads. Each request gets a client span under the call that sent it, named for its
method and host, when a traced call sends it; the test's own requests come from no component. The request goes out as the code made it: no header is added. The client span isn't made current,
so code an in-process transport runs, such as an ASGI app behind httpx's `ASGITransport`, nests under the caller.
"""

from __future__ import annotations

import sys
from typing import Any

from .runtime import Runtime
from .sqs import PatchOnImport


def _traced(runtime: Runtime, original):
    if getattr(original, "__bearing_traced__", False):
        return original

    def send(self, request, *args, **kwargs):
        span = runtime.request(str(getattr(request, "method", "")), str(getattr(request, "url", "")))
        if span is None:
            return original(self, request, *args, **kwargs)
        try:
            response = original(self, request, *args, **kwargs)
        except BaseException as error:
            runtime._end(span, error)
            raise
        runtime._end(span)
        return response

    send.__bearing_traced__ = True  # type: ignore[attr-defined]
    return send


def _traced_async(runtime: Runtime, original):
    if getattr(original, "__bearing_traced__", False):
        return original

    async def send(self, request, *args, **kwargs):
        span = runtime.request(str(getattr(request, "method", "")), str(getattr(request, "url", "")))
        if span is None:
            return await original(self, request, *args, **kwargs)
        try:
            response = await original(self, request, *args, **kwargs)
        except BaseException as error:
            runtime._end(span, error)
            raise
        runtime._end(span)
        return response

    send.__bearing_traced__ = True  # type: ignore[attr-defined]
    return send


def patch_requests(runtime: Runtime, sessions: Any) -> None:
    session = getattr(sessions, "Session", None)
    if session is not None and callable(getattr(session, "send", None)):
        session.send = _traced(runtime, session.send)


def patch_httpx(runtime: Runtime, httpx: Any) -> None:
    client = getattr(httpx, "Client", None)
    if client is not None and callable(getattr(client, "send", None)):
        client.send = _traced(runtime, client.send)
    async_client = getattr(httpx, "AsyncClient", None)
    if async_client is not None and callable(getattr(async_client, "send", None)):
        async_client.send = _traced_async(runtime, async_client.send)


def install(runtime: Runtime) -> None:
    """Patches requests and httpx now if they're loaded, and otherwise as soon as they are."""
    for name, patch in (("requests.sessions", patch_requests), ("httpx", patch_httpx)):
        module = sys.modules.get(name)
        if module is not None:
            patch(runtime, module)
        else:
            sys.meta_path.insert(0, PatchOnImport(name, lambda loaded, patch=patch: patch(runtime, loaded)))
