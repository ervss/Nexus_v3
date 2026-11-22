from sqlalchemy import create_engine, inspect

from app.database import Base, ImportJobEvent, ImportJobItem


def test_import_hot_path_composite_indexes_are_created():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(
        engine,
        tables=[ImportJobItem.__table__, ImportJobEvent.__table__],
    )

    item_indexes = {
        index["name"]: tuple(index["column_names"])
        for index in inspect(engine).get_indexes("import_job_items")
    }
    event_indexes = {
        index["name"]: tuple(index["column_names"])
        for index in inspect(engine).get_indexes("import_job_events")
    }

    assert item_indexes["ix_import_job_items_status_id"] == ("status", "id")
    assert item_indexes["ix_import_job_items_job_status"] == ("job_id", "status")
    assert event_indexes["ix_import_job_events_job_id_id"] == ("job_id", "id")
