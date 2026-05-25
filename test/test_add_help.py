"""Unit tests for add_help (static help-menu injection). Run: python3 test/test_add_help.py -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from add_help import add_help, build_panel, bound_keys  # noqa: E402


class AddHelpTests(unittest.TestCase):
    # a modern (mriview) viewer with NO help menu, the #main template, and a few bound keys
    NOHELP = ('<script>var mriview={}; var d=[{key:"r"},{key:"f"},{key:"L"}];</script>'
              '<script type="text/html" id=mriview_html><div id="main">'
              '<div id="braincontainer"></div></div></script>')
    NO_MRIVIEW = '<div id="main"></div>'

    def test_injects_panel_hint_and_toggle(self):
        out, changed = add_help(self.NOHELP)
        self.assertTrue(changed)
        self.assertIn('id="pycortex-static-help"', out)        # the panel
        self.assertIn("right-drag", out)                        # verified mouse control (not a guess)
        self.assertIn("press <b>h</b> for help", out)           # the hint
        self.assertIn("__pcxStaticHelp", out)                   # the 'h' toggle script
        # panel built INTO the #main template, so it survives the viewer's on-load DOM rebuild
        self.assertTrue(out.find('<div id="main">') < out.find('id="pycortex-static-help"') < out.find('id="braincontainer"'))

    def test_keyboard_lists_only_bound_keys(self):
        out, _ = add_help(self.NOHELP)
        self.assertIn("reset view", out)        # 'r' is bound -> listed
        self.assertIn("flatten", out)           # 'f' is bound -> listed
        self.assertNotIn("pial surface", out)   # 'p' NOT bound -> not listed
        self.assertNotIn("save view as PNG", out)  # 'S' NOT bound -> not listed

    def test_skips_when_generated_help_exists(self):
        src = self.NOHELP + "<script>var helpmenu = function(){};</script>"
        out, changed = add_help(src)
        self.assertFalse(changed)               # don't double up on a real help menu
        self.assertEqual(src, out)

    def test_skips_old_engine(self):
        out, changed = add_help(self.NO_MRIVIEW)   # no mriview
        self.assertFalse(changed)
        self.assertEqual(self.NO_MRIVIEW, out)

    def test_idempotent(self):
        once, _ = add_help(self.NOHELP)
        twice, changed = add_help(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)


class BoundKeysTests(unittest.TestCase):
    def test_extracts_bound_keys(self):
        keys = bound_keys('x = [{key:"r"},{key:"L"},{key:"+"}]')
        self.assertEqual(keys, {"r", "L", "+"})

    def test_panel_always_includes_help_key(self):
        self.assertIn("toggle this help", build_panel("no bound keys here"))


if __name__ == "__main__":
    unittest.main()
