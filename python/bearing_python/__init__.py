"""Bearing's Python adapter: import extraction, the trace hook and its pytest plugin.

`src/lang/python.ts` runs `cli.py` for imports and traced functions. `bearing test` puts this folder's parent on
PYTHONPATH and loads `bearing_python.pytest_plugin` into pytest through PYTEST_PLUGINS. Nothing here depends on
anything outside the standard library, and the trace hook runs on Python 3.9 and later.
"""
