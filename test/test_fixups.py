"""Unit tests for fixups (help-menu case + centering + font + hint). Run: python3 test/test_fixups.py -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fixups import (  # noqa: E402
    fix_help_key_case, center_help_menu, set_help_menu_font, add_help_hint, fix_wheel_zoom,
)


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

    def test_centers_topleft_variant_and_leaves_transition(self):
        rule = "#helpmenu  {\n  top: 10px;\n  left: 10px;\n  transform: none;\n  transition: all .3s;\n}"
        out, changed = center_help_menu(rule)
        self.assertTrue(changed)
        self.assertIn("top: 50%;", out)
        self.assertIn("left: 50%;", out)
        self.assertIn("transform: translate(-50%, -50%);", out)
        self.assertIn("transition: all .3s;", out)   # transition left untouched (only transform)

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


class HelpHintTests(unittest.TestCase):
    TEMPLATE = ('<script type="text/html" id=mriview_html><div id="main">'
                '<div id="braincontainer"></div></div></script>'
                '<script>var helpmenu = function(){};</script>')
    NO_HELP = "<div>a viewer with no help menu</div>"

    def test_inserts_into_main_template(self):
        out, changed = add_help_hint(self.TEMPLATE)
        self.assertTrue(changed)
        self.assertIn("press <b>h</b> for help", out)
        # placed right after the template's #main open -> built as part of the viewer's own DOM
        self.assertTrue(out.find('<div id="main">') < out.find("pycortex-helphint") < out.find('id="braincontainer"'))

    def test_skips_when_no_help(self):
        out, changed = add_help_hint(self.NO_HELP)
        self.assertFalse(changed)                 # never advertise help a viewer doesn't have
        self.assertEqual(self.NO_HELP, out)

    def test_appends_when_no_main_template(self):
        out, changed = add_help_hint("<script>var helpmenu = function(){};</script>")
        self.assertTrue(changed)                  # help present but no #main template -> fallback append
        self.assertIn("pycortex-helphint", out)

    def test_idempotent(self):
        once, _ = add_help_hint(self.TEMPLATE)
        twice, changed = add_help_hint(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)


class WheelZoomTests(unittest.TestCase):
    # lescroart-style: !altKey guard, event.wheelDelta * 50.0
    LESCROART = ("function mousewheel( event ) {\n if (!event.altKey) {\n"
                 "  this.setRadius(this.radius + this.zoomSpeed * -1 * event.wheelDelta * 50.0);\n"
                 "  this.dispatchEvent( changeEvent );\n }\n};\n"
                 "object.addEventListener( 'mousewheel', mousewheel.bind(this), false);")
    # huth-style: state guard that blocks plain scroll, wrong var name, multiplicative wheelDelta/10
    HUTH = ("function mousewheel( event ) {\n event.preventDefault();\n"
            " if ( this._state !== STATE.NONE ) {\n"
            "  this.setRadius(this.radius * this.zoomSpeed * -1 * wheelEvent.wheelDelta/10.0);\n"
            "  this.dispatchEvent( changeEvent );\n }\n};\n"
            "object.addEventListener( 'mousewheel', mousewheel.bind(this), false);")

    def _assert_fixed(self, src):
        out, changed = fix_wheel_zoom(src)
        self.assertTrue(changed)
        self.assertNotIn("wheelDelta", out)                     # broken delta prop gone
        self.assertIn("event.deltaY", out)                      # standard prop
        self.assertIn("firefox", out)                           # Firefox normalization
        self.assertIn("'wheel', mousewheel.bind(this)", out)    # standard event
        self.assertNotIn("'mousewheel', mousewheel.bind", out)
        self.assertNotIn("_state !== STATE.NONE", out)          # state guard removed (huth)
        return out

    def test_fixes_lescroart_variant(self):
        self._assert_fixed(self.LESCROART)

    def test_fixes_huth_variant(self):
        self._assert_fixed(self.HUTH)

    # retinotopy-style: handler delegates to a separate multiplicative wheelzoom(wheelEvent) method
    RETINOTOPY = ("function mousewheel( event ) { this.wheelzoom( event ); this.setCamera(); };\n"
                  "var c = { wheelzoom: function( wheelEvent ) {\n"
                  "  var factor = 1.0 + this.zoomSpeed * -1 * wheelEvent.wheelDelta/10.0;\n"
                  "  this.radius *= factor;\n} };\n"
                  "this.domElement.addEventListener( 'mousewheel', mousewheel.bind(this), false);")

    def test_fixes_retinotopy_wheelzoom_variant(self):
        out, changed = fix_wheel_zoom(self.RETINOTOPY)
        self.assertTrue(changed)
        self.assertNotIn("wheelDelta", out)                  # broken prop gone
        self.assertIn("wheelEvent.deltaY", out)              # standard prop in wheelzoom
        self.assertIn("firefox", out)                        # Firefox normalization
        self.assertIn("this.radius *= factor", out)          # multiplicative structure preserved
        self.assertIn("'wheel', mousewheel.bind(this)", out) # standard event
        self.assertNotIn("'mousewheel', mousewheel.bind", out)
        # idempotent
        twice, c2 = fix_wheel_zoom(out)
        self.assertFalse(c2)

    def test_idempotent(self):
        once = self._assert_fixed(self.HUTH)
        twice, changed = fix_wheel_zoom(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)

    def test_noop_on_already_fixed(self):
        modern = ("function mousewheel( event ) { var delta = event.deltaY; "
                  "this.setRadius(this.radius + this.zoomSpeed * delta * 110.0); }; "
                  "object.addEventListener( 'wheel', mousewheel.bind(this), false);")
        out, changed = fix_wheel_zoom(modern)
        self.assertFalse(changed)
        self.assertEqual(modern, out)


if __name__ == "__main__":
    unittest.main()
