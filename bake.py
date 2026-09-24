#!/usr/bin/env python
"""
bake.py — add ROI-drawing capability to a pycortex static viewer, in place.

    python bake.py <viewer_dir> [--html NAME]

Copies dist/roidraw.bundle.js into <viewer_dir> and injects two <script> tags into the viewer's
HTML so the drawing tool loads and attaches itself. The HTML is --html if given, else index.html
(what pycortex's make_static writes), else viewer.html. The viewer's own assets (surface, data,
overlays) are left untouched. This is the ENTIRE integration for a static viewer — the same
bundle + the same two tags enable ROI drawing in any pycortex viewer.

The injection is idempotent and tolerant of how the HTML closes: it inserts before the last
</body>, or the last </html>, or (for pycortex's make_static fragments, which have neither)
appends to the end. The last occurrence, because an inlined script can contain either literal.
Pure injection logic lives in `inject()` and is unit-tested in test/test_bake.py.
"""
import argparse
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLE_NAME = "roidraw.bundle.js"
BUNDLE = os.path.join(HERE, "dist", BUNDLE_NAME)
HTML_CANDIDATES = ("index.html", "viewer.html")  # tried in order when no --html is given

MARKER = BUNDLE_NAME
SNIPPET = (
    "\n<!-- pycortex-roidraw: ROI drawing baked in -->"
    '\n<script src="' + BUNDLE_NAME + '"></script>'
    "\n<script>window.ROIDraw.autoAttach();</script>\n"
)


def inject(html, snippet=SNIPPET, marker=MARKER):
    """
    Return (new_html, changed). Inserts `snippet` before the document's last </body>, falling back
    to the last </html> and then to appending. Idempotent: if `marker` is already present, returns
    the html unchanged with changed=False.
    """
    if marker in html:
        return html, False
    for close in ("</body>", "</html>"):
        i = html.rfind(close)
        if i != -1:
            return html[:i] + snippet + html[i:], True
    return html + snippet, True


def find_html(viewer_dir, html_name=None):
    """Return the viewer HTML's file name: `html_name` if given, else the first of HTML_CANDIDATES
    present in viewer_dir. Raises SystemExit if there is none."""
    names = (html_name,) if html_name else HTML_CANDIDATES
    for name in names:
        if os.path.isfile(os.path.join(viewer_dir, name)):
            return name
    raise SystemExit("no %s in %s" % (" or ".join(names), viewer_dir))


def bake(viewer_dir, html_name=None):
    """Copy the bundle into viewer_dir and inject the script tags into its HTML, in place.
    Returns (html_path, changed)."""
    if not os.path.isfile(BUNDLE):
        raise SystemExit("missing %s — run `npm run build` first" % BUNDLE)
    html_path = os.path.join(viewer_dir, find_html(viewer_dir, html_name))

    shutil.copy2(BUNDLE, os.path.join(viewer_dir, BUNDLE_NAME))
    with open(html_path, encoding="utf-8") as f:
        html = f.read()
    new_html, changed = inject(html)
    if changed:
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(new_html)
    return html_path, changed


def main():
    ap = argparse.ArgumentParser(description="Add ROI drawing to a pycortex static viewer (in place).")
    ap.add_argument("viewer_dir", help="the static viewer directory to modify in place")
    ap.add_argument("--html", help="viewer HTML file to inject into (default: index.html, else viewer.html)")
    args = ap.parse_args()
    where, changed = bake(args.viewer_dir, args.html)
    if changed:
        print("Injected ROI drawing into %s" % where)
    else:
        print("Refreshed %s; the script tags were already present in %s" % (BUNDLE_NAME, where))


if __name__ == "__main__":
    main()
