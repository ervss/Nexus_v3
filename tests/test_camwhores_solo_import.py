import asyncio
from fastapi import BackgroundTasks
from app.main import camwhores_discovery_import


def test_camwhores_solo_and_album_keep_distinct_batch_semantics():
    urls = ['https://www.camwhores.tv/videos/123/example/']
    for standalone, expected in [(True, None), (False, 'My collection')]:
        tasks = BackgroundTasks()
        result = asyncio.run(camwhores_discovery_import(
            tasks, selected_urls=urls, batch_name='My collection', items=[],
            standalone=standalone, db=None, auth=True,
        ))
        assert result['status'] == 'queued'
        assert result['batch'] == expected
        assert len(tasks.tasks) == 1
        assert tasks.tasks[0].args[:3] == (urls, expected, 'camwhores')


def test_standalone_endpoint_passes_no_batch():
    from app.main import camwhores_discovery_import_standalone
    urls = ['https://www.camwhores.tv/videos/124/example/']
    tasks = BackgroundTasks()
    result = asyncio.run(camwhores_discovery_import_standalone(
        tasks, selected_urls=urls, items=[], db=None, auth=True,
    ))
    assert result['status'] == 'queued'
    assert result['batch'] is None
    assert tasks.tasks[0].args[:3] == (urls, None, 'camwhores')
