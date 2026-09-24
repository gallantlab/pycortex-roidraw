#!/usr/bin/env python
"""
make_viewer.py — EXAMPLE: generate a fresh pycortex static WebGL viewer (dummy data) with
make_static, then bake ROI drawing into it with bake.py. This is the end-to-end path from data to a
drawing-enabled viewer (vs running bake.py alone on a viewer that already exists). The data here is
a placeholder map — swap in a real cortex.Dataset to make a real viewer.

Run with this repo's venv:  .venv/bin/python examples/make_viewer.py
Output: viewer_out/index.html  (open in a browser, or serve the directory).

Notes:
  * The user's pycortex config may point at colormaps or a filestore that this venv cannot use, so
    we override both IN MEMORY (colormaps from this venv; a project-local filestore) — we never
    touch the user's config file.
  * fsaverage is downloaded into a project-local store on first run.
  * ROI drawing is added by bake.py — the same bundle copy + two <script> tags that bake a
    pre-built static viewer. (Post-process, so no template/escaping pitfalls.)
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo root (this file is in examples/)
STORE = os.path.join(ROOT, "store")          # project-local pycortex filestore (gitignored)
OUT = os.path.join(ROOT, "viewer_out")
SUBJECT = "fsaverage"

sys.path.insert(0, ROOT)
from bake import bake  # noqa: E402  (the one injection routine; see bake.py)

import cortex  # noqa: E402
import numpy as np  # noqa: E402
from cortex import options  # noqa: E402

# --- point pycortex at this venv's colormaps and a local filestore, in memory only -------
VENV_SHARE = os.path.join(sys.prefix, "share", "pycortex")
options.config.set("webgl", "colormaps", os.path.join(VENV_SHARE, "colormaps"))
os.makedirs(STORE, exist_ok=True)
cortex.db.filestore = STORE          # mutate the live Database everyone references
# `_subjects` is PRIVATE pycortex API (the Database's cached subject list); clearing it forces a
# re-scan of the new filestore, and may break without notice in a future pycortex.
cortex.db._subjects = None

# --- ensure fsaverage is in the local store ----------------------------------------------
if SUBJECT not in cortex.db.subjects:
    print("Downloading %s into %s ..." % (SUBJECT, STORE))
    cortex.utils.download_subject(subject_id=SUBJECT, pycortex_store=STORE)
    cortex.db._subjects = None       # private API, as above: re-scan after the download
print("subjects:", list(cortex.db.subjects))

# --- a dummy per-vertex dataset (random map; flat color is fine too) ----------------------
lpts = cortex.db.get_surf(SUBJECT, "fiducial", "lh")[0]
rpts = cortex.db.get_surf(SUBJECT, "fiducial", "rh")[0]
nverts = len(lpts) + len(rpts)
data = cortex.Vertex(np.random.randn(nverts).astype("float32"), SUBJECT,
                     cmap="RdBu_r", vmin=-2, vmax=2)

# --- generate the static viewer (import make_static AFTER the colormaps override) --------------
from cortex.webgl import make_static  # noqa: E402
if os.path.exists(OUT):
    shutil.rmtree(OUT)
print("Generating viewer in %s ..." % OUT)
make_static(OUT, data, recache=True, title="ROI Draw — fsaverage")

# --- inject the ROI-drawing bundle (bake.py: copies the bundle, injects the two tags) ---------
index, _ = bake(OUT, html_name="index.html")
print("\nDone. Open: %s" % index)
print("Or serve:  python -m http.server -d %s 8000" % OUT)
