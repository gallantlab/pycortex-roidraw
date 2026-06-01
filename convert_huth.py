#!/usr/bin/env python
"""
convert_huth.py — upgrade the huth-2016 static viewer onto current pycortex's framework.

The huth-2016 viewer is a heavily-customized static export (custom word-cloud voxel pickers,
legends, dark/light themes, dataset_actions, and a tutorial tour) built on an older pycortex.
The group-language-comprehension viewer (viewer-stories-group) is essentially the same viewer
*modernized* with different data. So "convert huth to the new framework" =

  1. swap the inlined pycortex LIBRARIES for a current checkout's (via reengine.py),
  2. MODERNIZE the tour using stories-group's implementation (hide/show toggle + tooltips),
     keeping huth's own tour_content (its Huth-specific steps),
  3. KEEP huth's data-coupled custom layer verbatim — the voxel-indexed picker matches huth's
     existing voxels/ + pragmatic/ inspect data, which the modern (vertex-indexed) picker would
     not, so the picker/legends/themes/dataset_actions/data all travel unchanged,
  4. DROP the dead `lsaplot.js` reference (a 404 in the live viewer; only used in commented code).

Mechanism: treat the old viewer as a custom pycortex template. Extract its custom
`{% block javascripts %}` (everything after the last library, mriview.js, and before the
mriview_html template) and its `{% block onload %}` (the final else{} of $(document).ready).
Render a vanilla shell from the current checkout (reengine.py -> current libraries + colormaps),
then inject the (modernized) javascripts block and swap in huth's onload. Re-applying the
help-menu fixes (fixups.py) and Firefox verification happen as separate steps.

CLI:
  python3 convert_huth.py --old-viewer OLD.html --stories STORIES.html \
      --pycortex /path/to/pycortex --out viewer.html
"""
import os
import re
import sys
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reengine  # noqa: E402  (shell render/embed + JSON-safe balanced-bracket extractor)

MRIVIEW_END = "}(mriview || {}));"     # module-close of mriview.js (the last library)
TOUR_CLASS_START = "Tour = function(content)"
# Distinctive validator message ending the second WebGL-capability branch; the onload block is
# the `else {}` immediately after it. NB: a bare "texture units" also occurs inside three.js, so
# the full phrase is required to anchor on the validator, not the library.
ONLOAD_ANCHOR = "minimum number of texture units"


# --------------------------------------------------------------------------- #
# Small structural helpers                                                      #
# --------------------------------------------------------------------------- #

def find_template_tag(html, tid):
    """Index of the `<script ... id=[']tid[']>` template tag (NOT a JS '#tid' reference)."""
    m = re.search(r"<script[^>]*\bid=['\"]?%s['\"]?\s*>" % re.escape(tid), html)
    if not m:
        raise ValueError("template tag id=%s not found" % tid)
    return m.start()


def _after(text, marker, frm=0):
    return text.index(marker, frm) + len(marker)


def _script_block(html, tid):
    """(start, end) of the whole `<script ... id=tid>...</script>` block."""
    s = find_template_tag(html, tid)
    e = _after(html, "</script>", s)
    return s, e


def _style_block_with(html, needle):
    """(start, end) of the `<style>...</style>` block that contains `needle`."""
    idx = html.index(needle)
    s = html.rindex("<style", 0, idx)
    e = _after(html, "</style>", idx)
    return s, e


def _tour_class_span(html):
    """(start, end) of the `Tour = function(content){...}`+prototypes, up to its block's
    closing </script>. In both viewers the Tour class is the tail of its script block (after
    tour_anim_speed + tour_content), so the next </script> bounds it cleanly."""
    s = html.index(TOUR_CLASS_START)
    e = html.index("</script>", s)
    return s, e


# --------------------------------------------------------------------------- #
# Extraction from the old huth viewer                                           #
# --------------------------------------------------------------------------- #

def extract_javascripts_block(html):
    """The custom {% block javascripts %} content: everything after the last library script
    (mriview.js) and before the mriview_html template."""
    last = html.rindex(MRIVIEW_END)
    js_start = _after(html, "</script>", last)        # end of the mriview.js <script> block
    mh = find_template_tag(html, "mriview_html")      # start of the mriview_html template
    return html[js_start:mh]


def _onload_bounds(html):
    """(start, end) of the onload code inside the bottom script's final `else { ... }`.

    Structurally: `... else { <ONLOAD> }\n});\n</script>`. We anchor the `else` on the validator
    message, take start just after its `{`, and take end as the `}` immediately before the `});`
    that closes `$(document).ready(...)`. This avoids brace-balancing the JS body (which contains
    braces inside single-quoted strings and regexes that a JSON-only balancer miscounts)."""
    ai = html.index(ONLOAD_ANCHOR)
    ei = html.index("else", ai)
    start = html.index("{", ei) + 1                       # just after `else {`
    sclose = html.index("</script>", ai)                  # end of the bottom <script>
    ready_close = html.rindex("});", start, sclose)       # closes $(document).ready(function(){
    end = html.rindex("}", start, ready_close)            # the `}` closing the `else {`
    return start, end


def extract_onload_block(html):
    """The {% block onload %} body (huth's custom onload), inner code only."""
    s, e = _onload_bounds(html)
    return html[s:e].strip()


def replace_onload_block(html, new_onload):
    """Replace the bottom script's onload body with new_onload."""
    s, e = _onload_bounds(html)
    return html[:s] + "\n" + new_onload + "\n" + html[e:]


# --------------------------------------------------------------------------- #
# Transformations                                                               #
# --------------------------------------------------------------------------- #

def _viewopts_span(html):
    """(start, end, dict) of the `viewopts = {...}` object literal."""
    m = re.search(r"viewopts\s*=\s*\{", html)
    if not m:
        raise ValueError("no `viewopts = {` found")
    brace = m.end() - 1
    obj = reengine.extract_balanced(html, brace)
    return brace, brace + len(obj), json.loads(obj)


def viewopts_of(html):
    """The viewopts dict baked into a built viewer (used as a reference for missing keys)."""
    return _viewopts_span(html)[2]


def merge_viewopts(onload, ref, force=None):
    """Fill viewopts keys huth lacks (e.g. brightness/contrast/smoothness) from `ref` (a dict of
    modern viewopts defaults). The modern viewer binds menu controls (e.g. brightness) to these
    keys; a missing key makes dat.gui's controller factory return undefined and crash Menu init.
    huth's own values win where both define a key; ref supplies only the missing keys. `force`
    overrides even huth's values (e.g. specularity -> 0 to default specular highlighting off)."""
    s, e, huth = _viewopts_span(onload)
    merged = dict(ref)
    merged.update(huth)   # huth's values take precedence; ref supplies only the missing keys
    if force:
        merged.update(force)
    return onload[:s] + json.dumps(merged) + onload[e:]


# Move the data-layer controls to the right edge so they don't cover the tour box (top-left).
# #figure_ui is a JS-sized full-viewer overlay; the actual dat.gui panel (.dg.main) flows at its
# top-left, so anchor THAT to the right. (Specular default-off is handled via viewopts.)
CONTROLS_CSS = "#figure_ui .dg.main{position:fixed;top:0;right:0;left:auto;z-index:10;}"


def inject_css(html, css):
    """Append a <style> with `css` just before </head>."""
    i = html.rfind("</head>")
    if i == -1:
        raise ValueError("no </head> to inject CSS before")
    return html[:i] + "<style>%s</style>\n" % css + html[i:]


def strip_lsaplot(js_block):
    """Remove the dead `<script src="lsaplot.js"></script>` tag (file 404s; only used in
    commented-out code)."""
    return re.sub(r"<script[^>]*\bsrc=['\"]lsaplot\.js['\"][^>]*>\s*</script>", "", js_block)


def modernize_tour(js_block, stories_html):
    """Swap huth's tour CSS + tourbox template + Tour class for stories-group's modern ones
    (hide/show toggle + step tooltips), keeping huth's tour_anim_speed and tour_content."""
    # 1. tourbox template
    ss, se = _script_block(stories_html, "tourbox")
    hs, he = _script_block(js_block, "tourbox")
    js_block = js_block[:hs] + stories_html[ss:se] + js_block[he:]
    # 2. tour CSS
    ss, se = _style_block_with(stories_html, ".tour-stepper")
    hs, he = _style_block_with(js_block, ".tour-stepper")
    js_block = js_block[:hs] + stories_html[ss:se] + js_block[he:]
    # 3. Tour class (constructor + prototypes)
    ss, se = _tour_class_span(stories_html)
    hs, he = _tour_class_span(js_block)
    js_block = js_block[:hs] + stories_html[ss:se] + js_block[he:]
    return js_block


def replace_javascripts_block(shell_html, new_js):
    """Replace the shell's custom javascripts block (everything after the last library, mriview.js,
    and before the mriview_html template) with new_js. Used when the shell is a built modern viewer
    (stories-group) that already has its OWN custom layer there, which we swap for huth's."""
    last = shell_html.rindex(MRIVIEW_END)
    start = _after(shell_html, "</script>", last)
    mh = find_template_tag(shell_html, "mriview_html")
    return shell_html[:start] + "\n" + new_js + "\n" + shell_html[mh:]


def replace_title(shell_html, title):
    return re.sub(r"<title>.*?</title>", "<title>%s</title>" % title, shell_html, count=1, flags=re.S)


# --------------------------------------------------------------------------- #
# Orchestration                                                                 #
# --------------------------------------------------------------------------- #

def convert(old_viewer, stories_viewer, out_path, pycortex_root=None,
            title="Huth et al. 2016 brain viewer"):
    """Build huth on a modern framework, keeping huth's data-coupled custom layer (voxel picker,
    legends, themes, dataset_actions, data) and modernizing its tour from stories-group.

    Framework shell:
      - pycortex_root given  -> bleeding-edge pycortex `main` (rendered+embedded via reengine.py);
        viewopts gaps filled from main's config; help-menu fixups applied (main still has those bugs).
      - pycortex_root None   -> stories-group's built viewer (its proven libraries); viewopts gaps
        filled from stories; no fixups (stories' shell already carries them).

    The viewopts backfill (brightness/contrast/smoothness ...) is essential on EITHER framework:
    huth's old viewopts predates those keys and the modern Menu binds a control to them.
    """
    with open(old_viewer, encoding="utf-8") as fp:
        old = fp.read()
    with open(stories_viewer, encoding="utf-8") as fp:
        stories = fp.read()

    js_block = extract_javascripts_block(old)
    js_block = strip_lsaplot(js_block)
    js_block = modernize_tour(js_block, stories)   # huth's tour content, stories' modern machinery
    onload = extract_onload_block(old)

    if pycortex_root:                               # bleeding-edge pycortex main
        shell_tmp = out_path + ".shell.html"
        reengine.reengine(old_viewer, pycortex_root, shell_tmp, title=title)
        with open(shell_tmp, encoding="utf-8") as fp:
            shell = fp.read()
        os.remove(shell_tmp)
        ref_viewopts = reengine._viewopts_from_config(pycortex_root)
        apply_help_fixups = True
    else:                                           # stories-group's framework
        shell = stories
        ref_viewopts = viewopts_of(stories)
        apply_help_fixups = False

    # backfill viewopts keys the modern viewer needs; force specular highlighting off by default
    onload = merge_viewopts(onload, ref_viewopts, force={"specularity": 0})
    shell = replace_javascripts_block(shell, js_block)
    shell = replace_onload_block(shell, onload)
    shell = replace_title(shell, title)
    shell = inject_css(shell, CONTROLS_CSS)         # controls to the right edge (clear of the tour)

    if apply_help_fixups:
        import fixups
        shell, _ = fixups.apply_fixups(shell)       # key-case + center + font + "press h" hint

    with open(out_path, "w", encoding="utf-8") as fp:
        fp.write(shell)
    return dict(js_block_len=len(js_block), onload_len=len(onload),
                framework="pycortex-main" if pycortex_root else "stories-group")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--old-viewer", required=True, help="the existing huth-2016 viewer.html")
    ap.add_argument("--stories", required=True,
                    help="stories-group's built viewer.html — source of the modern tour (and the framework shell unless --pycortex is given)")
    ap.add_argument("--pycortex", default=None,
                    help="path to a current pycortex checkout — build on bleeding-edge main instead of stories' framework")
    ap.add_argument("--out", required=True, help="output viewer.html path")
    ap.add_argument("--title", default="Huth et al. 2016 brain viewer")
    args = ap.parse_args()
    info = convert(args.old_viewer, args.stories, args.out,
                   pycortex_root=args.pycortex, title=args.title)
    print("converted -> %s on %s (javascripts %d chars, onload %d chars)"
          % (args.out, info["framework"], info["js_block_len"], info["onload_len"]))


if __name__ == "__main__":
    main()
