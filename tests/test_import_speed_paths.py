import unittest

from app.intake import domain_concurrency, intake_item_already_playable


class ImportSpeedPathTests(unittest.TestCase):
    def test_album_hosts_overlap_and_tube_sites_stay_serial(self):
        self.assertEqual(domain_concurrency("bunkr.cr"), 4)
        self.assertEqual(domain_concurrency("filester.me"), 3)
        self.assertEqual(domain_concurrency("gofile.io"), 3)
        self.assertEqual(domain_concurrency("www.pornhub.com"), 1)
        self.assertEqual(domain_concurrency("www.eporner.com"), 1)
        self.assertEqual(domain_concurrency("example.com"), 2)

    def test_playable_direct_file_skips_a_second_probe(self):
        self.assertTrue(intake_item_already_playable(
            "https://cdn.example/clip.mp4?token=1",
            42,
            "Clip",
        ))

    def test_page_url_or_missing_duration_still_needs_resolve(self):
        self.assertFalse(intake_item_already_playable(
            "https://bunkr.cr/f/abc",
            42,
            "Clip",
        ))
        self.assertFalse(intake_item_already_playable(
            "https://cdn.example/clip.mp4",
            3,
            "Clip",
        ))
        self.assertFalse(intake_item_already_playable(
            "https://cdn.example/clip.mp4",
            42,
            "Queued...",
        ))


if __name__ == "__main__":
    unittest.main()
