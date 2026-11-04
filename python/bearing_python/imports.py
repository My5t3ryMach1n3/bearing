"""Reads a Python project's imports without running it.

Finds every source file under the language's root and resolves each import to the files declaring what it uses:
`import a.b` uses module `a.b`, and `from a.b import c` uses module `a.b.c` if there is one, otherwise the file that
declares `c`, following re-exports such as a package `__init__.py` that imports `c` from a submodule. Absolute
imports resolve against the project's source roots, as `pyproject.toml` declares them; relative ones against the
importing file's own package. Anything that resolves to no file, such as a package or the standard library, is left
out.
"""

from __future__ import annotations

import ast
import os
from typing import Iterable, Optional

# Folders that never hold the project's own code.
_SKIP_DIRS = {"__pycache__", "node_modules", "site-packages"}


class ProjectError(Exception):
    pass


def source_roots(project_dir: str, pyproject: Optional[dict]) -> list[str]:
    """The folders absolute imports resolve against, absolute, deepest first.

    Read from the build backend's settings in pyproject.toml (setuptools, Hatch, Poetry, PDM, uv) and pytest's
    `pythonpath`. With none of those, the project's folder, and `src/` if it has one.
    """
    tool = (pyproject or {}).get("tool", {})
    roots: list[str] = []

    def add(folder) -> None:
        if isinstance(folder, str):
            roots.append(os.path.normpath(os.path.join(project_dir, folder)))

    setuptools = tool.get("setuptools", {})
    find = setuptools.get("packages", {})
    if isinstance(find, dict):
        for folder in find.get("find", {}).get("where", []):
            add(folder)
    package_dir = setuptools.get("package-dir", {})
    if isinstance(package_dir, dict):
        for name, folder in package_dir.items():
            # {"": "src"} roots every package in src/; {"app": "lib/app"} puts one package's folder elsewhere.
            add(folder if name == "" else os.path.dirname(folder.rstrip("/")) or ".")
    hatch = tool.get("hatch", {}).get("build", {}).get("targets", {}).get("wheel", {})
    for package in hatch.get("packages", []):
        add(os.path.dirname(package.rstrip("/")) or ".")
    for package in tool.get("poetry", {}).get("packages", []):
        if isinstance(package, dict):
            add(package.get("from", "."))
    add(tool.get("pdm", {}).get("build", {}).get("package-dir"))
    add(tool.get("uv", {}).get("build-backend", {}).get("module-root"))
    pythonpath = tool.get("pytest", {}).get("ini_options", {}).get("pythonpath", [])
    for folder in [pythonpath] if isinstance(pythonpath, str) else pythonpath:
        add(folder)

    if not roots:
        roots.append(os.path.normpath(project_dir))
        if os.path.isdir(os.path.join(project_dir, "src")):
            roots.append(os.path.normpath(os.path.join(project_dir, "src")))
    unique = list(dict.fromkeys(roots))
    return sorted(unique, key=lambda root: -len(root))


def source_files(root: str) -> list[str]:
    """Every .py file under a folder, absolute and sorted, leaving out virtual environments and hidden folders."""
    files: list[str] = []
    for folder, dirs, names in os.walk(root):
        dirs[:] = sorted(
            name
            for name in dirs
            if not name.startswith(".")
            and name not in _SKIP_DIRS
            and not os.path.exists(os.path.join(folder, name, "pyvenv.cfg"))
        )
        files.extend(os.path.join(folder, name) for name in sorted(names) if name.endswith(".py"))
    return files


class _Module:
    """What one file binds at module level, for following re-exports."""

    def __init__(self, path: str, tree: Optional[ast.Module]):
        self.path = path
        # Names the module defines itself.
        self.defined: set[str] = set()
        # Names it imports from another module: name -> (module as written, level, name there).
        self.imported: dict[str, tuple[str, int, str]] = {}
        self.stars: list[tuple[str, int]] = []
        if tree is None:
            return
        for statement in _top_level(tree.body):
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.defined.add(statement.name)
            elif isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                for target in targets:
                    for node in ast.walk(target):
                        if isinstance(node, ast.Name):
                            self.defined.add(node.id)
            elif isinstance(statement, ast.ImportFrom):
                for alias in statement.names:
                    if alias.name == "*":
                        self.stars.append((statement.module or "", statement.level))
                    else:
                        self.imported[alias.asname or alias.name] = (statement.module or "", statement.level, alias.name)
            elif isinstance(statement, ast.Import):
                for alias in statement.names:
                    if alias.asname is not None:
                        self.imported[alias.asname] = (alias.name, 0, "")


def _top_level(statements: Iterable[ast.stmt]) -> Iterable[ast.stmt]:
    """Module-level statements, including those inside `if`, `try` and `with` blocks."""
    for statement in statements:
        if isinstance(statement, (ast.If, ast.Try, ast.With)) or type(statement).__name__ == "TryStar":
            for field in ("body", "orelse", "finalbody"):
                yield from _top_level(getattr(statement, field, []))
            for handler in getattr(statement, "handlers", []):
                yield from _top_level(handler.body)
        else:
            yield statement


class Project:
    def __init__(self, roots: list[str]):
        self.roots = roots
        self._modules: dict[str, _Module] = {}

    # Finding modules.

    def _module_file(self, folder: str, parts: list[str]) -> Optional[str]:
        """The file for a dotted module below a folder: a module file or a package's `__init__`."""
        path = os.path.join(folder, *parts)
        for candidate in (path + ".py", os.path.join(path, "__init__.py")):
            if os.path.isfile(candidate):
                return candidate
        return None

    def _is_package(self, folder: str, parts: list[str]) -> bool:
        return os.path.isdir(os.path.join(folder, *parts))

    def _base(self, importer: str, level: int) -> Optional[str]:
        """The folder a relative import of `level` dots resolves from, or None for an absolute import."""
        if level == 0:
            return None
        folder = os.path.dirname(importer)
        for _ in range(level - 1):
            folder = os.path.dirname(folder)
        return folder

    def find(self, importer: str, module: str, level: int) -> Optional[str]:
        """The file a module resolves to, or None if it isn't the project's."""
        parts = [part for part in module.split(".") if part]
        base = self._base(importer, level)
        if base is not None:
            if not parts:
                return self._module_file(os.path.dirname(base), [os.path.basename(base)])
            return self._module_file(base, parts)
        for root in self.roots:
            found = self._module_file(root, parts)
            if found is not None:
                return found
        return None

    def _package_folder(self, importer: str, module: str, level: int) -> Optional[str]:
        """The folder of a package (regular or namespace), for `from package import submodule`."""
        parts = [part for part in module.split(".") if part]
        base = self._base(importer, level)
        if base is not None:
            return os.path.join(base, *parts) if self._is_package(base, parts) else None
        for root in self.roots:
            if parts and self._is_package(root, parts):
                return os.path.join(root, *parts)
        return None

    # Following names.

    def _parsed(self, path: str) -> _Module:
        module = self._modules.get(path)
        if module is None:
            module = _Module(path, parse(path))
            self._modules[path] = module
        return module

    def declaring(self, path: str, name: str, seen: Optional[set] = None) -> list[str]:
        """The files declaring `name` as module `path` binds it, after following re-exports."""
        seen = set() if seen is None else seen
        if (path, name) in seen:
            return []
        seen.add((path, name))
        module = self._parsed(path)
        if name in module.imported:
            source, level, original = module.imported[name]
            if original == "":
                found = self.find(path, source, 0)
                return [found] if found is not None else []
            return self.resolve_from(path, source, level, original, seen) or []
        if name in module.defined:
            return [path]
        for source, level in module.stars:
            found = self.find(path, source, level)
            if found is not None:
                declared = self.declaring(found, name, seen)
                if declared:
                    return declared
        return [path]

    def resolve_from(self, importer: str, module: str, level: int, name: str, seen=None) -> Optional[list[str]]:
        """What `from <module> import <name>` uses: the submodule if there is one, else the declaring file."""
        folder = self._package_folder(importer, module, level)
        if folder is not None:
            submodule = self._module_file(folder, [name])
            if submodule is not None:
                return [submodule]
        found = self.find(importer, module, level)
        if found is None:
            return None
        return self.declaring(found, name, seen)

    # One file's imports.

    def imports(self, path: str) -> list[dict]:
        tree = parse(path)
        if tree is None:
            return []
        found: list[dict] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    target = self.find(path, alias.name, 0)
                    if target is not None:
                        found.append({"line": node.lineno, "module": alias.name, "targets": [target]})
            elif isinstance(node, ast.ImportFrom):
                written = "." * node.level + (node.module or "")
                targets: list[str] = []
                for alias in node.names:
                    if alias.name == "*":
                        module = self.find(path, node.module or "", node.level)
                        targets.extend([module] if module is not None else [])
                    else:
                        targets.extend(self.resolve_from(path, node.module or "", node.level, alias.name) or [])
                if targets:
                    found.append({"line": node.lineno, "module": written, "targets": sorted(set(targets))})
            elif isinstance(node, ast.Call) and _dynamic_import(node):
                argument = node.args[0]
                if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                    target = self.find(path, argument.value, 0)
                    if target is not None:
                        found.append({"line": node.lineno, "module": argument.value, "targets": [target]})
        return sorted(found, key=lambda entry: entry["line"])


def _dynamic_import(node: ast.Call) -> bool:
    """`importlib.import_module("a.b")`, `import_module("a.b")` or `__import__("a.b")` with a literal name."""
    if not node.args:
        return False
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr == "import_module" and isinstance(func.value, ast.Name) and func.value.id == "importlib"
    return isinstance(func, ast.Name) and func.id in ("import_module", "__import__")


def parse(path: str) -> Optional[ast.Module]:
    try:
        with open(path, "rb") as source:
            return ast.parse(source.read(), path)
    except (OSError, SyntaxError, ValueError):
        return None


def read_pyproject(path: str) -> Optional[dict]:
    if not path.endswith(".toml"):
        return None
    try:
        import tomllib  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        try:
            import tomli as tomllib  # type: ignore[import-not-found, no-redef]
        except ModuleNotFoundError as error:
            raise ProjectError("reading pyproject.toml needs Python 3.11 or later, or the tomli package") from error
    try:
        with open(path, "rb") as file:
            return tomllib.load(file)
    except (OSError, ValueError) as error:
        raise ProjectError(str(error)) from error


def has_code(path: str) -> bool:
    """Whether a file holds anything but a docstring, such as an `__init__.py` that only marks a package."""
    tree = parse(path)
    if tree is None:
        return True
    body = tree.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        body = body[1:]
    return len(body) > 0


def extract(root: str, project: str) -> dict:
    """Every source file under `root` that holds code, and the imports each makes of the project's own code. Paths
    absolute."""
    pyproject = read_pyproject(project)
    project_dir = os.path.dirname(project)
    files = [file for file in source_files(root) if has_code(file)]
    resolver = Project(source_roots(project_dir, pyproject))
    imports = []
    for file in files:
        for entry in resolver.imports(file):
            imports.append({"file": file, **entry})
    return {"files": files, "imports": imports}
