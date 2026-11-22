"""Playback references use the shared range/decryption handler without a DB write."""
import asyncio
from unittest.mock import AsyncMock, patch
import pytest
from fastapi import HTTPException
from starlette.requests import Request
from app.routers import mega
from app.extractors import mega_native as mn


def test_preview_stream_validates_reference_and_delegates_range_request():
    ref = mn.MegaRef('file', 'abcd1234', (1, 2, 3, 4, 5, 6, 7, 8)).to_compact()
    request = Request({'type': 'http', 'method': 'GET', 'headers': [(b'range', b'bytes=100-199')]})
    response = object()
    with patch.object(mega, '_stream_mega_ref', AsyncMock(return_value=response)) as stream:
        assert asyncio.run(mega.mega_stream_ref(ref, request)) is response
        stream.assert_awaited_once_with(ref, request, 'preview')
        assert request.headers['range'] == 'bytes=100-199'


@pytest.mark.parametrize('ref', ['garbage', 'mega:f:abcd1234:badkey'])
def test_preview_stream_rejects_invalid_references_before_network(ref):
    with patch.object(mega, '_stream_mega_ref', AsyncMock()) as stream:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(mega.mega_stream_ref(ref, None))
        assert exc.value.status_code == 400
        stream.assert_not_awaited()
