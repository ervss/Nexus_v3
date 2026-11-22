from urllib.parse import parse_qs, urlparse

from app.extractors.camwhores import CamwhoresExtractor, normalize_camwhores_get_file_rnd


def test_html_query_entities_do_not_become_parameter_names():
    raw = 'https://www.camwhores.tv/get_file/1/hash/123.mp4/?v-acctoken=abc&amp;rnd=123'
    query = parse_qs(urlparse(normalize_camwhores_get_file_rnd(raw)).query)
    assert query['v-acctoken'] == ['abc']
    assert set(query) == {'v-acctoken', 'rnd'}
    assert len(query['rnd']) == 1
    assert '&amp;' not in CamwhoresExtractor._sanitize_url(raw)


def test_previously_encoded_entity_parameter_is_repaired():
    raw = 'https://www.camwhores.tv/get_file/1/hash/123.mp4/?v-acctoken=abc&amp%3Brnd=123&rnd=456'
    query = parse_qs(urlparse(normalize_camwhores_get_file_rnd(raw)).query)
    assert set(query) == {'v-acctoken', 'rnd'}
    assert len(query['rnd']) == 1
