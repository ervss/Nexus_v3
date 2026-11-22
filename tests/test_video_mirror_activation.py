import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException

from app.database import Video, VideoSource
from app.media_match import MediaFacts, looks_like_same_video


def _load_activation_route():
    source = Path("app/main.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    route = next(
        node for node in tree.body
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "activate_video_mirror_record"
    )
    route.decorator_list = []
    route.returns = None
    route.args.defaults = []
    for argument in [*route.args.args, *route.args.kwonlyargs]:
        argument.annotation = None
    for node in ast.walk(route):
        if isinstance(node, ast.FunctionDef) and node.name == "facts":
            node.returns = None
            for argument in node.args.args:
                argument.annotation = None

    module = ast.Module(body=[route], type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = {
        "__package__": "app",
        "Video": Video,
        "VideoSource": VideoSource,
        "MediaFacts": MediaFacts,
        "looks_like_same_video": looks_like_same_video,
        "HTTPException": HTTPException,
    }
    exec(compile(module, "app/main.py", "exec"), namespace)
    return namespace["activate_video_mirror_record"]


class _Query:
    def __init__(self, db, model):
        self.db = db
        self.model = model

    def get(self, row_id):
        return self.db.videos.get(row_id)

    def filter(self, _expression):
        return self

    def all(self):
        return list(self.db.sources)


class _Db:
    def __init__(self, videos):
        self.videos = {video.id: video for video in videos}
        self.sources = []
        self.next_source_id = 1

    def query(self, model):
        return _Query(self, model)

    def add(self, source):
        self.sources.append(source)

    def flush(self):
        for source in self.sources:
            if source.id is None:
                source.id = self.next_source_id
                self.next_source_id += 1

    def commit(self):
        pass


def _video(row_id, title, url, source_url, size_mb=1000, duration=600):
    return SimpleNamespace(
        id=row_id,
        title=title,
        url=url,
        source_url=source_url,
        original_thumbnail_url="",
        thumbnail_path="",
        file_size_mb=size_mb,
        duration=duration,
        height=1080,
        quality="1080p",
        link_status="working",
    )


def test_activating_an_existing_duplicate_persists_it_as_a_mirror():
    primary = _video(1, "A Long Video Name.mp4", "https://filester.example/a.mp4", "https://filester.example/a")
    mirror = _video(2, "A Long Video Name.mp4", "https://pixeldrain.example/a.mp4", "https://pixeldrain.example/a")
    db = _Db([primary, mirror])

    result = asyncio.run(_load_activation_route()(1, 2, db, True))

    assert result["success"] is True
    assert primary.url == mirror.url
    assert len(db.sources) == 2
    assert sum(source.is_primary for source in db.sources) == 1
    assert next(source for source in db.sources if source.is_primary).url == mirror.url


def test_activation_rejects_a_video_that_does_not_match_the_card():
    primary = _video(1, "A Long Video Name.mp4", "https://filester.example/a.mp4", "https://filester.example/a")
    unrelated = _video(2, "A Different Video Name.mp4", "https://pixeldrain.example/b.mp4", "https://pixeldrain.example/b")
    db = _Db([primary, unrelated])

    try:
        asyncio.run(_load_activation_route()(1, 2, db, True))
    except HTTPException as exc:
        assert exc.status_code == 409
    else:
        raise AssertionError("unrelated video was accepted as a mirror")

    assert db.sources == []
