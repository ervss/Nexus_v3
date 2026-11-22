import base64
from urllib.parse import quote

import msgpack

from app.extractors.ixxx import IxxxExtractor


def test_outbound_card_uses_decoded_destination_and_card_metadata():
    url = 'https://example.com/video/123?x=1'
    token = base64.urlsafe_b64encode(msgpack.packb({'url': url}, use_bin_type=True)).decode().rstrip('=')
    html = f'''<div data-public-id="123"><a class="item-link" href="/out/?l={quote(token)}">
        <img alt="Example scene" src="/thumb.jpg"></a><span class="duration">12:34</span></div>'''
    rows = IxxxExtractor()._parse_listing_page(html, 'https://www.ixxx.com/search/?query=example')
    assert len(rows) == 1
    assert rows[0]['url'] == rows[0]['source_url'] == url
    assert rows[0]['title'] == 'Example scene'
    assert rows[0]['duration'] == 754
