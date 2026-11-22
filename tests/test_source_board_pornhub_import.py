"""Regression coverage for source-board import mode selection."""

import unittest

from app.routers.source_boards import _should_use_shell_only


class SourceBoardPornhubImportTests(unittest.TestCase):
    def test_large_pornhub_board_keeps_metadata_resolution_enabled(self):
        """Pornhub watch pages need resolving before they can be playable."""
        self.assertFalse(_should_use_shell_only("pornhub", 58))

    def test_large_file_host_board_can_still_use_shell_only_mode(self):
        self.assertTrue(_should_use_shell_only("filester", 58))


if __name__ == "__main__":
    unittest.main()
