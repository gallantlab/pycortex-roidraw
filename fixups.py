#!/usr/bin/env python
"""
fixups.py — correct three long-standing pycortex static-viewer UI bugs in a built viewer's HTML,
and add a small "press h for help" discoverability hint. Complementary to bake.py; reusable on any
pycortex static viewer.

  1. Help-menu key CASE — pycortex's help generator runs `key.toUpperCase()` on every shortcut,
     so a binding like key:'r' (reset/fold) is shown as "R" — which actually means Shift+R (a
     DIFFERENT command, toggle right hemisphere). The binding data already carries the correct
     case ('r' for plain, 'R'/'S'/'L' for shifted), so we render the key verbatim and capitalize
     the modifier label ("shift" -> "Shift").
  2. Help-menu POSITION — pycortex pins #helpmenu to the left edge (left:0%), where its lower half
     hides behind the lower-left legend (and some viewers instead place it top-left, also colliding
     with the legend). We center it (top/left:50%, transform:translate(-50%,-50%)) regardless of
     where it shipped.
  3. Help-menu FONT — #helpmenu sets no font-family, so the panel falls back to the browser-default
     serif (Times in Firefox) while the rest of the viewer UI is sans-serif. We give it an explicit
     sans-serif so it matches.
  4. Help DISCOVERABILITY — the help menu only opens on the 'h' key, with nothing on screen to say
     so. We add a small fixed-position "press h for help" hint (bottom-center, on a dark pill so it
     reads on the white anatomy viewer and the black data viewers). It goes INSIDE the viewer's own
     DOM template (the #main div in the mriview_html block), not <body>: the viewer builds its live
     DOM once via $(obj).html($('#mriview_html').html()), wiping any static <body> element, so a
     body-level hint would flash and vanish. In the template it's built as part of the viewer and
     just persists. Only when a working help menu exists, so it's never shown on viewers lacking one.

All four edit the viewer's OWN embedded JS/CSS/HTML (a source-level fix of the artifact) — not
runtime overrides. Pure transforms below; unit-tested in test/test_fixups.py.

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
    """Center #helpmenu (top/left:50%, transform:translate(-50%, -50%)) regardless of where it
    shipped — stock is left:0% (lower half hidden behind the legend); some viewers place it top-left
    instead. Idempotent; scoped to the #helpmenu rule. Rewrites the top/left/transform declarations
    only (the `transition`/`-*-transition` properties and longhand `*-left` are left untouched)."""
    def repl(m):
        body = m.group(2)
        body = re.sub(r"(?<![-\w])top\s*:\s*[^;]+;", "top: 50%;", body, count=1)
        body = re.sub(r"(?<![-\w])left\s*:\s*[^;]+;", "left: 50%;", body, count=1)
        body = re.sub(r"(?<![-\w])transform\s*:\s*[^;]+;", "transform: translate(-50%, -50%);", body, count=1)
        return m.group(1) + body + m.group(3)
    out = re.sub(r"(#helpmenu\s*\{)([^}]*)(\})", repl, html, count=1)
    return out, out != html


HELP_MENU_FONT = "Helvetica, Arial, sans-serif"


def set_help_menu_font(html, font=HELP_MENU_FONT):
    """Give #helpmenu an explicit sans-serif font-family (it ships with none, so the panel falls
    back to the browser-default serif). Idempotent; scoped to the #helpmenu rule, and a no-op if
    a font-family is already set there."""
    def repl(m):
        open_, body, close = m.group(1), m.group(2), m.group(3)
        if "font-family" in body:
            return m.group(0)                              # already set; leave it
        decl = "\n    font-family:%s;" % font
        end = body.find(";", body.find("font-size:")) if "font-size:" in body else -1
        if end != -1:
            body = body[:end + 1] + decl + body[end + 1:]  # place it beside the font-size decl
        else:
            body = decl + body
        return open_ + body + close
    out = re.sub(r"(#helpmenu\s*\{)([^}]*)(\})", repl, html, count=1)
    return out, out != html


HELP_HINT_ID = "pycortex-helphint"
HELP_HINT_SNIPPET = (
    '\n<!-- pycortex help-discoverability hint -->'
    '\n<div id="pycortex-helphint" style="position:fixed;bottom:10px;left:50%;'
    'transform:translateX(-50%);z-index:7;pointer-events:none;'
    'font-family:Helvetica, Arial, sans-serif;font-size:11pt;color:#fff;'
    'background:rgba(0,0,0,.55);padding:4px 10px;border-radius:6px">'
    'press <b>h</b> for help</div>\n'
)


def add_help_hint(html, snippet=HELP_HINT_SNIPPET, marker='id="%s"' % HELP_HINT_ID):
    """Add a small fixed-position "press h for help" hint. Only when the viewer has a WORKING help
    menu (never advertise help a viewer lacks). Idempotent.

    Inserted INTO the viewer's own DOM template (right after the #main div in the mriview_html
    block), NOT appended to <body>. The viewer rebuilds its DOM once on load via
    $(obj).html($('#mriview_html').html()), which would wipe a body-level element; placing the hint
    in the template makes it a first-class part of the built viewer DOM, so it just persists."""
    if marker in html:
        return html, False
    has_help = ("helpmenu = function" in html) or ("_show_help" in html)
    if not has_help:
        return html, False
    anchor = '<div id="main">'                         # root element of the mriview_html template
    k = html.find("mriview_html")                      # anchor within the template, not any stray #main
    i = html.find(anchor, k if k != -1 else 0)
    if i != -1:
        pos = i + len(anchor)
        return html[:pos] + snippet + html[pos:], True
    return html + snippet, True                         # fallback: viewers without that template


def apply_fixups(html):
    html, c1 = fix_help_key_case(html)
    html, c2 = center_help_menu(html)
    html, c3 = set_help_menu_font(html)
    html, c4 = add_help_hint(html)
    return html, (c1 or c2 or c3 or c4)


def main():
    ap = argparse.ArgumentParser(description="Fix pycortex help-menu (case + position + font) and add a 'press h for help' hint.")
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
