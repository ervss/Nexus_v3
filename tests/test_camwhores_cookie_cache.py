"""The Camwhores cookie bundle is parsed once per file revision, not per call.

`_base_headers()` runs for every probe, fallback rung and page fetch, and
callers build a fresh CamwhoresExtractor() per video, so the cache has to live
at module scope to be worth anything. These tests pin that contract.
"""
import os

import pytest

from app.extractors.camwhores import CamwhoresExtractor, _reset_cookie_bundle_cache


def _netscape_line(value: str, name: str = "kt_session") -> str:
    return f".camwhores.tv\tTRUE\t/\tTRUE\t2147483647\t{name}\t{value}\n"


@pytest.fixture()
def cookie_file(tmp_path, monkeypatch):
    path = tmp_path / "camwhores.cookies.txt"
    path.write_text(_netscape_line("abc123"), encoding="utf-8")
    monkeypatch.setenv("CAMWHORES_COOKIE_FILE", str(path))
    monkeypatch.delenv("CAMWHORES_COOKIE", raising=False)
    _reset_cookie_bundle_cache()
    try:
        yield path
    finally:
        _reset_cookie_bundle_cache()


def test_cookie_file_is_read_once_across_repeated_header_builds(cookie_file, monkeypatch):
    reads = []
    original = CamwhoresExtractor._parse_netscape_cookie_file

    def counting(path):
        reads.append(path)
        return original(path)

    monkeypatch.setattr(CamwhoresExtractor, "_parse_netscape_cookie_file", staticmethod(counting))

    extractor = CamwhoresExtractor()
    for _ in range(5):
        assert extractor._base_headers()["Cookie"] == "kt_session=abc123"

    assert len(reads) == 1


def test_edited_cookie_file_is_picked_up(cookie_file):
    extractor = CamwhoresExtractor()
    assert extractor._base_headers()["Cookie"] == "kt_session=abc123"

    cookie_file.write_text(_netscape_line("def45678"), encoding="utf-8")
    os.utime(cookie_file, (1_700_000_000, 1_700_000_000))

    assert extractor._base_headers()["Cookie"] == "kt_session=def45678"


def test_env_cookie_wins_and_returned_dicts_are_independent(cookie_file, monkeypatch):
    monkeypatch.setenv("CAMWHORES_COOKIE", "kt_session=envvalue")
    _reset_cookie_bundle_cache()

    extractor = CamwhoresExtractor()
    header, cookies = extractor._cookie_bundle()
    assert header == "kt_session=envvalue"
    assert [cookie["name"] for cookie in cookies] == ["kt_session"]

    # Playwright mutates the dicts it is handed; that must not poison the cache.
    cookies[0]["value"] = "mutated"
    _, again = extractor._cookie_bundle()
    assert again[0]["value"] == "envvalue"
