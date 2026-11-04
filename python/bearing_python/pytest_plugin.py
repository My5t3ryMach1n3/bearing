"""The pytest plugin `bearing test` loads through PYTEST_PLUGINS.

It starts the trace runtime before pytest imports any test or conftest, so every component module the tests import
is instrumented, and records each test's outcome with the criterion tag from its `req` marker:

    @pytest.mark.req("#5/AC1")
    def test_books_an_open_slot(client): ...

The marker can also sit on a class or a module's `pytestmark`; the closest one wins.
"""

from __future__ import annotations

import json
import os
from typing import Optional

import pytest

from .runtime import install

MARKER = "req"

_settings = os.environ.get("BEARING_TRACE")
_runtime = install(json.loads(_settings)) if _settings else None


def pytest_configure(config):
    config.addinivalue_line("markers", f'{MARKER}(tag): the acceptance criterion this test proves, e.g. "#3/AC1"')


def _criterion(item) -> Optional[str]:
    if _runtime is None:
        return None
    marker = item.get_closest_marker(MARKER)
    if marker is None:
        return None
    for argument in marker.args:
        if isinstance(argument, str):
            tag = _runtime.criterion(argument)
            if tag is not None:
                return tag
    return None


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    if _runtime is None:
        yield
        return
    criterion = _criterion(item)
    _runtime.test_started(item.nodeid, criterion)
    item.stash[_reports] = []
    try:
        yield
    finally:
        reports = item.stash.get(_reports, [])
        _runtime.test_finished(item.nodeid, _file(item), _status(reports), criterion)


_reports = pytest.StashKey[list]()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    if _runtime is not None and _reports in item.stash:
        item.stash[_reports].append(outcome.get_result())


def _status(reports) -> str:
    """Passed only if setup, the test and teardown all ran with no failure. An expected failure that failed counts
    as skipped, as pytest reports it."""
    if any(report.failed for report in reports):
        return "failed"
    call = [report for report in reports if report.when == "call"]
    if not call or any(report.skipped for report in reports):
        return "skipped"
    return "passed"


def _file(item) -> Optional[str]:
    if _runtime is None:
        return None
    path = os.path.relpath(os.path.realpath(str(item.path)), _runtime.root).replace(os.sep, "/")
    return None if path.startswith("../") else path
