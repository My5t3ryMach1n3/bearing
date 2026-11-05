"""Carries trace context through SQS messages sent and received with botocore, and so boto3.

The trace hook patches `BaseClient._make_api_call` once `botocore.client` loads. SendMessage and SendMessageBatch get a
producer span and the `traceparent` and `baggage` attributes that carry it; ReceiveMessage asks for those attributes
too, takes them back out if the caller didn't ask for them, and continues the first message's trace. See
`Runtime.consume`. Other calls, and other services, pass through as they are.
"""

from __future__ import annotations

import importlib.abc
import sys
from typing import Any, Callable

from .runtime import BAGGAGE, MAX_ATTRIBUTES, TRACEPARENT, Runtime

_OPERATIONS = ("SendMessage", "SendMessageBatch", "ReceiveMessage")


def patch(runtime: Runtime, client_module: Any) -> None:
    base = client_module.BaseClient
    original = base._make_api_call
    if getattr(original, "__bearing_traced__", False):
        return

    def _make_api_call(self, operation_name, api_params):
        try:
            service = self.meta.service_model.service_name
        except AttributeError:
            service = None
        if service != "sqs" or operation_name not in _OPERATIONS or not isinstance(api_params, dict):
            return original(self, operation_name, api_params)
        queue = _queue_name(api_params.get("QueueUrl"))
        if operation_name == "ReceiveMessage":
            return _receive(runtime, original, self, api_params, queue)
        span = runtime.produce(queue)
        carried = runtime.context_attributes(span)
        params = dict(api_params)
        if operation_name == "SendMessage":
            params["MessageAttributes"] = _with_context(params.get("MessageAttributes"), carried)
        else:
            params["Entries"] = [
                {**entry, "MessageAttributes": _with_context(entry.get("MessageAttributes"), carried)}
                if isinstance(entry, dict)
                else entry
                for entry in params.get("Entries") or []
            ]
        try:
            result = original(self, operation_name, params)
        except BaseException as error:
            runtime._end(span, error)
            raise
        runtime._end(span)
        return result

    _make_api_call.__bearing_traced__ = True  # type: ignore[attr-defined]
    base._make_api_call = _make_api_call


def _receive(runtime: Runtime, original, client, api_params: dict, queue: str):
    params = dict(api_params)
    asked = list(params.get("MessageAttributeNames") or [])
    added = [name for name in (TRACEPARENT, BAGGAGE) if not _asked_for(asked, name)]
    params["MessageAttributeNames"] = asked + added
    result = original(client, "ReceiveMessage", params)
    received = []
    for message in result.get("Messages") or [] if isinstance(result, dict) else []:
        attributes = message.get("MessageAttributes") or {}
        received.append(
            {
                name: attributes[name].get("StringValue")
                for name in (TRACEPARENT, BAGGAGE)
                if isinstance(attributes.get(name), dict) and isinstance(attributes[name].get("StringValue"), str)
            }
        )
        for name in added:
            attributes.pop(name, None)
        if added and "MessageAttributes" in message and not attributes:
            # As SQS answers when no attribute was asked for.
            del message["MessageAttributes"]
            message.pop("MD5OfMessageAttributes", None)
    runtime.consume(queue, received)
    return result


def _with_context(attributes: Any, carried: dict) -> Any:
    """A copy of a message's attributes with the trace context's added, as far as SQS's limit allows. An attribute the
    caller set is left as it is."""
    if attributes is not None and not isinstance(attributes, dict):
        return attributes
    copied = dict(attributes or {})
    for name in (TRACEPARENT, BAGGAGE):
        if name in carried and name not in copied and len(copied) < MAX_ATTRIBUTES:
            copied[name] = {"DataType": "String", "StringValue": carried[name]}
    return copied


def _asked_for(names: list, name: str) -> bool:
    for asked in names:
        if asked in (name, "All", ".*") or (asked.endswith(".*") and name.startswith(asked[:-1])):
            return True
    return False


def _queue_name(url: Any) -> str:
    """The last part of a queue URL, e.g. "appointment-events"."""
    return url.rstrip("/").rsplit("/", 1)[-1] if isinstance(url, str) else ""


class PatchOnImport(importlib.abc.MetaPathFinder):
    """Runs `patch(module)` once the module named `name` has loaded, whichever finder finds it."""

    def __init__(self, name: str, patch: Callable[[Any], None]):
        self._name = name
        self._patch = patch

    def find_spec(self, fullname, path, target=None):
        if fullname != self._name:
            return None
        for finder in sys.meta_path:
            find = getattr(finder, "find_spec", None)
            if finder is self or find is None:
                continue
            spec = find(fullname, path, target)
            if spec is not None:
                break
        else:
            return None
        loader = spec.loader
        exec_module = getattr(loader, "exec_module", None)
        if exec_module is None:
            return spec
        patch = self._patch

        def exec_and_patch(module):
            exec_module(module)
            patch(module)

        loader.exec_module = exec_and_patch
        return spec


def install(runtime: Runtime) -> None:
    """Patches botocore now if it's loaded, and otherwise as soon as it is."""
    module = sys.modules.get("botocore.client")
    if module is not None:
        patch(runtime, module)
    else:
        sys.meta_path.insert(0, PatchOnImport("botocore.client", lambda loaded: patch(runtime, loaded)))
