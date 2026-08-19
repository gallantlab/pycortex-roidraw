#!/usr/bin/env python
"""
stage_into_pycortex.py — stage the ROI/sulcus-drawing feature into a pycortex checkout, producing
exactly the working-tree changes the upstream incorporation PR would carry (the feature PR proposed
in gallantlab/pycortex#642).

    python upstream/stage_into_pycortex.py /path/to/pycortex

Four changes, modeled line-for-line on the merged precedent for optional webgl features (the
guided-tour PR, gallantlab/pycortex#660: a template block gated on a make_static flag):

  1. dist/roidraw.bundle.js  ->  cortex/webgl/resources/js/roidraw.js
     One self-contained file, deliberately: the CSS ships inside it because
     cortex/webgl/htmlembed.py's `_embed_css` parses stylesheets with a non-nesting brace regex
     (`(.*?){([^}]+)}`), so a separate roidraw.css could be silently mangled the moment it grew a
     nested at-rule. The bundle is also free of the two patterns `_embed_js` rewrites in every
     embedded script (`new Worker(...)` and `attr('src', ...)`) — checked by this repo's tests.
  2. cortex/webgl/template.html: a `{% if roidraw %}` block (script tag + the same one-line
     `window.ROIDraw.autoAttach()` bootstrap bake.py injects), placed with the other optional
     feature blocks. `autoAttach` polls for the viewer, so it needs no load-order care.
  3. cortex/webgl/view.py: `make_static(..., roidraw=False)` — kwarg, docstring entry, and the
     flag passed to the template renderer (Tornado raises on an undefined name, so it must
     always be passed once the template references it).
  4. upstream/test_webgl_roidraw.py -> cortex/tests/  (mirrors cortex/tests/test_webgl_tour.py).

The patch functions are pure string transforms: idempotent (a second run changes nothing and says
so), and they FAIL LOUDLY naming the missing anchor if pycortex has drifted, rather than staging a
half-applied feature. Unit-tested without pycortex in test/test_upstream.py.

This script only ever writes inside the checkout you point it at — run it on a branch or a
scratch worktree, review `git diff`, and that diff is the PR.
"""
import argparse
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUNDLE = os.path.join(ROOT, "dist", "roidraw.bundle.js")
TEST_SRC = os.path.join(HERE, "test_webgl_roidraw.py")

MARKER = "roidraw"

# The template block. House style: single-quoted type attribute, double-quoted src, the block kept
# beside the other optional-feature blocks (leapmotion / python_interface).
TEMPLATE_ANCHOR = (
    "{% if python_interface %}\n"
    "<script type='text/javascript' src='resources/js/python_interface.js'></script>\n"
    "{% end %}\n"
)
TEMPLATE_BLOCK = (
    "\n{% if roidraw %}\n"
    "<script type='text/javascript' src=\"resources/js/roidraw.js\"></script>\n"
    "<script type='text/javascript'>window.ROIDraw.autoAttach();</script>\n"
    "{% end %}\n"
)

# view.py: the three insertions, each tied to a stable anchor line.
KWARG_ANCHOR = '    title="Brain",\n'
KWARG_LINE = "    roidraw=False,\n"

# The bare title block appears twice in view.py (make_static and the mixer viewer share the
# wording), so the anchor carries the make_static-only line that follows it; the insertion lands
# between the two, keeping docstring order = kwarg order (title, roidraw, layout).
DOCSTRING_ANCHOR = (
    "    title : str, optional\n"
    "        The title that is displayed on the viewer website when it is loaded in\n"
    "        a browser.\n"
    "    layout : None or list of (int, int)\n"
    "        The layout of the viewer subwindows for showing multiple subjects, passed to\n"
    "        the template generator.\n"
    "        Default to None, corresponding to no subwindows.\n"
)
DOCSTRING_BLOCK = (
    "    roidraw : bool, optional\n"
    "        If True, bake in the in-browser ROI + sulcus drawing tool (draw on the\n"
    "        flatmap, edit the fitted bezier, export a vertex-set JSON / an\n"
    "        overlays.svg sulci layer). See docs/roidraw.rst. Default False.\n"
)

# `leapmotion=True,` alone appears in two generate calls (make_static and the dynamic viewer's),
# so the anchor carries make_static's preceding line too.
GENERATE_ANCHOR = (
    "        python_interface=False,\n"
    "        leapmotion=True,\n"
)
GENERATE_LINE = "        roidraw=bool(roidraw),\n"


def _insert_at(text, anchor, insertion, what, keep_lines=None):
    """Insert `insertion` relative to the unique `anchor`, failing loudly otherwise. By default the
    insertion goes after the whole anchor; with `keep_lines` = n, only the anchor's first n lines
    stay before it (the rest of the anchor is context that makes the match unique)."""
    n = text.count(anchor)
    if n != 1:
        raise SystemExit(
            "cannot stage %s: expected exactly 1 occurrence of the anchor, found %d.\n"
            "pycortex has drifted; update upstream/stage_into_pycortex.py.\n"
            "anchor:\n%s" % (what, n, anchor)
        )
    if keep_lines is None:
        return text.replace(anchor, anchor + insertion, 1)
    lines = anchor.splitlines(keepends=True)
    head, tail = "".join(lines[:keep_lines]), "".join(lines[keep_lines:])
    return text.replace(anchor, head + insertion + tail, 1)


def patch_template(html):
    """Return (new_html, changed): add the {% if roidraw %} include block."""
    if MARKER in html:
        return html, False
    return _insert_at(html, TEMPLATE_ANCHOR, TEMPLATE_BLOCK, "template.html include block"), True


def patch_view(py):
    """Return (new_py, changed): add the make_static roidraw kwarg, docstring, and pass-through."""
    if MARKER in py:
        return py, False
    py = _insert_at(py, KWARG_ANCHOR, KWARG_LINE, "view.py make_static kwarg")
    py = _insert_at(py, DOCSTRING_ANCHOR, DOCSTRING_BLOCK, "view.py docstring entry", keep_lines=3)
    py = _insert_at(py, GENERATE_ANCHOR, GENERATE_LINE, "view.py tpl.generate argument")
    return py, True


def stage(pycortex_dir):
    """Stage all four changes into the checkout. Returns the list of paths written."""
    webgl = os.path.join(pycortex_dir, "cortex", "webgl")
    if not os.path.isfile(os.path.join(webgl, "template.html")):
        raise SystemExit("%s does not look like a pycortex checkout (no cortex/webgl/template.html)" % pycortex_dir)
    if not os.path.isfile(BUNDLE):
        raise SystemExit("missing %s — run `npm run build` first" % BUNDLE)

    # Compute every patch BEFORE writing anything, so a missing anchor (pycortex drifted) leaves
    # the checkout untouched instead of half-staged.
    patched = []
    for name, patch in (("template.html", patch_template), ("view.py", patch_view)):
        path = os.path.join(webgl, name)
        with open(path, encoding="utf-8") as f:
            new, changed = patch(f.read())
        if changed:
            patched.append((path, new))
        else:
            print("already staged: %s" % path)

    written = []

    def copy(src, dst):
        """Copy unless the destination already has identical content (keeps reruns no-ops)."""
        if os.path.isfile(dst) and open(dst, "rb").read() == open(src, "rb").read():
            print("already staged: %s" % dst)
        else:
            shutil.copyfile(src, dst)
            written.append(dst)

    copy(BUNDLE, os.path.join(webgl, "resources", "js", "roidraw.js"))
    for path, new in patched:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new)
        written.append(path)
    copy(TEST_SRC, os.path.join(pycortex_dir, "cortex", "tests", "test_webgl_roidraw.py"))
    return written


def main():
    ap = argparse.ArgumentParser(description="Stage the ROI-drawing feature into a pycortex checkout (the upstream PR's diff).")
    ap.add_argument("pycortex_dir", help="path to a pycortex checkout (use a branch/worktree; review with git diff)")
    args = ap.parse_args()
    for path in stage(os.path.abspath(args.pycortex_dir)):
        print("wrote %s" % path)
    print("Review with `git diff` in the checkout — that diff is the PR.")


if __name__ == "__main__":
    main()
