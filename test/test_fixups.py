"""Unit tests for fixups (help-menu case + centering + font). Run: python3 test/test_fixups.py -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fixups import fix_help_key_case, center_help_menu, set_help_menu_font  # noqa: E402


class HelpKeyCaseTests(unittest.TestCase):
    SRC = ("new_html += modKeys.map((modKey) => modKey.substring(0, modKey.length - 3)) + "
           "list[i][name]['key'].toUpperCase() + '</td>';")

    def test_key_verbatim_and_modifier_capitalized(self):
        out, changed = fix_help_key_case(self.SRC)
        self.assertTrue(changed)
        self.assertNotIn("['key'].toUpperCase()", out)   # key no longer force-uppercased
        self.assertIn("list[i][name]['key']", out)
        self.assertIn("modKey.charAt(0).toUpperCase()", out)  # modifier "shift" -> "Shift"

    def test_idempotent(self):
        once, _ = fix_help_key_case(self.SRC)
        twice, changed = fix_help_key_case(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)


class HelpCenterTests(unittest.TestCase):
    RULE = "#helpmenu  {\n  top: 50%;\n  left: 0%;\n  transform: translate(0%, -50%);\n}"

    def test_centers_horizontally_scoped(self):
        out, changed = center_help_menu(self.RULE + "\n.other { left: 0%; }")
        self.assertTrue(changed)
        self.assertIn("left: 50%;", out)
        self.assertIn("translate(-50%, -50%)", out)
        self.assertIn(".other { left: 0%; }", out)   # other rules untouched (scoped to #helpmenu)

    def test_idempotent(self):
        once, _ = center_help_menu(self.RULE)
        twice, changed = center_help_menu(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)


class HelpFontTests(unittest.TestCase):
    RULE = "#helpmenu  {\n  font-size:12pt;\n  color:white;\n}"

    def test_adds_sans_serif_font_family(self):
        out, changed = set_help_menu_font(self.RULE)
        self.assertTrue(changed)
        self.assertIn("font-family:", out)
        self.assertIn("sans-serif", out)

    def test_scoped_and_preserves_existing_decls(self):
        out, _ = set_help_menu_font(self.RULE + "\n.other { color:red; }")
        self.assertIn(".other { color:red; }", out)   # other rules untouched (scoped to #helpmenu)
        self.assertIn("font-size:12pt;", out)         # original declarations preserved

    def test_leaves_existing_font_family(self):
        rule = "#helpmenu  {\n  font-family:Comic Sans;\n  color:white;\n}"
        out, changed = set_help_menu_font(rule)
        self.assertFalse(changed)                     # don't clobber an existing font-family
        self.assertEqual(rule, out)

    def test_idempotent(self):
        once, _ = set_help_menu_font(self.RULE)
        twice, changed = set_help_menu_font(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)


if __name__ == "__main__":
    unittest.main()
