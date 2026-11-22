import asyncio

from app.routers import card_availability as cards


def test_private_and_non_http_urls_are_not_probed():
    async def run():
        for url in ('http://127.0.0.1/private', 'http://[::1]/', 'file:///etc/passwd'):
            assert await cards._probe(url) == 'unknown'
    asyncio.run(run())


def test_concurrent_checks_share_cached_result(monkeypatch):
    async def run():
        cards._cache.clear()
        cards._inflight.clear()
        calls = []
        async def probe(url):
            calls.append(url)
            await asyncio.sleep(0)
            return 'offline'
        monkeypatch.setattr(cards, '_probe', probe)
        url = 'https://example.com/video'
        assert await asyncio.gather(cards._cached_probe(url), cards._cached_probe(url)) == ['offline', 'offline']
        assert await cards._cached_probe(url) == 'offline'
        assert calls == [url]
        cards._cache.clear()
    asyncio.run(run())
