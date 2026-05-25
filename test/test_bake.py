"""Unit tests for bake.inject — the static-viewer HTML injection. Run: python3 -m unittest -v test.test_bake"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bake import inject, MARKER  # noqa: E402


class InjectTests(unittest.TestCase):
    def test_before_body(self):
        out, changed = inject("<html><body>hi</body></html>")
        self.assertTrue(changed)
        self.assertIn(MARKER, out)
        self.assertLess(out.index(MARKER), out.index("</body>"))  # before the closing tag
        self.assertTrue(out.rstrip().endswith("</html>"))

    def test_html_fallback_when_no_body(self):
        out, changed = inject("<html>content</html>")
        self.assertTrue(changed)
        self.assertLess(out.index(MARKER), out.index("</html>"))

    def test_append_when_no_closing_tags(self):
        # pycortex make_static fragments end without </body></html>
        src = "<div id=brain></div>\n<div id=legend></div>\n"
        out, changed = inject(src)
        self.assertTrue(changed)
        self.assertTrue(out.startswith(src))      # original preserved
        self.assertIn(MARKER, out)

    def test_idempotent(self):
        once, _ = inject("<body></body>")
        twice, changed = inject(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)
        self.assertEqual(twice.count(MARKER), 1)  # not doubled


if __name__ == "__main__":
    unittest.main()
