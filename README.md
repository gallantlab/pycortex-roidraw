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

1. Download `roidraw.bundle.js` from the [latest release](https://github.com/gallantlab/pycortex-roidraw/releases/latest), or build it yourself (see [Building](#building)).
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
- **Draw** — the brain flattens and the ROI panel appears. Drawing is **flat-only**: inflating the
  surface (the unfold slider) returns you to Display. Then:

| Gesture | Action |
| --- | --- |
| Drag | Lasso a region → name it → it's fitted to a smooth bezier and drawn onto the surface |
| Scroll wheel | Zoom (to draw fine detail) |
| **Shift** + drag | Pan the surface |
| **Shift** + click | Inspect the voxel under the cursor |
| `Esc` | Cancel the current lasso (or finish editing) |

The panel lists drawn ROIs and has **Export JSON** / **Import** / **Clear all**. Drawn ROIs are a
toggleable overlay layer (Surface → overlays → "drawn ROIs") alongside the built-in rois/sulci.

### Editing a shape — full bezier controls

Click **✎ edit** next to an ROI in the panel (this re-flattens the surface if needed). The shape's
anchors appear on the flatmap, and you get the full set of vector-editing controls:

| Gesture | Action |
| --- | --- |
| Drag an anchor (**●**/**■**) | Move it; its two tangent handles travel with it |
| Click an anchor | Select it → its two tangent handles (**○**) appear |
| Drag a handle (**○**) | Bend the curve. A **smooth** anchor mirrors the opposite handle; a **corner** anchor moves each side independently |
| Double-click the curve | Insert a new anchor there (the curve shape is preserved) |
| Double-click an anchor | Toggle it between **smooth** (●, circle) and **corner** (■, square) |
| `Delete` / `Backspace` | Remove the selected anchor (a minimum of 3 is kept) |
| Scroll wheel | Zoom · **Shift** + drag | Pan |

The anchors track the surface as you zoom/pan. Vertex membership is **re-derived from the bezier** on
every change, so the exported vertex set always matches the curve you see. Click **✓ Done editing**
(or `Esc`) to finish. Imported ROIs are editable too — older files without a bezier get one fitted
from their boundary ring on import, and a freshly fit curve starts fully smooth.

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
                  "outHandles": [ [0.42, 0.55], ... ],
                  "smooth":     [ true, false, ... ] } }
  ]
}
```

The `bezier` carries explicit tangent handles and a per-anchor `smooth` flag, so a re-imported curve
re-edits identically. `v1` files (no `bezier`) still import — the bezier is back-filled from the
outline ring; a `bezier` from an earlier build (no `smooth`) is treated as all-smooth.

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
