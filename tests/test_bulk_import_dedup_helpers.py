"""Contract test for the bulk-import URL deduplication helpers.

It compiles the two helpers directly from the route source, so it needs neither
the Nexus application nor a database connection.
"""
import ast
import pathlib
import re
import types
import unittest
import urllib.parse


SOURCE_PATH = pathlib.Path("app/routers/bulk_import.py")


class _Expression:
    def __or__(self, other):
        return self


class _Column:
    def in_(self, _values):
        return _Expression()


class _Video:
    url = _Column()
    source_url = _Column()


class _Query:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, _expression):
        return self

    def all(self):
        return self.rows


class _Db:
    def __init__(self, rows):
        self.rows = rows

    def query(self, _model):
        return _Query(self.rows)


def load_helpers(rows):
    tree = ast.parse(SOURCE_PATH.read_text(encoding="utf-8"), filename=str(SOURCE_PATH))
    route = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "import_bulk")
    wanted = [node for node in route.body if isinstance(node, ast.FunctionDef) and node.name in {"_normalize_video_url", "_find_existing_video"}]
    assert len(wanted) == 2
    for node in wanted:
        node.returns = None
        for argument in [*node.args.args, *node.args.kwonlyargs]:
            argument.annotation = None
    module = ast.Module(body=wanted, type_ignores=[])
    ast.fix_missing_locations(module)
    scope = {
        "Optional": object,
        "Video": _Video,
        "db": _Db(rows),
        "re": re,
        "urllib": urllib,
    }
    exec(compile(module, str(SOURCE_PATH), "exec"), scope)
    return scope["_find_existing_video"]


class BulkImportDedupHelperTests(unittest.TestCase):
    def test_shared_profile_source_does_not_merge_distinct_videos(self):
        existing = types.SimpleNamespace(
            url="https://cdn.example/first.mp4",
            source_url="https://site.example/profiles/alice",
        )
        find_existing = load_helpers([existing])
        self.assertIsNone(find_existing(
            "https://cdn.example/second.mp4",
            "https://site.example/profiles/alice",
            "auto",
        ))

    def test_collection_scope_never_uses_a_shared_discovery_url(self):
        existing = types.SimpleNamespace(
            url="https://cdn.example/first.mp4",
            source_url="https://site.example/watch-page",
        )
        find_existing = load_helpers([existing])
        self.assertIsNone(find_existing(
            "https://cdn.example/second.mp4",
            "https://site.example/watch-page",
            "collection",
        ))

    def test_normal_watch_source_still_detects_an_exact_repeat(self):
        existing = types.SimpleNamespace(
            url="https://cdn.example/first.mp4",
            source_url="https://site.example/watch-page",
        )
        find_existing = load_helpers([existing])
        self.assertIs(find_existing(
            "https://cdn.example/second.mp4",
            "https://site.example/watch-page/",
            "auto",
        ), existing)


if __name__ == "__main__":
    unittest.main()
