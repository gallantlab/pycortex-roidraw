"""Unit tests for reengine (extract pycortex static-viewer template vars + colormaps).
Run: python3 test/test_reengine.py -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reengine import (  # noqa: E402
    extract_balanced, extract_template_vars, build_colormaps,
)


class ExtractBalancedTests(unittest.TestCase):
    def test_simple_braces(self):
        s = 'x = {"a": 1};'
        self.assertEqual(extract_balanced(s, s.index('{')), '{"a": 1}')

    def test_nested(self):
        s = 'q({"a": {"b": [1,2]}, "c": 3})end'
        self.assertEqual(extract_balanced(s, s.index('(')), '({"a": {"b": [1,2]}, "c": 3})')

    def test_braces_inside_strings_ignored(self):
        # close-brace inside a JSON string must NOT end the match
        s = '{"label": "a}b{c", "n": 2}TAIL'
        self.assertEqual(extract_balanced(s, 0), '{"label": "a}b{c", "n": 2}')

    def test_escaped_quote_inside_string(self):
        s = r'{"t": "she said \"hi}\" ok", "n": 1}TAIL'
        self.assertEqual(extract_balanced(s, 0), r'{"t": "she said \"hi}\" ok", "n": 1}')

    def test_unbalanced_raises(self):
        with self.assertRaises(ValueError):
            extract_balanced('{"a": 1', 0)


class ExtractTemplateVarsTests(unittest.TestCase):
    # Mimics a built static viewer.html: a decoy engine-internal `subjects = {}` far above,
    # then the onload block with the real template-injected values.
    SAMPLE = (
        "function init(){ subjects = {}, snames = [], view, subj; /* engine decoy */ }\n"
        + "x" * 5000 + "\n"
        "viewopts = {\"labels_visible\": [], \"specularity\": 1.0, \"brightness\": 0.5};\n"
        "subjects = {\"MLfs2\": \"MLfs2_[inflated]_mg2_9_v3.json\"};\n"
        "for (var name in subjects) { subjects[name] = new mriview.Surface(subjects[name]); }\n"
        "dataviews = dataset.fromJSON({\"images\": {\"__abc\": [\"data/__abc_0.png\"]}, "
        "\"views\": [{\"name\": \"selectivity\", \"cmap\": [\"RdBu_r\"]}]});\n"
        "viewer.addData(dataviews);\n"
    )

    def setUp(self):
        self.v = extract_template_vars(self.SAMPLE)

    def test_subjects_is_the_real_one_not_decoy(self):
        self.assertEqual(self.v["subjects"],
                         '{"MLfs2": "MLfs2_[inflated]_mg2_9_v3.json"}')

    def test_viewopts_extracted(self):
        self.assertIn('"specularity": 1.0', self.v["viewopts"])
        self.assertTrue(self.v["viewopts"].startswith("{"))
        self.assertTrue(self.v["viewopts"].endswith("}"))

    def test_data_is_inner_json_without_outer_parens(self):
        self.assertTrue(self.v["data"].startswith("{"))
        self.assertTrue(self.v["data"].endswith("}"))
        self.assertIn('"selectivity"', self.v["data"])
        self.assertNotIn("dataset.fromJSON", self.v["data"])

    def test_extracted_values_are_valid_json(self):
        import json
        for k in ("data", "subjects", "viewopts"):
            json.loads(self.v[k])  # must not raise

    def test_leapmotion_detected(self):
        with_leap = self.SAMPLE + "<script src='resources/js/leap-0.6.4.js'></script>"
        self.assertTrue(extract_template_vars(with_leap)["leapmotion"])
        self.assertFalse(extract_template_vars(self.SAMPLE)["leapmotion"])

    def test_missing_dataviews_raises(self):
        with self.assertRaises(ValueError):
            extract_template_vars("no dataviews here")


class BuildColormapsTests(unittest.TestCase):
    def test_builds_name_datauri_pairs(self):
        # Use the real pycortex colormaps dir if available via env, else skip.
        cmapdir = os.environ.get("PYCORTEX_COLORMAPS")
        if not cmapdir or not os.path.isdir(cmapdir):
            self.skipTest("PYCORTEX_COLORMAPS not set to a colormaps dir")
        cmaps = build_colormaps(cmapdir)
        self.assertTrue(len(cmaps) > 50)
        names = [n for n, _ in cmaps]
        self.assertIn("RdBu_r", names)
        for _, uri in cmaps:
            self.assertTrue(uri.startswith("data:image/png;base64,"))
        self.assertEqual(names, sorted(names))  # deterministic order


if __name__ == "__main__":
    unittest.main()
