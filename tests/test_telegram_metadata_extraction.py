from app.telegram_metadata import extract_telegram_metadata

CAPTION = """🎉 $20 — LIFETIME ACCESS to VIP + 2 months to OnlyFans
All information | How to get access
Questions — @vksevensins

[OnlyFans] Tayleah Jade [POV Big Tits Lingerie Blowjob Cum in Mouth]
#OnlyFans #TayleahJade #POV #BigTits #Lingerie #Blowjob #CumInMouth"""


def test_extracts_scene_after_ad_in_new_and_flattened_captions():
    for caption in (CAPTION, ' '.join(CAPTION.split())):
        result = extract_telegram_metadata(caption, message_id=42)
        assert result['title'] == 'Tayleah Jade'
        assert result['performers'] == ['Tayleah Jade']
        assert result['platform'] == 'OnlyFans'
        assert result['scene_title'] == 'POV Big Tits Lingerie Blowjob Cum in Mouth'
        assert result['tags'] == ['POV', 'Big Tits', 'Lingerie', 'Blowjob', 'Cum In Mouth']


def test_promo_only_uses_fallback_without_inventing_performer():
    result = extract_telegram_metadata('$20 lifetime access to VIP @seller', 'VID_123.mp4', '$20 lifetime access', 42)
    assert result['title'] == 'Telegram #42'
    assert result['performers'] == []


def test_normal_caption_and_file_fallback():
    assert extract_telegram_metadata('A real scene title\n#POV')['title'] == 'A real scene title'
    assert extract_telegram_metadata('', 'A_scene_title.mp4')['title'] == 'A scene title'
    assert extract_telegram_metadata('', fallback_title='Original title')['title'] == 'Original title'


def test_existing_index_row_gets_metadata_without_database_migration():
    from app.telegram_index import _row_to_video_dict
    row = dict(chat_id=1, message_id=2, channel='channel', author='', title='$20 lifetime access',
               caption=' '.join(CAPTION.split()), file_name='', duration='', duration_sec=0,
               size_bytes=0, width=0, height=0, effective_res=0, quality='', orientation='',
               views=0, forwards=0, reactions=0, date='', url='', stream_url='', video_url='',
               thumbnail='', has_thumb=False, source_channels='[]')
    result = _row_to_video_dict(row)
    assert result['title'] == 'Tayleah Jade'
    assert result['text'] == row['caption']
    assert result['tags'][0] == 'POV'
