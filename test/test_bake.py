"""Unit tests for bake.py — the static-viewer HTML injection and the in-place bake.
Run: python3 -m unittest discover -s test -p test_bake.py -v"""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bake as bake_module  # noqa: E402
from bake import BUNDLE_NAME, MARKER, bake, inject  # noqa: E402


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

    def test_last_closing_tag_wins(self):
        # An inlined script can carry the literal closing tags; the snippet must land at the real end.
        src = '<html><body><script>var s = "</body></html>";</script>\n</body></html>'
        out, changed = inject(src)
        self.assertTrue(changed)
        script_end = out.index("</script>")
        self.assertGreater(out.index(MARKER), script_end)
        self.assertLess(out.index(MARKER), out.rindex("</body>"))
        self.assertIn('var s = "</body></html>";', out)  # decoy untouched


class BakeTests(unittest.TestCase):
    """bake() against a throwaway viewer directory and a stand-in bundle."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.viewer = os.path.join(tmp.name, "viewer")
        os.mkdir(self.viewer)
        self.bundle = os.path.join(tmp.name, BUNDLE_NAME)
        self._write(self.bundle, "window.ROIDraw = {};\n")
        patcher = mock.patch.object(bake_module, "BUNDLE", self.bundle)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _write(path, text):
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    @staticmethod
    def _read(path):
        with open(path, encoding="utf-8") as f:
            return f.read()

    def test_missing_bundle(self):
        os.remove(self.bundle)
        self._write(os.path.join(self.viewer, "index.html"), "<body></body>")
        with self.assertRaises(SystemExit) as cm:
            bake(self.viewer)
        self.assertIn("npm run build", str(cm.exception))

    def test_defaults_to_index_html(self):
        # make_static writes index.html; it wins over a viewer.html sitting beside it.
        self._write(os.path.join(self.viewer, "index.html"), "<body></body>")
        self._write(os.path.join(self.viewer, "viewer.html"), "<body></body>")
        path, changed = bake(self.viewer)
        self.assertTrue(changed)
        self.assertEqual(os.path.basename(path), "index.html")
        self.assertIn(MARKER, self._read(path))
        self.assertNotIn(MARKER, self._read(os.path.join(self.viewer, "viewer.html")))

    def test_falls_back_to_viewer_html(self):
        self._write(os.path.join(self.viewer, "viewer.html"), "<body></body>")
        path, _ = bake(self.viewer)
        self.assertEqual(os.path.basename(path), "viewer.html")

    def test_explicit_html_and_missing_html(self):
        self._write(os.path.join(self.viewer, "page.html"), "<body></body>")
        path, _ = bake(self.viewer, "page.html")
        self.assertEqual(os.path.basename(path), "page.html")
        with self.assertRaises(SystemExit):
            bake(self.viewer, "absent.html")
        empty = os.path.join(os.path.dirname(self.viewer), "empty")
        os.mkdir(empty)
        with self.assertRaises(SystemExit):
            bake(empty)

    def test_copies_bundle_and_rerun_refreshes_it(self):
        self._write(os.path.join(self.viewer, "index.html"), "<body></body>")
        bake(self.viewer)
        copied = os.path.join(self.viewer, BUNDLE_NAME)
        self.assertEqual(self._read(copied), self._read(self.bundle))
        self._write(self.bundle, "window.ROIDraw = {v: 2};\n")
        _, changed = bake(self.viewer)
        self.assertFalse(changed)  # tags already present ...
        self.assertEqual(self._read(copied), "window.ROIDraw = {v: 2};\n")  # ... but the bundle is refreshed


if __name__ == "__main__":
    unittest.main()
