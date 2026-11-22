import asyncio
from unittest.mock import MagicMock

from app.nexus_intel import _select_pornhub_proxy_stream


def test_pornhub_probe_uses_proxy_transport_and_skips_rejected_candidate(monkeypatch):
    import requests
    rejected = MagicMock(status_code=403, headers={})
    accepted = MagicMock(status_code=200, headers={'Content-Type': 'application/vnd.apple.mpegurl'})
    first = MagicMock(); first.__enter__.return_value = rejected
    second = MagicMock(); second.__enter__.return_value = accepted
    get = MagicMock(side_effect=[first, second])
    monkeypatch.setattr(requests, 'get', get)
    urls = ['https://ev-h.phncdn.com/a.m3u8', 'https://ev-h.phncdn.com/b.m3u8']
    result = asyncio.run(_select_pornhub_proxy_stream(urls, {'session': 'value'}, 'https://www.pornhub.com/view_video.php?viewkey=x'))
    assert result == urls[1]
    assert get.call_args.kwargs['cookies'] == {'session': 'value'}
    assert get.call_args.kwargs['headers']['Referer'].endswith('viewkey=x')
    assert get.call_args.kwargs['stream'] is True
