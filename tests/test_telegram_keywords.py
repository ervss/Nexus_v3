import pytest
from app.telegram_service import scrape_channel_via_telethon

def test_keyword_parsing():
    raw_query = "cherry, bimbo,  blonde "
    keywords = [k.strip() for k in raw_query.split(",") if k.strip()]
    assert keywords == ["cherry", "bimbo", "blonde"]

def test_keyword_empty():
    raw_query = ""
    keywords = [k.strip() for k in raw_query.split(",") if k.strip()]
    search_terms = keywords if keywords else [None]
    assert search_terms == [None]

def test_single_keyword():
    raw_query = "cherry"
    keywords = [k.strip() for k in raw_query.split(",") if k.strip()]
    search_terms = keywords if keywords else [None]
    assert search_terms == ["cherry"]
