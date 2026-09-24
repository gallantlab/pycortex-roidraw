#!/usr/bin/env python
"""
stage_into_pycortex.py — stage the ROI/sulcus-drawing feature into a pycortex checkout, producing
exactly the working-tree changes the upstream incorporation PR would carry (the feature PR proposed
in gallantlab/pycortex#642).

    python upstream/stage_into_pycortex.py /path/to/pycortex

Four changes, modeled line-for-line on the pattern the guided-tour PR (gallantlab/pycortex#660)
uses for an optional webgl feature: a template block gated on a make_static flag.

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
  4. upstream/test_webgl_roidraw.py -> cortex/tests/  (mirrors the tour PR's test_webgl_tour.py).

The patch functions are pure string transforms. A file counts as already staged only when every one
of its insertions is present, so a second run changes nothing and says so. They FAIL LOUDLY rather
than stage a half-applied feature: when an anchor is missing or ambiguous (pycortex has drifted), or
when a file holds only some of the insertions or a `roidraw` that is not ours. stage() checks every
target directory and computes every patch before it writes anything. Unit-tested without pycortex
in test/test_upstream.py.

This script only ever writes inside the checkout you point it at — run it on a branch or a
scratch worktree, review `git diff`, and that diff is the PR.
"""
import argparse
import filecmp
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
# wording), so the anchor also carries the make_static-only layout entry that follows it. The
# insertion lands between the two, keeping docstring order = kwarg order (title, roidraw, layout).
DOCSTRING_TITLE = (
    "    title : str, optional\n"
    "        The title that is displayed on the viewer website when it is loaded in\n"
    "        a browser.\n"
)
DOCSTRING_LAYOUT = (
    "    layout : None or list of (int, int)\n"
    "        The layout of the viewer subwindows for showing multiple subjects, passed to\n"
    "        the template generator.\n"
    "        Default to None, corresponding to no subwindows.\n"
)
DOCSTRING_ANCHOR = DOCSTRING_TITLE + DOCSTRING_LAYOUT
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

# Each insertion as (text before it, the insertion, text after it, description). The anchor that
# must occur exactly once is before + after; the staged result is before + insertion + after.
TEMPLATE_INSERTIONS = (
    (TEMPLATE_ANCHOR, TEMPLATE_BLOCK, "", "template.html include block"),
)
VIEW_INSERTIONS = (
    (KWARG_ANCHOR, KWARG_LINE, "", "view.py make_static kwarg"),
    (DOCSTRING_TITLE, DOCSTRING_BLOCK, DOCSTRING_LAYOUT, "view.py docstring entry"),
    (GENERATE_ANCHOR, GENERATE_LINE, "", "view.py tpl.generate argument"),
)


def _insert_at(text, before, insertion, after, what):
    """Insert `insertion` between `before` and `after`, whose concatenation must occur exactly once
    in `text` (`after` is context that makes the match unique); fail loudly otherwise."""
    anchor = before + after
    n = text.count(anchor)
    if n != 1:
        raise SystemExit(
            "cannot stage %s: expected exactly 1 occurrence of the anchor, found %d.\n"
            "pycortex has drifted; update upstream/stage_into_pycortex.py.\n"
            "anchor:\n%s" % (what, n, anchor)
        )
    return text.replace(anchor, before + insertion + after, 1)


def _apply(text, insertions, name):
    """Return (new_text, changed). Unchanged only when every insertion is already in place; a file
    holding some of them, or a `roidraw` that none of them put there, is neither staged nor safe
    to patch, so it fails loudly."""
    present = [before + insertion + after in text for before, insertion, after, _ in insertions]
    if all(present):
        return text, False
    if any(present) or MARKER in text:
        missing = [what for (_, _, _, what), ok in zip(insertions, present) if not ok]
        raise SystemExit(
            "cannot stage %s: it is partly staged or already mentions %r, but these insertions are "
            "missing: %s.\nRestore the file (git checkout) and re-run."
            % (name, MARKER, ", ".join(missing))
        )
    for before, insertion, after, what in insertions:
        text = _insert_at(text, before, insertion, after, what)
    return text, True


def patch_template(html):
    """Return (new_html, changed): add the {% if roidraw %} include block."""
    return _apply(html, TEMPLATE_INSERTIONS, "template.html")


def patch_view(py):
    """Return (new_py, changed): add the make_static roidraw kwarg, docstring, and pass-through."""
    return _apply(py, VIEW_INSERTIONS, "view.py")


def stage(pycortex_dir):
    """Stage all four changes into the checkout. Returns the list of paths written."""
    webgl = os.path.join(pycortex_dir, "cortex", "webgl")
    js_dir = os.path.join(webgl, "resources", "js")
    tests_dir = os.path.join(pycortex_dir, "cortex", "tests")
    if not os.path.isfile(os.path.join(webgl, "template.html")):
        raise SystemExit("%s does not look like a pycortex checkout (no cortex/webgl/template.html)" % pycortex_dir)
    for d in (js_dir, tests_dir):
        if not os.path.isdir(d):
            raise SystemExit("%s does not look like a pycortex checkout (no %s)" % (pycortex_dir, d))
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
        if os.path.isfile(dst) and filecmp.cmp(src, dst, shallow=False):
            print("already staged: %s" % dst)
        else:
            shutil.copyfile(src, dst)
            written.append(dst)

    copy(BUNDLE, os.path.join(js_dir, "roidraw.js"))
    for path, new in patched:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new)
        written.append(path)
    copy(TEST_SRC, os.path.join(tests_dir, "test_webgl_roidraw.py"))
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
