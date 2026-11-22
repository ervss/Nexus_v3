import pytest

from app.url_safety import require_public_http_url, safe_resolve_ip, validate_redirect_url


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/admin",
    "http://10.2.3.4/file",
    "http://172.16.0.1/file",
    "http://192.168.1.2/file",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://service.local/path",
    "http://user:secret@example.com/path",
])
def test_private_and_credentialed_proxy_urls_are_rejected(url):
    with pytest.raises(ValueError):
        require_public_http_url(url)


@pytest.mark.parametrize("url", [
    "https://cdn.example.com/video.mp4?token=abc",
    "http://8.8.8.8/image.jpg",
    "https://[2606:4700:4700::1111]/asset",
])
def test_public_proxy_urls_are_preserved(url):
    assert require_public_http_url(url) == url


def test_safe_resolve_ip_rejects_private():
    with pytest.raises(ValueError):
        safe_resolve_ip("127.0.0.1")
    with pytest.raises(ValueError):
        safe_resolve_ip("localhost")
    with pytest.raises(ValueError):
        safe_resolve_ip("myrouter.local")


def test_safe_resolve_ip_accepts_public_ip():
    res = safe_resolve_ip("8.8.8.8")
    assert res == ["8.8.8.8"]


def test_validate_redirect_url():
    assert validate_redirect_url("https://example.com/video.mp4", hops=2, max_hops=5) == "https://example.com/video.mp4"
    with pytest.raises(ValueError):
        validate_redirect_url("https://example.com/video.mp4", hops=6, max_hops=5)
    with pytest.raises(ValueError):
        validate_redirect_url("http://192.168.1.1/video.mp4", hops=1, max_hops=5)
