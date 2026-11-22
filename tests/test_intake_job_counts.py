import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, ImportJob, ImportJobItem
from app.intake import _refresh_job_counts, reconcile_job_counts


def test_refresh_job_counts_aggregates_statuses_in_sql():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[ImportJob.__table__, ImportJobItem.__table__])
    session = sessionmaker(bind=engine, autoflush=False)()
    try:
        job = ImportJob(batch_name="count-test", status="queued")
        session.add(job)
        session.flush()
        session.add_all([
            ImportJobItem(job_id=job.id, status="pending"),
            ImportJobItem(job_id=job.id, status="pending_retry"),
            ImportJobItem(job_id=job.id, status="imported"),
            ImportJobItem(job_id=job.id, status="duplicate"),
        ])
        session.flush()

        before = datetime.datetime.now(datetime.UTC)
        _refresh_job_counts(session, job)

        assert job.total_items == 4
        assert job.pending_items == 2
        assert job.imported_items == 1
        assert job.duplicate_items == 1
        assert job.running_items == job.failed_items == job.cancelled_items == 0
        assert job.status == "queued"
        assert job.updated_at >= before
    finally:
        session.close()

def test_transitions_count_unflushed_changes_and_close_last_item():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine, tables=[ImportJob.__table__, ImportJobItem.__table__])
    with sessionmaker(bind=engine, autoflush=False)() as session:
        job = ImportJob(batch_name='transitions')
        session.add(job); session.flush()
        items = [ImportJobItem(job_id=job.id, status='pending') for _ in range(2)]
        session.add_all(items); session.commit()
        for item in items:
            item.status = 'running'
        _refresh_job_counts(session, job)
        assert job.running_items == 2 and job.pending_items == 0
        session.commit()
        items[0].status = 'imported'
        _refresh_job_counts(session, job)
        assert job.imported_items == 1 and job.running_items == 1
        session.commit()
        items[1].status = 'imported'
        _refresh_job_counts(session, job)
        session.commit(); session.refresh(job)
        assert (job.status, job.imported_items, job.running_items, job.pending_items) == ('completed', 2, 0, 0)
        assert job.finished_at is not None


def test_reconciliation_heals_stale_summaries_without_faking_activity():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine, tables=[ImportJob.__table__, ImportJobItem.__table__])
    with sessionmaker(bind=engine, autoflush=False)() as session:
        old = datetime.datetime(2026, 10, 7, 5, 40)
        jobs = [ImportJob(batch_name='stale', status='queued', total_items=2,
                          running_items=2, imported_items=1, updated_at=old),
                ImportJob(batch_name='retry', status='completed', finished_at=old, updated_at=old),
                ImportJob(batch_name='errors', status='running', updated_at=old),
                ImportJob(batch_name='cancel', status='running', updated_at=old)]
        session.add_all(jobs); session.flush()
        session.add_all([ImportJobItem(job_id=jobs[0].id, status='imported', updated_at=old) for _ in range(2)] +
                        [ImportJobItem(job_id=jobs[1].id, status='pending_retry', updated_at=old),
                         ImportJobItem(job_id=jobs[2].id, status='failed', updated_at=old),
                         ImportJobItem(job_id=jobs[3].id, status='cancelled', updated_at=old)])
        session.commit()
        reconcile_job_counts(session, jobs, persist=True)
        assert jobs[0].status == 'completed' and jobs[0].imported_items == 2 and jobs[0].running_items == 0
        assert jobs[0].finished_at == old
        assert jobs[1].status == 'queued' and jobs[1].pending_items == 1 and jobs[1].finished_at is None
        assert jobs[2].status == 'failed'
        assert jobs[3].status == 'cancelled' and jobs[3].finished_at == old
        assert all(j.updated_at == old for j in jobs)
        session.commit()
        reconcile_job_counts(session, jobs)
        assert all(j.updated_at == old for j in jobs)
        assert all(not session.is_modified(j) for j in jobs)
