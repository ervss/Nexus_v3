import logging

from app.logging_setup import _AccessLogNoiseFilter
from app.search_engine import _exception_summary


def _access_record(path: str, status: int) -> logging.LogRecord:
    return logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %s',
        ("127.0.0.1:1", "GET", path, "1.1", status),
        None,
    )


def test_successful_import_monitor_polls_are_quiet_but_errors_are_visible():
    noise_filter = _AccessLogNoiseFilter()

    assert not noise_filter.filter(_access_record("/api/v1/dashboard/import-monitor?limit=16", 200))
    assert not noise_filter.filter(_access_record("/api/v1/intake/jobs/625", 200))
    assert noise_filter.filter(_access_record("/api/v1/intake/jobs/625", 500))
    assert noise_filter.filter(_access_record("/api/v1/videos", 200))


def test_empty_exception_message_still_names_the_failure():
    assert _exception_summary(TimeoutError()) == "TimeoutError"
    assert _exception_summary(ValueError("bad response")) == "ValueError: bad response"
