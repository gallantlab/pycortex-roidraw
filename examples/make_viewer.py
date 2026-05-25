#!/usr/bin/env python
"""
make_viewer.py — EXAMPLE: generate a pycortex static WebGL viewer (fresh, dummy data) with ROI
drawing baked in. This demonstrates the "dynamic viewer" integration path (vs bake.py, which adds
drawing to an already-built static viewer). The data here is a placeholder map — swap in a real
cortex.Dataset to make a real viewer.

Run with this repo's venv:  .venv/bin/python examples/make_viewer.py
Output: viewer_out/index.html  (open in a browser, or serve the directory).

Notes:
  * The machine's GLOBAL pycortex config points at a deleted venv, so we repair it IN MEMORY
    (colormaps from this venv; a project-local filestore) — we never touch the user's config.
  * fsaverage is downloaded into a project-local store on first run.
  * ROI drawing is added by copying dist/roidraw.bundle.js next to the generated index.html and
    injecting two <script> tags before </body>. (Post-process, so no template/escaping pitfalls.)
"""
import os
import sys
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo root (this file is in examples/)
STORE = os.path.join(ROOT, "store")          # project-local pycortex filestore (gitignored)
OUT = os.path.join(ROOT, "viewer_out")
BUNDLE = os.path.join(ROOT, "dist", "roidraw.bundle.js")
SUBJECT = "fsaverage"

import cortex
from cortex import options

# --- repair the broken global config, in memory only -------------------------------------
VENV_SHARE = os.path.join(sys.prefix, "share", "pycortex")
options.config.set("webgl", "colormaps", os.path.join(VENV_SHARE, "colormaps"))
os.makedirs(STORE, exist_ok=True)
cortex.db.filestore = STORE          # mutate the live Database everyone references
cortex.db._subjects = None           # drop its cached subject list

# --- ensure fsaverage is in the local store ----------------------------------------------
if SUBJECT not in cortex.db.subjects:
    print("Downloading %s into %s ..." % (SUBJECT, STORE))
    cortex.utils.download_subject(subject_id=SUBJECT, pycortex_store=STORE)
    cortex.db._subjects = None
print("subjects:", list(cortex.db.subjects))

# --- a dummy per-vertex dataset (random map; flat color is fine too) ----------------------
import numpy as np
lpts = cortex.db.get_surf(SUBJECT, "fiducial", "lh")[0]
rpts = cortex.db.get_surf(SUBJECT, "fiducial", "rh")[0]
nverts = len(lpts) + len(rpts)
data = cortex.Vertex(np.random.randn(nverts).astype("float32"), SUBJECT,
                     cmap="RdBu_r", vmin=-2, vmax=2)

# --- generate the static viewer (import make_static AFTER the colormaps fix) --------------
from cortex.webgl import make_static
if os.path.exists(OUT):
    shutil.rmtree(OUT)
print("Generating viewer in %s ..." % OUT)
make_static(OUT, data, recache=True, title="ROI Draw — fsaverage")

# --- inject the ROI-drawing bundle --------------------------------------------------------
shutil.copy(BUNDLE, os.path.join(OUT, "roidraw.bundle.js"))
index = os.path.join(OUT, "index.html")
with open(index) as f:
    html = f.read()
inject = (
    '\n<script src="roidraw.bundle.js"></script>'
    '\n<script>window.ROIDraw.autoAttach();</script>\n'
)
if "</body>" in html:
    html = html.replace("</body>", inject + "</body>", 1)
else:
    html += inject
with open(index, "w") as f:
    f.write(html)

print("\nDone. Open: %s" % index)
print("Or serve:  python -m http.server -d %s 8000" % OUT)
