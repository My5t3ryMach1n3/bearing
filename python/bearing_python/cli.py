"""The commands src/lang/python.ts runs, each reading JSON or code on stdin and printing JSON.

    python -I cli.py imports    {"root": ..., "project": ...} -> {"files": [...], "imports": [...]}
    python -I cli.py functions  <code>                         -> ["name", "Class.method", ...]

Run with -I, so nothing in the repo or on PYTHONPATH shadows the standard library.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bearing_python.imports import ProjectError, extract  # noqa: E402
from bearing_python.instrument import traced_functions  # noqa: E402


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else ""
    if command == "imports":
        request = json.load(sys.stdin)
        if not os.path.isfile(request["project"]):
            sys.stderr.write("not found\n")
            return 2
        try:
            result = extract(request["root"], request["project"])
        except ProjectError as error:
            sys.stderr.write(f"{error}\n")
            return 1
    elif command == "functions":
        result = traced_functions(sys.stdin.read())
    else:
        sys.stderr.write("usage: cli.py imports|functions\n")
        return 2
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
