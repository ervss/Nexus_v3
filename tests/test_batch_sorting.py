import ast
import datetime
from pathlib import Path

from sqlalchemy import Column, DateTime, Float, Integer, String, create_engine
from sqlalchemy.orm import Session, declarative_base


def test_sidebar_batch_sorting():
    """Exercise the lightweight endpoint against real grouped SQLite rows."""
    base = declarative_base()

    class Video(base):
        __tablename__ = "videos"
        id = Column(Integer, primary_key=True)
        batch_name = Column(String)
        created_at = Column(DateTime)
        file_size_mb = Column(Float)

    tree = ast.parse(Path("app/main.py").read_text(encoding="utf-8"))
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "get_batches")
    function.decorator_list = []
    function.args.defaults = [ast.Constant(None), ast.Constant("name"), ast.Constant(False)]
    for arg in function.args.args:
        arg.annotation = None
    namespace = {"Video": Video}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), "app/main.py", "exec"), namespace)
    engine = create_engine("sqlite://")
    base.metadata.create_all(engine)
    with Session(engine) as db:
        old = datetime.datetime(2026, 9, 1)
        recent = datetime.datetime(2026, 10, 6)
        db.add_all([
            Video(batch_name="Alpha", created_at=old, file_size_mb=900),
            Video(batch_name="zLatest", created_at=old, file_size_mb=1),
            Video(batch_name="zLatest", created_at=recent, file_size_mb=1),
            Video(batch_name="Many", created_at=old, file_size_mb=1),
            Video(batch_name="Many", created_at=old, file_size_mb=1),
            Video(batch_name="Many", created_at=old, file_size_mb=1),
            Video(batch_name="Undated", created_at=None, file_size_mb=None),
            Video(batch_name="", created_at=recent),
            Video(batch_name=None, created_at=recent),
        ])
        db.commit()
        batches = namespace["get_batches"]
        assert batches(db, "name") == ["Alpha", "Many", "Undated", "zLatest"]
        assert batches(db, "newest") == ["zLatest", "Alpha", "Many", "Undated"]
        assert batches(db, "biggest") == ["Many", "zLatest", "Alpha", "Undated"]
        assert batches(db, "size") == ["Alpha", "Many", "zLatest", "Undated"]
        assert batches(db, "unknown") == batches(db, "name")
