from types import SimpleNamespace

import pytest
import requests

from app import camwhores_discovery as cw


def session_with(monkeypatch, responses):
    calls = []
    class Session:
        def __init__(self):
            self.headers = {}
        def mount(self, *args):
            pass
        def get(self, url, **kwargs):
            calls.append((url, kwargs))
            return next(responses)
    monkeypatch.setattr(requests, "Session", Session)
    return calls


def response(status, text=""):
    return SimpleNamespace(status_code=status, text=text)


def test_video_403_is_blocked_and_never_empty(monkeypatch):
    calls = session_with(monkeypatch, iter([response(403)]))
    with pytest.raises(cw.CamwhoresSourceError) as exc:
        cw.scrape_camwhores_discovery(keyword="bbc", pages=5, listing_only=True)
    assert exc.value.code == "blocked"
    assert len(calls) == 1
    assert "/search/bbc/" in calls[0][0]
    assert "verify" not in calls[0][1]


def test_video_partial_retains_cards_and_reports_failed_page(monkeypatch):
    html = '<a class="item" href="/videos/42/example/" title="Example"><span class="duration">3:20</span></a>'
    session_with(monkeypatch, iter([response(200, html), response(403)]))
    report = {}
    cards = cw.scrape_camwhores_discovery(keyword="test", pages=3, listing_only=True, report=report)
    assert [c["title"] for c in cards] == ["Example"]
    assert report["status"] == "partial" and report["pages_scanned"] == 1
    assert report["code"] == "blocked"


def test_playlist_403_is_not_success(monkeypatch):
    calls = session_with(monkeypatch, iter([response(403)]))
    with pytest.raises(cw.CamwhoresSourceError) as exc:
        cw.scrape_camwhores_playlists(keyword="bbc", pages=1)
    assert exc.value.code == "blocked"
    assert len(calls) == 1


def test_playlist_title_search_reports_coverage_and_duplicate_page(monkeypatch):
    html = '<a class="item" href="/playlists/12/test/"><strong class="title">Test list</strong></a>'
    calls = session_with(monkeypatch, iter([response(200, html), response(200, html)]))
    report = {}
    result = cw.scrape_camwhores_playlists(keyword="test", pages=5, report=report)
    assert [p["id"] for p in result] == ["12"]
    assert len(calls) == 2
    assert report["status"] == "partial" and report["code"] == "pagination_error"
    assert report["playlists_scanned"] == 1


def test_challenge_is_not_an_empty_result(monkeypatch):
    session_with(monkeypatch, iter([response(200, '<title>Just a moment...</title>')]))
    with pytest.raises(cw.CamwhoresSourceError) as exc:
        cw.scrape_camwhores_playlists(pages=1)
    assert exc.value.code == "blocked"


def test_latest_preserves_source_order_and_counts_private(monkeypatch):
    html = '''<div id="list_videos_latest_videos_list_items">
      <div class="item"><a href="/videos/2/two/" title="Two"></a><span class="added">3 days ago</span></div>
      <div class="item private"><a href="/videos/9/private/" title="Private"></a></div>
      <div class="item"><a href="/videos/5/five/" title="Five"></a><span class="added">3 days ago</span></div>
    </div>'''
    calls = session_with(monkeypatch, iter([response(200, html)]))
    report = {}
    cards = cw.scrape_camwhores_discovery(keyword='', search_mode='latest', listing_only=True, report=report)
    assert [v['video_id'] for v in cards] == ['2', '5']
    assert cards[0]['added'] == '3 days ago' and cards[0]['added_date'] == ''
    assert report['cards_scanned'] == 3 and report['private_count'] == 1
    assert '/latest-updates/' in calls[0][0]


def test_tag_mode_pages_use_tag_endpoint(monkeypatch):
    html = '<a class="item" href="/videos/1/test/" title="Test"></a>'
    html2 = '<a class="item" href="/videos/2/test/" title="Test 2"></a>'
    calls = session_with(monkeypatch, iter([response(200, html), response(200, html2)]))
    cards = cw.scrape_camwhores_discovery(keyword='oil', search_mode='tag', pages=2, listing_only=True)
    assert len(cards) == 2
    assert '/tags/oil/' in calls[0][0] and '?from=2' in calls[1][0]


def test_taxonomy_is_scoped_to_video_detail():
    soup = cw.BeautifulSoup('''<a href="/tags/global/">global</a><div id="tab_video_info">
      <span>Submitted: <em>3 days ago</em></span><div class="username"><a href="/members/3/">Uploader</a></div>
      <a href="/tags/oil/">oil</a><a href="/categories/onlyfans/">OnlyFans</a></div>''', 'lxml')
    assert cw._cw_detail_taxonomy(soup) == {'tags':['oil'], 'categories':['OnlyFans'], 'models':[], 'uploader':'Uploader', 'added':'3 days ago'}


def test_member_search_validates_and_uses_posted_video_pagination(monkeypatch):
    calls = session_with(monkeypatch, iter([
        response(200, '<a class="item" href="/videos/1/test/">One</a>'),
        response(200, '<a class="item" href="/videos/2/test/">Two</a>'),
    ]))
    result = cw.scrape_camwhores_discovery(keyword='https://www.camwhores.tv/members/2285833/', search_mode='member', pages=2, listing_only=True)
    assert len(result) == 2
    assert '/members/2285833/videos/' in calls[0][0]
    assert 'from_videos=2' in calls[1][0]
    with pytest.raises(cw.CamwhoresSourceError):
        cw.scrape_camwhores_discovery(keyword='https://example.com/members/123/', search_mode='member', listing_only=True)


def test_latest_scans_requested_twenty_pages(monkeypatch):
    responses = (response(200, f'<a class="item" href="/videos/{i}/test/">Video</a>') for i in range(1, 21))
    calls = session_with(monkeypatch, responses)
    report = {}
    videos = cw.scrape_camwhores_discovery(search_mode='latest', pages=20, listing_only=True, report=report)
    assert len(calls) == len(videos) == 20
    assert report['pages_requested'] == report['pages_scanned'] == 20
    assert '?from=20' in calls[-1][0]
    with pytest.raises(cw.CamwhoresSourceError, match='1 a 20'):
        cw.scrape_camwhores_discovery(search_mode='latest', pages=21, listing_only=True)
