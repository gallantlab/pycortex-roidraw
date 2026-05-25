#!/usr/bin/env python
"""
add_help.py — inject a static help menu into a pycortex viewer that was built WITHOUT one.

Some older mriview viewers shipped without the help feature (no #helpmenu, no generated help menu).
This adds a self-contained, centered shortcut panel toggled by the 'h' key, plus a small
"press h for help" hint. It is a FEATURE injection (a sibling to bake.py) — NOT a bug fix; bug
corrections live in fixups.py. Run fixups.py too: it restores Firefox scroll-wheel zoom on these old
viewers, so the panel's "scroll = zoom" line is actually true.

The panel is grounded in the viewer, not guessed:
  - mouse controls are pycortex LandscapeControls' verified behavior (left-drag rotates, but PANS
    when the surface is flat; right-drag zooms; the wheel zooms once fixups.py is applied), and
  - the keyboard rows list ONLY the keys this viewer actually binds (read from its key:'x'
    descriptors), since the bound key set differs between viewers.

The panel + hint are inserted INTO the viewer's #main DOM template, so they survive the viewer's
one-time on-load DOM rebuild ($(obj).html($('#mriview_html').html())); the 'h' toggle is a window
keydown listener (which persists regardless). Idempotent, and a no-op on viewers that already have a
help menu, aren't mriview viewers, or have no #main template.

    python add_help.py <viewer_dir> [--html viewer.html]

Pure injection logic lives in add_help() and is unit-tested in test/test_add_help.py.
"""
import argparse
import os
import re

STYLE = """
<style>
#pycortex-static-help{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1000;
 display:none;max-width:480px;max-height:80vh;overflow:auto;background:rgba(0,0,0,.82);color:#fff;
 font-family:Helvetica, Arial, sans-serif;font-size:12pt;padding:16px 22px;border-radius:10px;
 box-shadow:0 6px 30px rgba(0,0,0,.6)}
#pycortex-static-help h3{margin:.7em 0 .2em;font-size:10.5pt;color:#ffd479;font-weight:bold}
#pycortex-static-help h3:first-child{margin-top:0}
#pycortex-static-help table{border-collapse:collapse;width:100%}
#pycortex-static-help td{padding:2px 8px;vertical-align:top}
#pycortex-static-help td.k{text-align:right;color:#9fe;white-space:nowrap;font-weight:bold}
</style>"""

# Verified LandscapeControls mouse behavior (scroll-zoom needs fixups.fix_wheel_zoom on old viewers).
MOUSE = (
    "<h3>Mouse</h3><table>"
    "<tr><td class=k>left-drag</td><td>rotate (pan when flat)</td></tr>"
    "<tr><td class=k>right-drag</td><td>zoom</td></tr>"
    "<tr><td class=k>scroll</td><td>zoom</td></tr></table>"
)

# Standard meaning of each mriview key; the actual key SET is read from the viewer (they differ).
KEY_LABELS = [
    ("r", "reset view"), ("f", "flatten"), ("i", "inflate"), ("k", "inflate to cuts"),
    ("p", "pial surface"), ("u", "fiducial surface"), ("y", "white-matter surface"),
    ("L", "toggle left hemisphere"), ("R", "toggle right hemisphere"),
    ("o", "toggle data opacity"), ("l", "toggle labels"), ("m", "toggle layers"),
    ("e", "toggle X slice"), ("d", "toggle Y slice"), ("c", "toggle Z slice"),
    ("q", "next X slice"), ("w", "previous X slice"),
    ("a", "next Y slice"), ("s", "previous Y slice"),
    ("z", "next Z slice"), ("x", "previous Z slice"),
    ("+", "next dataset"), ("-", "previous dataset"), ("S", "save view as PNG"),
]

HINT = (
    '<div id="pycortex-helphint" style="position:fixed;bottom:10px;left:50%;'
    'transform:translateX(-50%);z-index:7;pointer-events:none;'
    'font-family:Helvetica, Arial, sans-serif;font-size:11pt;color:#fff;'
    'background:rgba(0,0,0,.55);padding:4px 10px;border-radius:6px">press <b>h</b> for help</div>'
)

TOGGLE = """
<!-- pycortex-roidraw: 'h' toggles the static help menu -->
<script>(function(){if(window.__pcxStaticHelp)return;window.__pcxStaticHelp=1;
window.addEventListener("keydown",function(e){
 if(e.ctrlKey||e.metaKey||e.altKey)return;
 if(!e.key||e.key.toLowerCase()!=="h")return;
 var t=(e.target&&e.target.tagName)||"";if(t==="INPUT"||t==="TEXTAREA")return;
 var el=document.getElementById("pycortex-static-help");
 if(el)el.style.display=(el.style.display==="block")?"none":"block";},false);})();</script>
"""

MARKER = "pycortex-static-help"


def bound_keys(html):
    """The single-char keyboard shortcuts the viewer actually binds (from its key:'x' descriptors)."""
    return set(re.findall(r"key\s*:\s*['\"]([^'\"]{1,2})['\"]", html))


def build_panel(html):
    """The help-panel HTML: verified mouse controls + ONLY the keys this viewer binds (+ 'h')."""
    bound = bound_keys(html)
    rows = [(k, lbl) for k, lbl in KEY_LABELS if k in bound]
    rows.append(("h", "toggle this help"))
    keyrows = "".join("<tr><td class=k>%s</td><td>%s</td></tr>" % (k, lbl) for k, lbl in rows)
    return (STYLE + '\n<div id="pycortex-static-help">' + MOUSE
            + "<h3>Keyboard</h3><table>" + keyrows + "</table></div>\n" + HINT + "\n")


def add_help(html):
    """Return (new_html, changed). Inject the static help menu into a modern (mriview) viewer that
    lacks a help menu and has the #main template. Idempotent; a no-op otherwise."""
    if MARKER in html:
        return html, False                          # already added
    if "mriview" not in html:
        return html, False                          # old-engine viewer: different help mechanism
    if ("helpmenu = function" in html) or ("_show_help" in html):
        return html, False                          # already has a generated help menu
    anchor = '<div id="main">'
    k = html.find("mriview_html")
    i = html.find(anchor, k if k != -1 else 0)
    if i == -1:
        return html, False                          # no template to build the panel into
    pos = i + len(anchor)
    html = html[:pos] + build_panel(html) + html[pos:]   # panel + hint built into the viewer's DOM
    return html + TOGGLE, True                            # 'h' toggle (window keydown listener)


def main():
    ap = argparse.ArgumentParser(description="Inject a static help menu into a pycortex viewer that lacks one.")
    ap.add_argument("viewer_dir", help="the static viewer directory to modify in place")
    ap.add_argument("--html", default="viewer.html", help="viewer HTML file to modify")
    args = ap.parse_args()
    path = os.path.join(args.viewer_dir, args.html)
    if not os.path.isfile(path):
        raise SystemExit("no %s in %s" % (args.html, args.viewer_dir))
    with open(path, encoding="utf-8") as f:
        html = f.read()
    new_html, changed = add_help(html)
    if changed:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_html)
    print(("Injected a static help menu into %s"
           if changed else "No change (already has help / not mriview / already added): %s") % path)


if __name__ == "__main__":
    main()
