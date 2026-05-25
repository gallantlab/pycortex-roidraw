#!/usr/bin/env python
"""
bake.py — add ROI-drawing capability to a pycortex static viewer, in place.

    python bake.py <viewer_dir> [--html viewer.html]

Copies dist/roidraw.bundle.js into <viewer_dir> and injects two <script> tags into the viewer's
HTML so the drawing tool loads and attaches itself. The viewer's own assets (surface, data,
overlays) are left untouched. This is the ENTIRE integration for a static viewer — the same
bundle + the same two tags enable ROI drawing in any pycortex viewer.

The injection is idempotent and tolerant of how the HTML closes: it inserts before </body>, or
</html>, or (for pycortex's make_static fragments, which have neither) appends to the end.
Pure injection logic lives in `inject()` and is unit-tested in test/test_bake.py.
"""
import argparse
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLE = os.path.join(HERE, "dist", "roidraw.bundle.js")

MARKER = "roidraw.bundle.js"
SNIPPET = (
    "\n<!-- pycortex-roidraw: ROI drawing baked in -->"
    '\n<script src="roidraw.bundle.js"></script>'
    "\n<script>window.ROIDraw.autoAttach();</script>\n"
)


def inject(html, snippet=SNIPPET, marker=MARKER):
    """
    Return (new_html, changed). Inserts `snippet` before the document's closing tag, falling back
    to </html> and then to appending. Idempotent: if `marker` is already present, returns the html
    unchanged with changed=False.
    """
    if marker in html:
        return html, False
    for close in ("</body>", "</html>"):
        if close in html:
            return html.replace(close, snippet + close, 1), True
    return html + snippet, True


def bake(viewer_dir, html_name="viewer.html"):
    """Copy the bundle into viewer_dir and inject the script tags into its HTML, in place."""
    if not os.path.isfile(BUNDLE):
        raise SystemExit("missing %s — run `npm run build` first" % BUNDLE)
    html_path = os.path.join(viewer_dir, html_name)
    if not os.path.isfile(html_path):
        raise SystemExit("no %s in %s" % (html_name, viewer_dir))

    shutil.copy2(BUNDLE, os.path.join(viewer_dir, "roidraw.bundle.js"))
    with open(html_path, encoding="utf-8") as f:
        html = f.read()
    new_html, changed = inject(html)
    if changed:
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(new_html)
    return changed


def main():
    ap = argparse.ArgumentParser(description="Add ROI drawing to a pycortex static viewer (in place).")
    ap.add_argument("viewer_dir", help="the static viewer directory to modify in place")
    ap.add_argument("--html", default="viewer.html", help="viewer HTML file to inject into")
    args = ap.parse_args()
    changed = bake(args.viewer_dir, args.html)
    where = os.path.join(args.viewer_dir, args.html)
    print(("Injected ROI drawing into %s" if changed else "Already baked: %s") % where)


if __name__ == "__main__":
    main()
