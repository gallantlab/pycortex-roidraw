"""Unit tests for convert_huth (block extraction + tour modernization + lsaplot strip).
Run: python3 test/test_convert_huth.py -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import convert_huth as ch  # noqa: E402


class StripLsaplotTests(unittest.TestCase):
    def test_removes_dead_script_tag(self):
        s = 'A<script type="text/javascript" src="lsaplot.js"></script>B'
        self.assertEqual(ch.strip_lsaplot(s), "AB")

    def test_unquoted_and_other_attrs(self):
        s = "A<script src='lsaplot.js' defer></script>B"
        self.assertEqual(ch.strip_lsaplot(s), "AB")

    def test_leaves_other_scripts(self):
        s = '<script src="three.js"></script>'
        self.assertEqual(ch.strip_lsaplot(s), s)


class FindTemplateTagTests(unittest.TestCase):
    def test_finds_quoted_and_unquoted_and_skips_js_refs(self):
        html = ("var x = $('#mriview_html').html();"           # JS reference (must be skipped)
                "<script type='text/html' id='mriview_html'>BODY</script>")
        i = ch.find_template_tag(html, "mriview_html")
        self.assertTrue(html[i:].startswith("<script"))
        self.assertIn("id='mriview_html'", html[i:i + 60])

    def test_unquoted_id(self):
        html = "<script type=text/html id=tourbox>X</script>"
        i = ch.find_template_tag(html, "tourbox")
        self.assertEqual(i, 0)


class OnloadRoundTripTests(unittest.TestCase):
    SHELL = (
        # decoy: a bare "texture units" inside an inlined library (as in three.js) with its own
        # else{} — must NOT be mistaken for the validator/onload boundary.
        "if (n > max) { warn('using ' + n + ' texture units'); } else { fallback(); }\n"
        "} else if (!validator.vtex(3, 5)) {\n"
        '  $("#ctmload").html("...minimum number of texture units :(...").show();\n'
        "} else {\n"
        "    VANILLA_ONLOAD; if (a) { b } else { c }\n"
        "}\n});\n</script>\n"
    )

    def test_extract_then_replace(self):
        onload = ch.extract_onload_block(self.SHELL)
        self.assertIn("VANILLA_ONLOAD", onload)
        self.assertIn("if (a) { b } else { c }", onload)   # nested else preserved
        out = ch.replace_onload_block(self.SHELL, "HUTH_ONLOAD_CODE")
        self.assertIn("HUTH_ONLOAD_CODE", out)
        self.assertNotIn("VANILLA_ONLOAD", out)
        self.assertIn("});", out)                            # ready() still closed
        self.assertTrue(out.rstrip().endswith("</script>"))  # bottom script intact


class ReplaceJavascriptsBlockTests(unittest.TestCase):
    SHELL = (
        "<script>LIB</script>}(mriview || {}));</script>\n"
        "STORIES_CUSTOM_JS\n"
        "<script type='text/html' id='mriview_html'>TEMPLATE</script>\n"
    )

    def test_swaps_custom_block_keeps_libs_and_template(self):
        out = ch.replace_javascripts_block(self.SHELL, "HUTH_CUSTOM_JS")
        self.assertIn("}(mriview || {}));", out)        # library kept
        self.assertIn("HUTH_CUSTOM_JS", out)            # huth block injected
        self.assertNotIn("STORIES_CUSTOM_JS", out)      # stories' custom block removed
        self.assertIn("id='mriview_html'", out)         # template kept


class MergeViewoptsTests(unittest.TestCase):
    def test_fills_missing_keys_keeps_huth_values(self):
        onload = 'viewopts = {"specularity": "1.0", "labels_visible": []};\nmore();'
        ref = {"brightness": 0.5, "contrast": 0.1, "specularity": 0}
        out = ch.merge_viewopts(onload, ref)
        import json, re
        vo = json.loads(re.search(r'viewopts = (\{.*?\});', out).group(1))
        self.assertEqual(vo["brightness"], 0.5)          # filled from reference
        self.assertEqual(vo["contrast"], 0.1)            # filled from reference
        self.assertEqual(vo["specularity"], "1.0")       # huth's own value preserved (not 0)
        self.assertEqual(vo["labels_visible"], [])       # huth-only key kept
        self.assertIn("more();", out)                    # rest of onload untouched

    def test_force_overrides_huth_value(self):
        onload = 'viewopts = {"specularity": "1.0"};'
        out = ch.merge_viewopts(onload, {"brightness": 0.5}, force={"specularity": 0})
        import json, re
        vo = json.loads(re.search(r'viewopts = (\{.*?\});', out).group(1))
        self.assertEqual(vo["specularity"], 0)           # force beats huth's "1.0"
        self.assertEqual(vo["brightness"], 0.5)

    def test_inject_css_before_head(self):
        html = "<head><title>x</title></head><body>b</body>"
        out = ch.inject_css(html, "#figure_ui{right:0;}")
        self.assertIn("<style>#figure_ui{right:0;}</style>", out)
        self.assertLess(out.index("<style>"), out.index("</head>"))


class ModernizeTourTests(unittest.TestCase):
    HUTH_JS = (
        "<style>\ndiv.tour-stepper{a:1}\ndiv.tour-close{x:1}\n</style>\n"
        "<script type=text/html id=tourbox>OLD_BACK_NEXT_CLOSE</script>\n"
        "var tour_anim_speed=2;\nvar tour_content=[{title:'keep me'}];\n"
        "Tour = function(content){ OLD_TOUR }\n"
        "Tour.prototype.goto_step = function(){ OLD }\n</script>\n"
    )
    STORIES_JS = (
        "<style>\ndiv.tour-stepper{a:2}\ndiv.tour-hideshow{y:1}\n</style>\n"
        "<script type=\"text/html\" id=tourbox>MODERN_HIDESHOW</script>\n"
        "Tour = function(content){ MODERN_TOUR; this.hidden=false; }\n"
        "Tour.prototype.showhide = function(){ NEW }\n</script>\n"
    )

    def test_swaps_three_pieces_keeps_tour_content(self):
        out = ch.modernize_tour(self.HUTH_JS, self.STORIES_JS)
        # tour_content (huth) preserved
        self.assertIn("var tour_content=[{title:'keep me'}]", out)
        self.assertIn("var tour_anim_speed=2", out)
        # modern tourbox + Tour class + CSS swapped in
        self.assertIn("MODERN_HIDESHOW", out)
        self.assertIn("this.hidden=false", out)
        self.assertIn("Tour.prototype.showhide", out)
        self.assertIn("div.tour-hideshow", out)
        # old tour machinery gone
        self.assertNotIn("OLD_BACK_NEXT_CLOSE", out)
        self.assertNotIn("OLD_TOUR", out)
        self.assertNotIn("div.tour-close", out)


class RestoreSurfaceCenteringTests(unittest.TestCase):
    def test_uncomments_main_line(self):
        js = "this.center = center;\n//this.object.position.set(0, -center[1], -center[2]);\nvar n=1;"
        out, changed = ch.restore_surface_centering(js)
        self.assertTrue(changed)
        self.assertIn("\nthis.object.position.set(0, -center[1], -center[2]);\n", out)
        self.assertNotIn("//this.object.position.set", out)

    def test_tolerates_whitespace_after_slashes(self):
        js = "//  this.object.position.set(0,  -center[1],  -center[2]);"
        out, changed = ch.restore_surface_centering(js)
        self.assertTrue(changed)
        self.assertFalse(out.lstrip().startswith("//"))

    def test_idempotent_when_already_active(self):
        js = "this.object.position.set(0, -center[1], -center[2]);"
        out, changed = ch.restore_surface_centering(js)
        self.assertFalse(changed)
        self.assertEqual(out, js)

    def test_noop_when_absent(self):
        js = "var unrelated = 1;"
        out, changed = ch.restore_surface_centering(js)
        self.assertFalse(changed)
        self.assertEqual(out, js)


if __name__ == "__main__":
    unittest.main()
