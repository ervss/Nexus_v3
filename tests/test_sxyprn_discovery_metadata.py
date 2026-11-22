import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app.sxyprn_discovery import (
    _parse_cards,
    _parse_post_detail,
    _parse_video_info,
    enrich_sxyprn_posts,
    probe_best_post_streams,
)


SAMPLE_LISTING_HTML = """
<div class='post_el_small'>
  <div class='pes_author_div transition'><a href='/blog/abc123/0.html'><span class='a_name'>AuthorOne</span></a></div>
  <div class='pes_wl transition' data-postid='6afe3817cfc9e'></div>
  <div class='post_text'>Sample Video One <a class="hash_link" label="Milf" href="/Milf.html">#Milf</a> <a href='https://vidara.so/v/xyz12345' target='_blank' rel='nofollow' title='>External Link!<' class='extlink_icon extlink'>vidara.so</a></div>
  <div class='vid_container'>
    <img data-src='//b1.trafficdeposit.com/pivi/1/5/vid/abc/123/small.jpg'>
    <video class='hvp_player' src='//b1.trafficdeposit.com/pivi/1/5/vid/abc/123/vidthumb.mp4'></video>
    <span class='duration_small' title='s5->c6'>34:46</span>
    <span class='shd_small' title='bitrate:2322|'>HD</span>
  </div>
</div>
<div class='post_el_small'>
  <div class='pes_author_div transition'><a href='/blog/def456/0.html'><span class='a_name'>AuthorTwo</span></a></div>
  <div class='pes_wl transition' data-postid='6af82fdad05b9'></div>
  <div class='post_text'>Sample SD Video</div>
  <div class='vid_container'>
    <img data-src='//b1.trafficdeposit.com/pivi/1/5/vid/def/456/0.webp'>
    <span class='duration_small' title='s5->c6'>29:40</span>
    <span class='shd_small' title='bitrate:2070|height:480|'>SD</span>
  </div>
</div>
<div class='post_el_small'>
  <div class='pes_author_div transition'><a href='/blog/ghi789/0.html'><span class='a_name'>AuthorThree</span></a></div>
  <div class='pes_wl transition' data-postid='6afd42b43918f'></div>
  <div class='post_text'>No Badge Video</div>
  <div class='vid_container'>
    <img data-src='//b1.trafficdeposit.com/pivi/1/5/vid/ghi/789/0.webp'>
    <span class='duration_small' title='s5->c6'>10:38</span>
  </div>
</div>
"""


SAMPLE_POST_HTML = """
<html><body>
  <div id='6afd42b43918f'>
    <div class='post_text'>No Badge Video
      <a href='https://vidara.so/v/testcode99' target='_blank' rel='nofollow' title='x' class='extlink_icon extlink'>vidara.so</a>
    </div>
    <div style='color:#B3B4B7;font-family:monospace;font-size:10px;'>
      Video Info -> duration:<b>10:38</b> · resolution:<b>HD</b>720 · bitrate:<b>1423</b> kb/s · size:<b>108</b> MB
    </div>
  </div>
  <div class='post_el_small' data-postid='deadbeef'>
    <a href='https://doodstream.com/e/recommended99' target='_blank' rel='nofollow' title='x' class='extlink_icon extlink'>doodstream.com</a>
  </div>
</body></html>
"""


class TestSxyPrnDiscoveryMetadata(unittest.TestCase):
    def test_parse_cards_extracts_quality_and_estimated_size(self):
        cards = _parse_cards(SAMPLE_LISTING_HTML)
        self.assertEqual(len(cards), 3)

        c0, c1, c2 = cards
        self.assertEqual(c0["quality"], "HD")
        self.assertEqual(c0["height"], 0)
        self.assertEqual(c0["duration_sec"], 34 * 60 + 46)
        self.assertGreater(c0["file_size_mb"], 570)
        self.assertTrue(c0["size_estimated"])
        self.assertTrue(c0["size_label"].endswith("MB"))

        self.assertEqual(c1["quality"], "480p")
        self.assertEqual(c1["height"], 480)
        self.assertGreater(c1["file_size_mb"], 430)

        self.assertEqual(c2["quality"], "")
        self.assertEqual(c2["file_size_mb"], 0.0)
        self.assertEqual(c2["size_label"], "")

    def test_parse_video_info_handles_gb_and_mb(self):
        gb_html = "<div>Video Info -> duration:<b>01:30:00</b> · resolution:<b>FHD</b>1080 · bitrate:<b>2500</b> kb/s · size:<b>1.45</b> GB</div>"
        info = _parse_video_info(gb_html)
        self.assertEqual(info["quality"], "1080p")
        self.assertEqual(info["height"], 1080)
        self.assertEqual(info["duration_sec"], 5400)
        self.assertAlmostEqual(info["file_size_mb"], 1484.8, places=1)
        self.assertEqual(info["size_label"], "1.45 GB")
        self.assertFalse(info["size_estimated"])

    def test_parse_post_detail_extracts_exact_metadata_and_scoped_streams(self):
        detail = _parse_post_detail(SAMPLE_POST_HTML, "6afd42b43918f")
        self.assertEqual(detail["quality"], "720p")
        self.assertEqual(detail["height"], 720)
        self.assertEqual(detail["file_size_mb"], 108.0)
        self.assertEqual(detail["size_label"], "108 MB")
        self.assertFalse(detail["size_estimated"])
        self.assertEqual(len(detail["streams"]), 1)
        self.assertEqual(detail["streams"][0]["url"], "https://vidara.so/v/testcode99")

    def test_probe_best_post_streams_picks_largest_highest_quality_mirror(self):
        streams = [
            {"url": "https://vidara.to/v/FkE0ReGcCivCR", "host": "vidara.to"},
            {"url": "https://lulustream.com/d/tp9pubxoaxcb", "host": "lulustream.com"},
            {"url": "https://doodstream.com/d/ws1ld6blseg5", "host": "doodstream.com"},
        ]

        async def fake_probe(_client, source_url, **_kwargs):
            if "vidara.to" in source_url:
                return {
                    "source_url": source_url,
                    "stream_url": "https://cdn.vidara.to/hls/master.m3u8",
                    "host": "vidara.to",
                    "is_hls": True,
                    "is_direct_stream": True,
                    "quality": "720p",
                    "height": 720,
                    "file_size_mb": 229.5,
                    "size_label": "230 MB",
                    "size_exact": False,
                    "size_estimated": True,
                    "status": "verified",
                }
            if "lulustream.com" in source_url:
                return {
                    "source_url": source_url,
                    "stream_url": "https://cdn1010.cdn-tnmr.org/hls2/master.m3u8",
                    "host": "lulustream.com",
                    "is_hls": True,
                    "is_direct_stream": True,
                    "quality": "1080p",
                    "height": 1080,
                    "file_size_mb": 1640.1,
                    "size_label": "1.60 GB",
                    "size_exact": False,
                    "size_estimated": True,
                    "status": "verified",
                }
            return {
                "source_url": source_url,
                "stream_url": source_url,
                "host": "doodstream.com",
                "is_hls": False,
                "is_direct_stream": False,
                "quality": "720p",
                "height": 720,
                "file_size_mb": 390.0,
                "size_label": "390 MB",
                "size_exact": False,
                "size_estimated": False,
                "status": "fallback",
            }

        with patch("app.sxyprn_discovery.probe_external_stream_candidate", side_effect=fake_probe):
            res = asyncio.run(
                probe_best_post_streams(
                    streams,
                    duration_sec=2009,
                    fallback_quality="720p",
                    fallback_height=720,
                    fallback_size_mb=390.0,
                )
            )

        best = res["best"]
        self.assertIsNotNone(best)
        self.assertEqual(best["host"], "lulustream.com")
        self.assertEqual(best["height"], 1080)
        self.assertEqual(best["quality"], "1080p")
        self.assertAlmostEqual(best["file_size_mb"], 1640.1, places=1)
        self.assertEqual(best["size_label"], "1.60 GB")
        # Direct verified streams come before unverified fallback even if fallback had page size 390 MB > vidara 229.5 MB
        self.assertEqual([c["host"] for c in res["candidates"]], ["lulustream.com", "vidara.to", "doodstream.com"])


if __name__ == "__main__":
    unittest.main()
