from app.extractors.noodlemagazine import NoodleMagazineExtractor


def test_collect_playlist_sources_reads_nested_source_objects():
    html = '''
        <script>
        window.playlist = {"image":"preview.jpg","sources":[
          {"file":"https://cdn.example/video_1080p.mp4?token=one","label":"1080"},
          {"file":"https://cdn.example/video_720p.mp4?token=two","label":"720"}
        ],"trusted":true};
        </script>
    '''

    assert NoodleMagazineExtractor._collect_playlist_sources(html) == [
        "https://cdn.example/video_1080p.mp4?token=one",
        "https://cdn.example/video_720p.mp4?token=two",
    ]
