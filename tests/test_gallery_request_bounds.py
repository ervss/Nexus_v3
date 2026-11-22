import ast
from pathlib import Path


def _load_bounded_limit():
    source = Path("app/main.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    function = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_bounded_limit"
    )
    module = ast.Module(body=[function], type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = {}
    exec(compile(module, "app/main.py", "exec"), namespace)
    return namespace["_bounded_limit"]


def test_gallery_limit_never_becomes_unbounded():
    bounded = _load_bounded_limit()
    assert bounded(-1, maximum=1000, default=10) == 1
    assert bounded(0, maximum=1000, default=10) == 1
    assert bounded(50_000, maximum=1000, default=10) == 1000
    assert bounded("bad", maximum=1000, default=10) == 10
