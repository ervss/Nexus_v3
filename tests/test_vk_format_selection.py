from app.extractors.vk import _select_vk_best_format


def test_select_vk_best_format_skips_dash_mpd_and_picks_direct_mp4():
    formats = [
        {
            "format_id": "dash_ondemand-audio_high",
            "ext": "m4a",
            "protocol": "http_dash_segments",
            "vcodec": "none",
            "acodec": "mp4a.40.2",
            "height": None,
            "url": "https://vkvd676.okcdn.ru/ondemand/dash4.mpd",
        },
        {
            "format_id": "dash_ondemand-video_fullhd",
            "ext": "mp4",
            "protocol": "http_dash_segments",
            "vcodec": "avc1.640028",
            "acodec": "none",
            "height": 1080,
            "url": "https://vkvd676.okcdn.ru/ondemand/dash4.mpd",
        },
        {
            "format_id": "hls_ondemand-3706",
            "ext": "mp4",
            "protocol": "m3u8_native",
            "vcodec": "avc1.640028",
            "acodec": "mp4a.40.2",
            "height": 1080,
            "url": "https://vkvd676.okcdn.ru/ondemand/hls.m3u8",
        },
        {
            "format_id": "url1080",
            "ext": "mp4",
            "protocol": "https",
            "vcodec": None,
            "acodec": None,
            "height": 1080,
            "url": "https://vkvd676.okcdn.ru/?srcIp=1.2.3.4&type=3",
        },
    ]

    best, height = _select_vk_best_format(formats)
    assert best is not None
    assert best["format_id"] == "url1080"
    assert height == 1080


def test_select_vk_best_format_falls_back_to_hls_not_dash():
    formats = [
        {
            "format_id": "dash_ondemand-video_fullhd",
            "ext": "mp4",
            "protocol": "http_dash_segments",
            "vcodec": "avc1.640028",
            "acodec": "none",
            "height": 1080,
            "url": "https://vkvd676.okcdn.ru/ondemand/dash4.mpd",
        },
        {
            "format_id": "hls_ondemand-3706",
            "ext": "mp4",
            "protocol": "m3u8_native",
            "vcodec": "avc1.640028",
            "acodec": "mp4a.40.2",
            "height": 720,
            "url": "https://vkvd676.okcdn.ru/ondemand/hls.m3u8",
        },
    ]

    best, height = _select_vk_best_format(formats)
    assert best is not None
    assert best["format_id"] == "hls_ondemand-3706"
    assert height == 720
