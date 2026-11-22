import asyncio

import pytest

from app.balbums_checkpoint import (
    browser_profile,
    fingerprint,
    is_blocked_listing,
    is_sentinel,
    parse_challenge,
    probe_answers,
    retry_challenge,
    solve_pow,
    solution,
)
from app.discovery_hub_runtime import HubResponse, HubRuntime


CHALLENGE_HTML = (
    '<html><title>Checkpoint | Sentinel</title><script>'
    'var C={"p":[[7,"!!navigator.webdriver"],[2,"screen.width"],'
    '[10,"(navigator.languages||[navigator.language]).join(\',\')"]],'
    '"n":"1794843730.16.2-6-10.1.c.abc","m":"9b7f8c155137c77762dc9f320bfc6417",'
    '"b":16,"i":"","v":"/.well-known/checkpoint"},rounds=0</script></html>'
)


def test_pow_matches_the_accepted_checkpoint_nonce():
    assert solve_pow("9b7f8c155137c77762dc9f320bfc6417", 16) == 48711


def test_probe_answers_follow_the_fingerprint():
    profile = browser_profile()
    challenge = parse_challenge(CHALLENGE_HTML)
    answers = probe_answers(challenge["p"], profile)
    fp = fingerprint(profile)
    assert answers["7"] == "false"
    assert answers["2"] == str(fp["sw"])
    assert answers["10"] == fp["langs"]
    assert is_sentinel(CHALLENGE_HTML)
    assert is_blocked_listing(CHALLENGE_HTML)
    assert not is_blocked_listing("<html><a href='/a/one'>One</a></html>")


def test_solution_carries_the_proof_and_typed_characters():
    challenge = parse_challenge(CHALLENGE_HTML)
    payload = solution(challenge, "VKAXY", browser_profile())
    assert payload["c"] == 48711
    assert payload["t"] == "VKAXY"
    assert payload["n"] == challenge["n"]
    assert payload["fp"]["webdriver"] is False
    assert payload["fp"]["sig"] == []


def test_retry_body_and_braces_inside_strings():
    html = '<script>var C={"n":"a}b","m":"cd","b":8,"t":"say } hi"},rounds=0</script>'
    assert parse_challenge(html)["n"] == "a}b"
    assert retry_challenge('{"wrong":true,"retry":{"n":"next","m":"salt","b":16}}')["n"] == "next"
    assert retry_challenge('{"wrong":true}') is None


def _sentinel_session(text, status=403):
    class Body:
        async def iter_chunked(self, size):
            yield text.encode()
    class Response:
        content_length = None
        charset = "utf-8"
        headers = {}
        content = Body()
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return None
    Response.status = status
    class Session:
        closed = False
        def get(self, *args, **kwargs):
            return Response()
    return Session()


def test_sentinel_403_is_replaced_and_the_listing_is_cached():
    async def run():
        owner = HubRuntime()
        owner.session = _sentinel_session(CHALLENGE_HTML)
        seen = []
        async def recovered(url, timeout, max_bytes, seed):
            seen.append(seed)
            return HubResponse(200, "<html><a href='/a/newest'>Newest</a></html>")
        owner._recover_balbums = recovered
        first = await owner.get("https://balbums.st/?page=1", timeout=5)
        second = await owner.get("https://balbums.st/?page=1", timeout=5)
        assert first is second
        assert "newest" in first.text
        assert seen == [CHALLENGE_HTML]
        assert owner.pending_http == 0
    asyncio.run(run())


def test_failed_checkpoint_still_reports_the_403():
    async def run():
        owner = HubRuntime()
        owner.session = _sentinel_session(CHALLENGE_HTML)
        async def recovered(*args, **kwargs):
            return None
        owner._recover_balbums = recovered
        with pytest.raises(RuntimeError, match="HTTP 403"):
            await owner.get("https://balbums.st/?page=1", timeout=5)
        assert owner.pending_http == 0
        assert owner.balbums_pages.get(("https://balbums.st/?page=1", ())) is None
    asyncio.run(run())
