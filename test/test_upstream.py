"""
Unit tests for upstream/stage_into_pycortex.py — the pure patch functions that produce the
pycortex incorporation PR's diff, plus the htmlembed-compatibility guards on the built bundle.

These run WITHOUT a pycortex checkout: the fixtures below carry the anchor lines of pycortex main
(cortex/webgl/template.html and view.py) verbatim, including the second copies of the docstring and
tpl.generate anchors that make_static's own must be told apart from. Drift in the real files is
caught separately, at stage time, by the script's loud missing-anchor failure.
"""
import ast
import os
import re
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "upstream"))
import stage_into_pycortex  # noqa: E402
from stage_into_pycortex import (  # noqa: E402
    BUNDLE, DOCSTRING_ANCHOR, KWARG_ANCHOR, KWARG_LINE, TEMPLATE_BLOCK, patch_template, patch_view, stage,
)

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

'''

# Another viewer function's twins of two anchors, as in the real view.py: the same title docstring entry (followed by something
# other than make_static's layout entry) and a multi-line generate call with `leapmotion=True,`
# (preceded by something other than `python_interface=False,`). Neither may be patched.
VIEW_TWIN = '''\
def show(data, title="Brain", layout=None):
    """
    title : str, optional
        The title that is displayed on the viewer website when it is loaded in
        a browser.
    open_browser : bool, optional
        Whether to open a browser window.
    """
    html = tpl.generate(
        data=json.dumps(metadata),
        leapmotion=True,
        layout=layout,
    )
'''

VIEW_FIXTURE += VIEW_TWIN


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

    def test_other_roidraw_mention_is_not_staged(self):
        # A `roidraw` that is not the full block is neither "already staged" nor safe to patch.
        with self.assertRaises(SystemExit):
            patch_template(TEMPLATE_FIXTURE + "<!-- roidraw -->\n")
        once, _ = patch_template(TEMPLATE_FIXTURE)
        self.assertIn(TEMPLATE_BLOCK, once)


class PatchViewTests(unittest.TestCase):
    def test_all_three_insertions(self):
        out, changed = patch_view(VIEW_FIXTURE)
        self.assertTrue(changed)
        self.assertIn('    title="Brain",\n    roidraw=False,\n', out)          # kwarg after title
        # docstring entry sits BETWEEN title and layout, matching the kwarg order
        self.assertLess(out.index("title : str"), out.index("roidraw : bool, optional"))
        self.assertLess(out.index("roidraw : bool, optional"), out.index("layout : None"))
        self.assertIn("        leapmotion=True,\n        roidraw=bool(roidraw),\n", out)  # generate arg
        self.assertEqual(out.count("roidraw=bool(roidraw)"), 1)  # only make_static's call
        self.assertEqual(out.count("roidraw : bool, optional"), 1)  # only make_static's docstring
        self.assertTrue(out.endswith(VIEW_TWIN))  # the mixer viewer's twins are byte-for-byte untouched
        ast.parse(out)  # still valid Python

    def test_fixture_reproduces_duplicate_anchors(self):
        # The fixture must carry the real file's twins, or the tests above prove nothing about them.
        title = "    title : str, optional\n"
        self.assertEqual(VIEW_FIXTURE.count(title), 2)
        self.assertEqual(VIEW_FIXTURE.count("    html = tpl.generate(\n"), 2)
        self.assertEqual(VIEW_FIXTURE.count("        leapmotion=True,\n"), 2)
        self.assertEqual(VIEW_FIXTURE.count(DOCSTRING_ANCHOR), 1)

    def test_docstring_anchor_text_unchanged(self):
        # The anchor is split into title + layout constants; its bytes must match pycortex exactly.
        self.assertEqual(DOCSTRING_ANCHOR, (
            "    title : str, optional\n"
            "        The title that is displayed on the viewer website when it is loaded in\n"
            "        a browser.\n"
            "    layout : None or list of (int, int)\n"
            "        The layout of the viewer subwindows for showing multiple subjects, passed to\n"
            "        the template generator.\n"
            "        Default to None, corresponding to no subwindows.\n"
        ))

    def test_partly_staged_fails_loudly(self):
        partial = VIEW_FIXTURE.replace(KWARG_ANCHOR, KWARG_ANCHOR + KWARG_LINE, 1)
        with self.assertRaises(SystemExit) as cm:
            patch_view(partial)
        self.assertIn("docstring", str(cm.exception))

    def test_foreign_roidraw_fails_loudly(self):
        with self.assertRaises(SystemExit):
            patch_view(VIEW_FIXTURE + "# roidraw lives elsewhere\n")

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

    def test_bundle_free_of_htmlembed_rewrite_patterns(self):
        if not os.path.isfile(BUNDLE):
            self.skipTest("%s not built (run `npm run build`)" % BUNDLE)
        with open(BUNDLE, encoding="utf-8") as f:
            js = f.read()
        self.assertIsNone(re.search(r"new Worker\(", js))
        self.assertIsNone(re.search(r"attr\(\s*['\"]src['\"]", js))


class StageTests(unittest.TestCase):
    """stage() against a throwaway fake checkout holding the fixtures."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = self.tmp.name
        self.checkout = os.path.join(root, "pycortex")
        self.webgl = os.path.join(self.checkout, "cortex", "webgl")
        self.tests = os.path.join(self.checkout, "cortex", "tests")
        os.makedirs(os.path.join(self.webgl, "resources", "js"))
        os.makedirs(self.tests)
        self._write(os.path.join(self.webgl, "template.html"), TEMPLATE_FIXTURE)
        self._write(os.path.join(self.webgl, "view.py"), VIEW_FIXTURE)
        bundle = os.path.join(root, "roidraw.bundle.js")
        self._write(bundle, "window.ROIDraw = {};\n")
        patcher = mock.patch.object(stage_into_pycortex, "BUNDLE", bundle)
        patcher.start()
        self.addCleanup(patcher.stop)
        quiet = mock.patch("builtins.print")
        quiet.start()
        self.addCleanup(quiet.stop)

    @staticmethod
    def _write(path, text):
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def _snapshot(self):
        out = {}
        for d, _, files in os.walk(self.checkout):
            for name in files:
                path = os.path.join(d, name)
                with open(path, encoding="utf-8") as f:
                    out[path] = f.read()
        return out

    def test_stages_then_rerun_is_noop(self):
        written = stage(self.checkout)
        self.assertEqual(len(written), 4)
        self.assertTrue(os.path.isfile(os.path.join(self.webgl, "resources", "js", "roidraw.js")))
        self.assertTrue(os.path.isfile(os.path.join(self.tests, "test_webgl_roidraw.py")))
        self.assertEqual(stage(self.checkout), [])

    def test_drift_writes_nothing(self):
        self._write(os.path.join(self.webgl, "view.py"), "def make_static(outpath):\n    pass\n")
        before = self._snapshot()
        with self.assertRaises(SystemExit):
            stage(self.checkout)
        self.assertEqual(self._snapshot(), before)

    def test_missing_tests_dir_writes_nothing(self):
        os.rmdir(self.tests)
        before = self._snapshot()
        with self.assertRaises(SystemExit) as cm:
            stage(self.checkout)
        self.assertIn("tests", str(cm.exception))
        self.assertEqual(self._snapshot(), before)


if __name__ == "__main__":
    unittest.main()
