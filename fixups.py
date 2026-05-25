#!/usr/bin/env python
"""
fixups.py — correct two long-standing pycortex static-viewer UI bugs in a built viewer's HTML.
Complementary to bake.py; reusable on any pycortex static viewer.

  1. Help-menu key CASE — pycortex's help generator runs `key.toUpperCase()` on every shortcut,
     so a binding like key:'r' (reset/fold) is shown as "R" — which actually means Shift+R (a
     DIFFERENT command, toggle right hemisphere). The binding data already carries the correct
     case ('r' for plain, 'R'/'S'/'L' for shifted), so we render the key verbatim and capitalize
     the modifier label ("shift" -> "Shift").
  2. Help-menu POSITION — pycortex pins #helpmenu to the left edge (left:0%), where its lower half
     hides behind the lower-left legend. We center it horizontally.

These edit the viewer's OWN embedded JS/CSS (a source-level fix of the artifact) — not runtime
overrides. Pure transforms below; unit-tested in test/test_fixups.py.

    python fixups.py <viewer_dir> [--html viewer.html]
"""
import argparse
import os
import re


def fix_help_key_case(html):
    """Render shortcut keys in their true case and capitalize the modifier label. Idempotent."""
    out = html.replace("['key'].toUpperCase()", "['key']")
    out = out.replace(
        "modKey.substring(0, modKey.length - 3)",
        "modKey.charAt(0).toUpperCase() + modKey.substring(1, modKey.length - 3)",
    )
    return out, out != html


def center_help_menu(html):
    """Center #helpmenu horizontally (it ships pinned left). Idempotent; scoped to its CSS rule."""
    def repl(m):
        body = (m.group(2)
                .replace("left: 0%;", "left: 50%;")
                .replace("translate(0%, -50%)", "translate(-50%, -50%)"))
        return m.group(1) + body + m.group(3)
    out = re.sub(r"(#helpmenu\s*\{)([^}]*)(\})", repl, html, count=1)
    return out, out != html


def apply_fixups(html):
    html, c1 = fix_help_key_case(html)
    html, c2 = center_help_menu(html)
    return html, (c1 or c2)


def main():
    ap = argparse.ArgumentParser(description="Fix pycortex help-menu case + position in a built viewer.")
    ap.add_argument("viewer_dir", help="the static viewer directory to modify in place")
    ap.add_argument("--html", default="viewer.html", help="viewer HTML file to fix")
    args = ap.parse_args()
    path = os.path.join(args.viewer_dir, args.html)
    if not os.path.isfile(path):
        raise SystemExit("no %s in %s" % (args.html, args.viewer_dir))
    with open(path, encoding="utf-8") as f:
        html = f.read()
    new_html, changed = apply_fixups(html)
    if changed:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_html)
    print(("Applied help-menu fixups to %s" if changed else "No changes (already fixed): %s") % path)


if __name__ == "__main__":
    main()
