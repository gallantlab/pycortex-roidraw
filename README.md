# pycortex-roidraw

In-browser **ROI drawing + export** for [pycortex](https://github.com/gallantlab/pycortex) WebGL
viewers. Lasso a region on the flattened cortical surface; the stroke is fitted to a smooth,
**editable bezier** that renders as a white outline + label **baked into the surface** (so it
occludes and morphs correctly), and exports to a portable JSON. The bezier is stored alongside the
vertex set, so reloaded ROIs can be re-edited by dragging their control points.

The whole feature ships as one self-contained script (`dist/roidraw.bundle.js`, CSS included), so
it can be dropped into **any** pycortex viewer — a static one (like a `make_static` export) or a
freshly generated/dynamic one.

---

## Add it to a viewer

1. Build the bundle (see [Building](#building)), or grab a prebuilt `dist/roidraw.bundle.js`.
2. Copy `roidraw.bundle.js` next to the viewer's HTML.
3. Add two tags before the closing `</body>` (pycortex `make_static` fragments have no `</body>` —
   append at the end instead):

   ```html
   <script src="roidraw.bundle.js"></script>
   <script>window.ROIDraw.autoAttach();</script>
   ```

`autoAttach()` waits for the viewer to finish loading, then attaches. That's the entire
integration.

### Or use the helper scripts

```bash
# Static viewer (already built): inject in place, non-destructively.
python bake.py path/to/viewer_dir            # adds the bundle + the two <script> tags

# Dynamic viewer: generate a fresh pycortex viewer with drawing baked in (example, dummy data).
.venv/bin/python examples/make_viewer.py
```

---

## Using the tool

A **Display / Draw** toggle sits at the top of the viewer.

- **Display** — the normal pycortex viewer + control panel.
- **Draw** — the brain flattens and the ROI panel appears. Then:

| Gesture | Action |
| --- | --- |
| Drag | Lasso a region → name it → it's fitted to a smooth bezier and drawn onto the surface |
| Scroll wheel | Zoom (to draw fine detail) |
| **Shift** + drag | Pan the surface |
| **Shift** + click | Inspect the voxel under the cursor |
| `Esc` | Cancel the current lasso (or finish editing) |

The panel lists drawn ROIs and has **Export JSON** / **Import** / **Clear all**. Drawn ROIs are a
toggleable overlay layer (Surface → overlays → "drawn ROIs") alongside the built-in rois/sulci.

### Editing a shape

Click **✎ edit** next to an ROI in the panel. Its bezier knots appear on the flatmap as draggable
dots; drag a knot to reshape the curve (the tangent handles stay smooth automatically — v1 is
"drag knots only"). You can scroll to zoom and Shift-drag to pan while editing, and the knots track
the surface as you do. The vertex membership is **re-derived from the bezier** on release, so the
exported vertex set always matches the curve you see. Click the **✓ Done editing** button (or
`Esc`) to finish. Imported ROIs are editable too — older files without a bezier get one fitted from
their boundary ring on import.

### Export format

`rois.json` — per-hemisphere **subject** vertex indices, an ordered boundary ring, a label vertex,
and the editable **bezier** (control points in view-independent flat-UV `[0,1]`). It re-imports
(here or in any viewer on the same surface) to the exact same outline, ready to re-edit:

```jsonc
{
  "format": "pycortex-roidraw/vertexset-v2",
  "surface": "fsaverage",
  "rois": [
    { "name": "V1", "color": "#e6194b",
      "vertices": { "left": [ ... ], "right": [ ... ] },
      "outline":  [ { "h": "left", "g": 1234 }, ... ],
      "labelVert": { "h": "left", "g": 1290 },
      "bezier": { "closed": true,
                  "anchors":    [ [0.41, 0.55], ... ],
                  "inHandles":  [ [0.40, 0.55], ... ],
                  "outHandles": [ [0.42, 0.55], ... ] } }
  ]
}
```

`v1` files (no `bezier`) still import; the bezier is back-filled from the outline ring.

---

## Architecture

Three layers; only the adapter knows the host viewer.

```
core/      pure JS — no DOM, no THREE, no host globals (unit-tested under node)
  geom.js        point-in-polygon, RDP simplify, Chaikin smooth, ndc↔pixel, centroid
  selection.js   projected vertices + polygon → selected vertex set (works in px OR uv)
  outline.js     polygon → ordered boundary ring of vertices (+ label vertex)
  bezier.js      fit an editable closed bezier to a ring; sample it back to a polygon
  transform.js   uv↔px homography (edit overlay only: place/grab knots in the current view)
  roi-model.js   ROI collection + the portable (de)serialization format (incl. the bezier)

adapter/   the ViewerAdapter CONTRACT + one host implementation
  viewer-adapter.js     documented interface the core/ui depend on
  pycortex-adapter.js   the ONLY file that touches pycortex internals

ui/        host-agnostic DOM components (talk only to core + adapter)
  lasso-overlay.js  bezier-edit-overlay.js  draw-panel.js  mode-toggle.js  roidraw.css

index.js   controller wiring core + adapter + ui; exposes window.ROIDraw
build.mjs  esbuild → dist/roidraw.bundle.js (CSS inlined)
```

### Porting to another viewer engine

Implement [`adapter/viewer-adapter.js`](adapter/viewer-adapter.js) for your viewer
(`projectVertices`, `allVertexUV`, `vertexUV`, `projectVerticesInUvBounds`, `setOverlayLayer`,
`flatten`, `setCameraTarget`/`setCameraRadius`, `zoom`/`pan`, `onMixChange`, …) and point
`index.js` at it. The pure `core/` and `ui/` are
reused unchanged. Every pycortex-specific quirk (the flat-offset, pivot-matrix refresh, SVG
viewBox coords, label `data-ptidx` convention, control-panel internals) is quarantined in
`pycortex-adapter.js`.

---

## Building

```bash
npm install        # one-time (esbuild)
npm run build      # -> dist/roidraw.bundle.js
```

## Testing

```bash
npm test           # JS core tests (node) + Python tooling tests (bake/fixups)
```

## Requirements

- **Node** ≥ 18 to build/test the JS.
- **Python 3** for `bake.py` / `fixups.py` (stdlib only). The dynamic example
  (`examples/make_viewer.py`) additionally needs **pycortex** (Python ≤ 3.12) in `.venv`.

## Extras

- [`fixups.py`](fixups.py) — corrects long-standing pycortex static-viewer UI bugs in a built
  viewer's HTML: help-menu key casing, `#helpmenu` centering, help-menu font, a "press h for help"
  hint, and Firefox scroll-wheel zoom. Unit-tested; idempotent.
- [`add_help.py`](add_help.py) — injects a static help menu into older viewers that shipped without
  one (a feature sibling to `bake.py`, not a bug fix). Unit-tested.
