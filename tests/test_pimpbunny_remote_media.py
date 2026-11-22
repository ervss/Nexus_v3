import ast
import asyncio
import logging
from pathlib import Path
import re
import unittest
from unittest.mock import Mock

from app.media_urls import is_pimpbunny_remote_media


STREAM = "https://st30.pimpbunny.com/remote_control.php?file=opaque.mp4&acctoken=signed"


class PimpBunnyRemoteMediaTests(unittest.TestCase):
    def test_signed_and_encoded_filenames(self):
        self.assertTrue(is_pimpbunny_remote_media(STREAM))
        self.assertTrue(is_pimpbunny_remote_media(STREAM.replace("opaque.mp4", "folder%2Fopaque%2Emp4")))
        for url in (STREAM.replace("pimpbunny.com", "pimpbunny.com.evil.test"),
                    STREAM.replace("opaque.mp4", "opaque"),
                    "https://pimpbunny.com/videos/example/", "http://["):
            self.assertFalse(is_pimpbunny_remote_media(url))

    def test_extractor_returns_stream_without_fetching_html(self):
        # Load the actual extractor class without initializing the app registry.
        path = Path("app/extractors/pimpbunny.py")
        tree = ast.parse(path.read_text(encoding="utf-8"))
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef))
        namespace = dict(VideoExtractor=object, Optional=__import__('typing').Optional,
                         Dict=__import__('typing').Dict, Any=__import__('typing').Any,
                         re=re, logging=logging, is_pimpbunny_remote_media=is_pimpbunny_remote_media)
        exec(compile(ast.Module(body=[cls], type_ignores=[]), str(path), "exec"), namespace)
        extractor = namespace["PimpBunnyExtractor"]()
        extractor._extract_sync = Mock(side_effect=AssertionError("Must not fetch media as HTML"))
        result = asyncio.run(extractor.extract(STREAM))
        self.assertEqual(result["stream_url"], STREAM)
        extractor._extract_sync.assert_not_called()

    def test_bulk_import_recognizes_ready_stream(self):
        path = Path("app/routers/bulk_import.py")
        tree = ast.parse(path.read_text(encoding="utf-8"))
        route = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "import_bulk")
        helper = next(n for n in route.body if isinstance(n, ast.FunctionDef) and n.name == "_is_direct_media_url")
        namespace = dict(Optional=__import__('typing').Optional, re=re,
                         is_pimpbunny_remote_media=is_pimpbunny_remote_media)
        exec(compile(ast.Module(body=[helper], type_ignores=[]), str(path), "exec"), namespace)
        self.assertTrue(namespace["_is_direct_media_url"](STREAM))


if __name__ == "__main__":
    unittest.main()
