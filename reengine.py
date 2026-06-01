#!/usr/bin/env python
"""
reengine.py — re-emit a pycortex static WebGL viewer's HTML shell + JS engine from a CURRENT
pycortex checkout, while reusing the viewer's already-baked data assets. Complementary to
bake.py / fixups.py / add_help.py; reusable on any pycortex static viewer.

Why: a static `make_static` export bakes the entire mriview/three.js engine inline into one
viewer.html, frozen at whatever pycortex built it. When you only have the static assets (no
original subject filestore or Dataset), you can't re-run make_static from source. But the two
Dataset-specific template values — the `dataviews = dataset.fromJSON({...})` descriptor and the
`subjects = {...}` surface descriptor — are themselves baked into the old viewer.html. So we
lift those two verbatim, regenerate the Dataset-independent values (colormaps, viewopts) from
the current checkout, render current pycortex's static.html/template.html, and run pycortex's
own htmlembed to inline the current engine. The data files (data/*.png, *.ctm, *.svg, inspect
JSONs) are left untouched and keep being loaded at runtime.

This only works between compatible engine generations (the baked descriptor format must satisfy
the current dataset.js / mriview.Surface). pycortex main and the huth-2016 viewer are both the
three.js r69 / mriview generation, so the descriptors port directly. Verify in-browser after.

CLI:
  python3 reengine.py --old-viewer OLD.html --pycortex /path/to/pycortex --out viewer.html
"""
import os
import re
import sys
import glob
import json
import base64
import types
import argparse
import importlib.util


# --------------------------------------------------------------------------- #
# Extraction: pull the baked template values out of an existing static viewer  #
# --------------------------------------------------------------------------- #

_OPEN_TO_CLOSE = {"{": "}", "(": ")", "[": "]"}


def extract_balanced(s, start):
    """Return s[start:end] spanning the bracket at s[start] and its match, respecting
    JSON string literals (so brackets inside "..." don't count). Raises ValueError if
    no balanced match is found."""
    open_ch = s[start]
    if open_ch not in _OPEN_TO_CLOSE:
        raise ValueError("s[start] is not an opening bracket: %r" % open_ch)
    close_ch = _OPEN_TO_CLOSE[open_ch]
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return s[start:i + 1]
    raise ValueError("unbalanced bracket starting at %d" % start)


def _last_assignment_value(html, name, before_idx):
    """Find the LAST `name = {` assignment occurring before before_idx and return its balanced
    object literal. The make_static onload block (viewopts/subjects/dataviews) is emitted at the
    very end of the file, after the inlined engine, so the last assignment before the dataviews
    block is the real template-injected value — this skips engine-internal decoys like the
    earlier `subjects = {}`."""
    region = html[:before_idx]
    matches = list(re.finditer(r"%s\s*=\s*\{" % re.escape(name), region))
    if not matches:
        raise ValueError("could not find `%s = {` before the dataviews block" % name)
    brace_idx = matches[-1].end() - 1  # index of the '{'
    return extract_balanced(html, brace_idx)


def extract_template_vars(html):
    """Extract the baked make_static template values from a built static viewer.html.

    Returns dict with:
      data      : JSON string passed to dataset.fromJSON(...)  (outer parens stripped)
      subjects  : JSON string assigned to `subjects`           (surface descriptor)
      viewopts  : JSON string assigned to `viewopts`
      leapmotion: bool, whether the viewer bundled the leap-motion controller
    """
    m = re.search(r"dataset\.fromJSON\s*\(", html)
    if not m:
        raise ValueError("no `dataset.fromJSON(` found — not a pycortex static viewer?")
    paren_idx = m.end() - 1  # index of the '('
    data = extract_balanced(html, paren_idx)[1:-1].strip()  # strip outer ( )

    subjects = _last_assignment_value(html, "subjects", m.start())
    viewopts = _last_assignment_value(html, "viewopts", m.start())

    leapmotion = bool(re.search(r"leap-0\.6\.4\.js", html))

    # Validate that what we lifted is real JSON (fail loud, not at render time).
    for k, v in (("data", data), ("subjects", subjects), ("viewopts", viewopts)):
        try:
            json.loads(v)
        except json.JSONDecodeError as e:
            raise ValueError("extracted %s is not valid JSON: %s" % (k, e))

    return dict(data=data, subjects=subjects, viewopts=viewopts, leapmotion=leapmotion)


# --------------------------------------------------------------------------- #
# Colormaps: regenerate the (name, data-URI) list from the current checkout    #
# --------------------------------------------------------------------------- #

def build_colormaps(colormaps_dir):
    """Return a sorted list of (name, 'data:image/png;base64,...') for every *.png in
    colormaps_dir — the same list make_static feeds the template's colormap dropdown."""
    out = []
    for png in sorted(glob.glob(os.path.join(colormaps_dir, "*.png"))):
        name = os.path.splitext(os.path.basename(png))[0]
        with open(png, "rb") as fp:
            b64 = base64.b64encode(fp.read()).decode("ascii")
        out.append((name, "data:image/png;base64," + b64))
    return out


# --------------------------------------------------------------------------- #
# Render + embed using the CURRENT pycortex checkout's own machinery           #
# --------------------------------------------------------------------------- #

def _viewopts_from_config(pycortex_root):
    """Build the viewopts dict from the current checkout's defaults.cfg, mirroring how
    view.make_static assembles it (webgl_viewopts + curvature + paths/labels sections)."""
    import configparser
    cfg = configparser.ConfigParser()
    cfg.read(os.path.join(pycortex_root, "cortex", "defaults.cfg"))
    vo = dict(cfg.items("webgl_viewopts")) if cfg.has_section("webgl_viewopts") else {}
    vo["overlays_visible"] = ("rois", "sulci")
    vo["labels_visible"] = ("rois",)
    if cfg.has_section("curvature"):
        vo["brightness"] = cfg.get("curvature", "brightness", fallback=0.5)
        vo["contrast"] = cfg.get("curvature", "contrast", fallback=0.25)
        vo["smoothness"] = cfg.get("curvature", "webgl_smooth", fallback=0)
    for sec in cfg.sections():
        if "paths" in sec or "labels" in sec:
            vo[sec] = dict(cfg.items(sec))
    return vo


def render_viewer(webgl_dir, *, data, subjects, viewopts, colormaps,
                  title, default_cmap="RdBu_r", leapmotion=False, layout=None):
    """Render current pycortex's static.html -> template.html with the given values.
    data/subjects/viewopts are raw JSON strings (injected verbatim, as make_static does)."""
    from tornado import template
    loader = template.Loader(webgl_dir, autoescape=None)
    tpl = loader.load("static.html")
    html = tpl.generate(
        data=data,
        colormaps=colormaps,
        default_cmap=default_cmap,
        python_interface=False,
        leapmotion=leapmotion,
        layout=layout,
        subjects=subjects,
        viewopts=viewopts,
        title=title,
    )
    return html.decode("utf-8") if isinstance(html, bytes) else html


def _load_pycortex_embed(webgl_dir):
    """Load the current checkout's serve.py + htmlembed.py as a standalone package so we use
    pycortex's REAL embedder without importing the heavy top-level `cortex` package (which
    pulls scipy/nibabel and reads the possibly-broken global config)."""
    pkgname = "_pcwebgl"
    pkg = types.ModuleType(pkgname)
    pkg.__path__ = [webgl_dir]
    sys.modules[pkgname] = pkg
    for name in ("serve", "htmlembed"):  # serve first: htmlembed does `from . import serve`
        full = "%s.%s" % (pkgname, name)
        spec = importlib.util.spec_from_file_location(full, os.path.join(webgl_dir, name + ".py"))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[full] = mod
        spec.loader.exec_module(mod)
    return sys.modules["%s.htmlembed" % pkgname]


def reengine(old_viewer_path, pycortex_root, out_path, title="Brain", reuse_viewopts=True):
    """Re-emit out_path from the current pycortex checkout, reusing old_viewer_path's baked
    data/subjects (and, by default, its viewopts). Returns the extracted vars for logging."""
    with open(old_viewer_path, encoding="utf-8") as fp:
        old_html = fp.read()
    v = extract_template_vars(old_html)

    webgl_dir = os.path.join(pycortex_root, "cortex", "webgl")
    colormaps_dir = os.path.join(pycortex_root, "filestore", "colormaps")
    colormaps = build_colormaps(colormaps_dir)

    viewopts = v["viewopts"] if reuse_viewopts else json.dumps(_viewopts_from_config(pycortex_root))

    html = render_viewer(
        webgl_dir, data=v["data"], subjects=v["subjects"], viewopts=viewopts,
        colormaps=colormaps, title=title, leapmotion=v["leapmotion"],
    )
    htmlembed = _load_pycortex_embed(webgl_dir)
    htmlembed.embed(html, out_path, rootdirs=[webgl_dir])
    return v


def main():
    ap = argparse.ArgumentParser(description="Re-engine a pycortex static viewer onto a current checkout.")
    ap.add_argument("--old-viewer", required=True, help="path to the existing built viewer.html")
    ap.add_argument("--pycortex", required=True, help="path to a current pycortex checkout (repo root)")
    ap.add_argument("--out", required=True, help="output viewer.html path")
    ap.add_argument("--title", default="Brain", help="<title> for the viewer document")
    ap.add_argument("--config-viewopts", action="store_true",
                    help="regenerate viewopts from the checkout config instead of reusing the old viewer's")
    args = ap.parse_args()
    v = reengine(args.old_viewer, args.pycortex, args.out, title=args.title,
                 reuse_viewopts=not args.config_viewopts)
    print("re-engined %s -> %s (leapmotion=%s, %d-char data descriptor)"
          % (args.old_viewer, args.out, v["leapmotion"], len(v["data"])))


if __name__ == "__main__":
    main()
