"""
Unit tests for upstream/stage_into_pycortex.py — the pure patch functions that produce the
pycortex incorporation PR's diff, plus the htmlembed-compatibility guards on the built bundle.

These run WITHOUT a pycortex checkout: the fixtures below are verbatim copies of the anchor
regions in pycortex main (cortex/webgl/template.html and view.py). Drift in the real files is
caught separately, at stage time, by the script's loud missing-anchor failure.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "upstream"))
from stage_into_pycortex import patch_template, patch_view  # noqa: E402

TEMPLATE_FIXTURE = """\
{% if leapmotion %}
<script type='text/javascript' src="resources/js/leap-0.6.4.js"></script>
<script type='text/javascript' src='resources/js/leap.js'></script>
{% end %}

{% if python_interface %}
<script type='text/javascript' src='resources/js/python_interface.js'></script>
{% end %}
{% block javascripts %}
{% end %}
"""

VIEW_FIXTURE = '''\
def make_static(
    outpath,
    data,
    html_embed=True,
    copy_ctmfiles=True,
    title="Brain",
    layout=None,
):
    """
    title : str, optional
        The title that is displayed on the viewer website when it is loaded in
        a browser.
    layout : None or list of (int, int)
        The layout of the viewer subwindows for showing multiple subjects, passed to
        the template generator.
        Default to None, corresponding to no subwindows.
    """
    html = tpl.generate(
        data=json.dumps(metadata),
        python_interface=False,
        leapmotion=True,
        layout=layout,
    )
    other = tpl.generate(leapmotion=True, layout=None)  # the dynamic viewer's call — must NOT be patched

'''


class PatchTemplateTests(unittest.TestCase):
    def test_inserts_block_after_python_interface(self):
        out, changed = patch_template(TEMPLATE_FIXTURE)
        self.assertTrue(changed)
        self.assertIn("{% if roidraw %}", out)
        self.assertIn('src="resources/js/roidraw.js"', out)
        self.assertIn("window.ROIDraw.autoAttach();", out)
        # placed between the python_interface block and {% block javascripts %}
        self.assertLess(out.index("python_interface.js"), out.index("roidraw.js"))
        self.assertLess(out.index("roidraw.js"), out.index("{% block javascripts %}"))

    def test_idempotent(self):
        once, _ = patch_template(TEMPLATE_FIXTURE)
        twice, changed = patch_template(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)

    def test_fails_loudly_on_drift(self):
        with self.assertRaises(SystemExit) as cm:
            patch_template("<html>a template with no anchor</html>")
        self.assertIn("anchor", str(cm.exception))


class PatchViewTests(unittest.TestCase):
    def test_all_three_insertions(self):
        out, changed = patch_view(VIEW_FIXTURE)
        self.assertTrue(changed)
        self.assertIn('    title="Brain",\n    roidraw=False,\n', out)          # kwarg after title
        # docstring entry sits BETWEEN title and layout, matching the kwarg order
        self.assertLess(out.index("title : str"), out.index("roidraw : bool, optional"))
        self.assertLess(out.index("roidraw : bool, optional"), out.index("layout : None"))
        self.assertIn("        leapmotion=True,\n        roidraw=bool(roidraw),\n", out)  # generate arg
        self.assertEqual(out.count("roidraw=bool(roidraw)"), 1)  # only make_static's call, not the dynamic viewer's
        # still valid Python
        import ast
        ast.parse(out)

    def test_idempotent(self):
        once, _ = patch_view(VIEW_FIXTURE)
        twice, changed = patch_view(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)

    def test_fails_loudly_on_drift(self):
        with self.assertRaises(SystemExit):
            patch_view("def make_static(outpath):\n    pass\n")


class BundleEmbedSafetyTests(unittest.TestCase):
    """cortex/webgl/htmlembed.py regex-rewrites every embedded script: `new Worker(...)` and
    `attr('src', ...)` are treated as resource references and replaced. The bundle must never
    contain either pattern, or html_embed would corrupt it. (Its CSS rides inside the JS for the
    same family of reason: _embed_css cannot parse nested at-rule braces.)"""

    BUNDLE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dist", "roidraw.bundle.js")

    def test_bundle_free_of_htmlembed_rewrite_patterns(self):
        import re
        with open(self.BUNDLE, encoding="utf-8") as f:
            js = f.read()
        self.assertIsNone(re.search(r"new Worker\(", js))
        self.assertIsNone(re.search(r"attr\(\s*['\"]src['\"]", js))


if __name__ == "__main__":
    unittest.main()
