"""Which functions the trace hook wraps, and the rewrite that wraps them.

`traced_functions` and `instrument` share `_definitions`, so the surplus check lists exactly what the hook can see
called. Runs on Python 3.9 and later.
"""

from __future__ import annotations

import ast
import re
from typing import Iterator

# The name instrumented modules find the runtime under. The loader sets it in the module's globals before the
# module runs, so no import is added and `from __future__` imports stay first.
RUNTIME_NAME = "__bearing_trace__"

# Decorators whose functions are never called themselves: typing stubs and abstract methods.
_STUB_DECORATORS = {"overload", "abstractmethod"}

# Tests exercise components rather than belong to them; mirrors the Python part of `testFile` in src/paths.ts.
_TEST_FILE = re.compile(r"(^|/)(test|tests|__tests__)/|(^|/)test_[^/]*\.py$|_test\.py$|(^|/)conftest\.py$")


def is_test_file(path: str) -> bool:
    """Whether a repo-relative path, with forward slashes, is a test file."""
    return _TEST_FILE.search(path) is not None


def _public(name: str) -> bool:
    return not name.startswith("_")


def _decorator_name(node: ast.expr) -> str:
    if isinstance(node, ast.Call):
        node = node.func
    if isinstance(node, ast.Subscript):
        node = node.value
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return ""


def _stub(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    return any(_decorator_name(decorator) in _STUB_DECORATORS for decorator in node.decorator_list)


def _protocol(node: ast.ClassDef) -> bool:
    return any(_decorator_name(base) == "Protocol" for base in node.bases)


def _definitions(tree: ast.Module) -> Iterator[tuple[ast.FunctionDef | ast.AsyncFunctionDef, str]]:
    """Public module-level functions, and public methods of public module-level classes as "Class.method".

    Names starting with an underscore are private by convention, as unexported names are in TypeScript and Go, so
    they aren't traced. Neither are typing stubs, abstract methods, or the methods of a Protocol.
    """
    for statement in tree.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if _public(statement.name) and not _stub(statement):
                yield statement, statement.name
        elif isinstance(statement, ast.ClassDef) and _public(statement.name) and not _protocol(statement):
            for member in statement.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if _public(member.name) and not _stub(member):
                        yield member, f"{statement.name}.{member.name}"


def traced_functions(code: str, filename: str = "<unknown>") -> list[str]:
    """The names the hook records spans under for a file's code, sorted and each once. Nothing if it won't parse."""
    try:
        tree = ast.parse(code, filename)
    except (SyntaxError, ValueError):
        return []
    return sorted({name for _, name in _definitions(tree)})


def instrument(tree: ast.Module) -> ast.Module:
    """Adds `@__bearing_trace__.wrap("<name>")` as the innermost decorator of every traced function.

    Innermost, so the wrapper is what other decorators receive: a FastAPI route registers the wrapper, and
    `staticmethod` or `property` wrap it in turn. Every added node takes the function's own position, so tracebacks
    and coverage point at the original lines.
    """
    for node, name in _definitions(tree):
        decorator = ast.Call(
            func=ast.Attribute(value=ast.Name(id=RUNTIME_NAME, ctx=ast.Load()), attr="wrap", ctx=ast.Load()),
            args=[ast.Constant(value=name)],
            keywords=[],
        )
        for added in ast.walk(decorator):
            ast.copy_location(added, node)
            added.end_lineno = node.lineno  # type: ignore[attr-defined]
            added.end_col_offset = node.col_offset  # type: ignore[attr-defined]
        node.decorator_list.append(decorator)
    return tree
