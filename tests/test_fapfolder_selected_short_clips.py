import ast
import re
import urllib.parse
from pathlib import Path
import unittest

source = Path('app/routers/bulk_import.py').read_text(encoding='utf-8-sig')
node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'is_explicit_fapfolder_media')
namespace = {'re': re, 'urllib': urllib}
exec(compile(ast.Module(body=[node], type_ignores=[]), '<scoped-import-policy>', 'exec'), namespace)

class FapFolderSelectedShortClips(unittest.TestCase):
    def test_only_explicit_direct_gallery_files_keep_short_duration(self):
        check = namespace['is_explicit_fapfolder_media']
        self.assertTrue(check('https://cdn.example/video.mp4?token=x', 'https://fapfolder.club/posts/1', 'fapfolder,extension'))
        self.assertFalse(check('https://cdn.example/video.mp4', 'https://example.com/posts/1', 'extension'))
        self.assertFalse(check('https://cdn.example/video.mp4', 'https://fakefapfolder.club/posts/1', 'extension'))
        self.assertFalse(check('https://fapfolder.club/posts/1', 'https://fapfolder.club/posts/1', 'extension'))
        self.assertFalse(check('https://cdn.example/video.mp4', 'https://fapfolder.club/posts/1', 'fapfolder'))

if __name__ == '__main__':
    unittest.main()
