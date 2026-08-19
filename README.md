# pycortex-roidraw

In-browser **ROI + sulcus drawing and export** for
[pycortex](https://github.com/gallantlab/pycortex) WebGL viewers. Draw on the flattened cortical
surface and the stroke is fitted to a smooth, **editable bezier** that renders as a colored outline
(its palette color, over a white halo for legibility) + label **baked into the surface**, so it
occludes and morphs correctly.

Two kinds of shape, each exported in the format its consumer expects:

- **ROIs** are *closed* curves. They carry per-hemisphere vertex membership and export to a
  portable JSON vertex set. The bezier is stored alongside it, so reloaded ROIs re-edit by dragging
  their control points.
- **Sulci** are *open* curves. They carry **no** vertex membership and export as a standalone SVG
  whose `sulci` layer drops straight into a subject's `overlays.svg` — the way pycortex itself
  stores sulci.

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
- **Draw** — the brain flattens and the draw panel appears. Drawing is **flat-only**: inflating the
  surface (the unfold slider) returns you to Display.

At the top of the panel a **`ROI` / `Sulcus`** selector picks what a plain drag draws:

| Gesture | Action |
| --- | --- |
| Drag, with **ROI** selected | Lasso a region → name it → fitted to a smooth *closed* bezier and drawn onto the surface |
| Drag, with **Sulcus** selected | Trace along the sulcus → name it → fitted to a smooth *open* bezier |
| Scroll wheel | Zoom (to draw fine detail) |
| **Shift** + drag | Pan the surface |
| **Shift** + click | Inspect the voxel under the cursor |
| `Esc` | Cancel the current stroke (or finish editing) |

The panel lists everything drawn — a glyph marks each row's kind (**◯** ROI, **∿** sulcus), and the
count column shows enclosed vertices for an ROI, anchors for a sulcus. Below the list sit
**Export ROIs (JSON)** / **Export sulci (SVG)** / **Import** / **Clear all**. Everything drawn lives
in one toggleable overlay layer (Surface → overlays → "drawn ROIs") alongside the built-in
rois/sulci.

A stray click can't create a shape: any stroke, lasso or trace, must span more than a few pixels
before it registers.

### Editing a shape — full bezier controls

Click **✎ edit** next to any shape in the panel (this re-flattens the surface if needed). Its
anchors appear on the flatmap, and you get the full set of vector-editing controls. ROIs and sulci
edit identically:

| Gesture | Action |
| --- | --- |
| Drag an anchor (**●**/**■**) | Move it; its tangent handles travel with it |
| Click an anchor | Select it → its tangent handles (**○**) appear |
| Drag a handle (**○**) | Bend the curve. A **smooth** anchor mirrors the opposite handle; a **corner** anchor moves each side independently |
| Double-click the curve | Insert a new anchor there (the curve shape is preserved) |
| Double-click an anchor | Toggle it between **smooth** (●, circle) and **corner** (■, square) |
| `Delete` / `Backspace` | Remove the selected anchor (a closed curve keeps ≥ 3; an open one keeps ≥ 2) |
| Scroll wheel | Zoom · **Shift** + drag | Pan |

An **open** curve's two endpoints are special: each has only one live tangent (the other would
coincide with the anchor), so a single handle appears there, and endpoints are always corners —
there is no symmetric tangent to mirror at the end of a curve.

The anchors track the surface as you zoom/pan. For an ROI, vertex membership is **re-derived from
the bezier** on every change, so the exported vertex set always matches the curve you see. A sulcus
has no membership to re-derive; its label instead follows the curve's midpoint. Click
**✓ Done editing** (or `Esc`) to finish. Imported ROIs are editable too — older files without a
bezier get one fitted from their boundary ring on import, and a freshly fit curve starts fully
smooth.

### ROI export format — `rois.json`

Per-hemisphere **subject** vertex indices, an ordered boundary ring, a label vertex,
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
outline ring; a `bezier` from an earlier build (no `smooth`) is treated as all-smooth. Sulci never
appear in this file; it is an ROI format.

### Sulcus export format — `sulci.svg`

Sulci are **not** exported as JSON. **Export sulci (SVG)** downloads a standalone SVG whose `sulci`
layer is exactly the layer pycortex's `cortex/svgoverlay.py` reads — no roidraw-specific format
involved.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     version="1.1" width="1024" height="768" viewBox="0 0 1024 768">
  <g inkscape:groupmode="layer" id="sulci" inkscape:label="sulci" style="display:inline">
    <g inkscape:groupmode="layer" id="sulci_shapes" inkscape:label="shapes">
      <g inkscape:groupmode="layer" inkscape:label="CS">
        <path style="fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6;stroke-linecap:round"
              d="M412.55,301.90C…" />   <!-- left hemisphere -->
        <path style="fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6;stroke-linecap:round"
              d="M598.31,297.44C…" />   <!-- right hemisphere -->
      </g>
    </g>
    <g inkscape:groupmode="layer" id="sulci_labels" inkscape:label="labels" />
  </g>
</svg>
```

#### Installing it into a subject

> **Copy the `<g inkscape:label="…">` groups out of `#sulci_shapes` and into the subject's
> *existing* `#sulci_shapes` group.**

Do **not** paste the whole `<g id="sulci">` layer. `SVGOverlay` keys its layers by
`inkscape:label`, so a second layer labelled `sulci` silently replaces the subject's own — every
sulcus already in that file disappears. The downloaded file repeats this warning in an XML comment.

Then `db.get_overlay(subject)` exposes the new curves under `svg.sulci`, and
`quickflat.make_figure(…, with_sulci=True)`, the WebGL viewer, and Inkscape all render them.

#### Why the file looks the way it does

- **The paths never close.** A missing trailing `Z` is the *only* on-disk marker separating a sulcus
  from an ROI in `overlays.svg` — both are `fill:none`.
- **Same-named sulci merge into one group.** Trace a sulcus on each hemisphere and give both strokes
  the same name; they become one `<g inkscape:label="CS">` with a `<path>` child each, exactly as
  pycortex's own `CaS` is stored. Duplicate names are the intended workflow, not a mistake.
- **Sulci carry no vertex membership.** pycortex stores none either — there is no `get_sulci_verts`;
  sulci are display geometry.
- **The `labels` layer is present and empty, and that is deliberate.** pycortex computes each
  sulcus's label position from its path geometry at load (`Shape.get_labelpos`, one label per path,
  so a two-hemisphere sulcus is labelled twice for free) and writes `data-ptidx` itself from that
  position. `data-ptidx` is pycortex's *output*, not its input: a real `overlays.svg` contains zero
  `<text>` elements, and `Labels.__init__` reads `float(text.get('x'))` off every `<text>` it finds,
  so a label carrying only a vertex index would make `db.get_overlay()` raise `TypeError`. The empty
  layer itself is mandatory — `_find_layer(layer, "labels")` raises `ValueError` without it.
  (roidraw's *live, in-browser* overlay does place labels by `data-ptidx`; that is the WebGL viewer's
  own convention, and it stops at the browser.)
- **The on-disk `style` is for Inkscape's benefit only.** pycortex overwrites every path's style at
  load from `[overlay_paths]`, and `quickflat` re-applies `[sulci_paths]` at render time.

Export is one-way: sulci are not re-imported from SVG.

---

## Architecture

Three layers; only the adapter knows the host viewer.

```
core/      pure JS — no DOM, no THREE, no host globals (unit-tested under node)
  geom.js        point-in-polygon, bounds, RDP simplify, Chaikin smooth, ndc↔pixel, centroid
  selection.js   projected vertices + polygon → selected vertex set (works in px OR uv)
  outline.js     polygon → ordered boundary ring of vertices (+ label vertex)
  bezier.js      fit an editable bezier — closed (ROI ring) or open (sulcus trace) — sample it,
                 edit it; owns the segment topology (segCount/segControls/minAnchors) that the
                 samplers, the editor and the adapter's path writer all read
  transform.js   uv↔px homography (place/grab edit knots; map a traced stroke back to uv)
  shape-model.js the shape collection (ROIs + sulci), default names, the vertexset-v2 ROI export/import
  svg-export.js  pure writer for pycortex overlays.svg sulci markup (paths only, never labels)
  draw-mode.js   the flat-only Draw state machine (the "reached flat" latch) + the MODE names
  timer-set.js   tracked setTimeouts that one destroy() cancels (controller + adapter share it)

adapter/   the ViewerAdapter CONTRACT + one host implementation
  viewer-adapter.js     documented interface the core/ui depend on, + uvPxCorrespondences()
                        (the one place projectVerticesInUvBounds is flattened for a homography fit)
  pycortex-adapter.js   the ONLY file that touches pycortex internals

ui/        host-agnostic DOM components (talk only to core + adapter)
  overlay-canvas.js  base class: the transparent canvas over the surface (size/position sync,
                     event→px, teardown) that both overlays below extend
  lasso-overlay.js  bezier-edit-overlay.js  draw-panel.js  mode-toggle.js  roidraw.css
  overlay-geom.js   pure hit-testing math for the edit overlay (no DOM; unit-tested)
  dom-utils.js      isTextEntry(): the one "is the user typing?" rule every key handler uses

draw-pipeline.js  ROI: lasso → select → fit bezier → re-derive membership.
                  Sulcus: trace → px→uv via homography → fit open bezier → label vertex
                  (the label is for the live overlay only; the export carries none).
                  (pure; uses core + an adapter)
index.js          controller wiring core + adapter + ui; exposes window.ROIDraw
build.mjs         esbuild → dist/roidraw.bundle.js (CSS inlined)
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
npm install        # one-time (esbuild + eslint)
npm run build      # -> dist/roidraw.bundle.js
```

## Testing

```bash
npm test           # lints, builds the bundle, then runs the JS suite (node) + Python tooling tests
npm run lint       # eslint alone (eslint.config.js: recommended rules + this repo's conventions)
```

The JS suite layers property-based geometry invariants (closed *and* open curves), the Draw-mode
state machine, the draw pipeline (driven headless against a synthetic-surface adapter), the pure
`overlays.svg` writer, the edit-overlay hit-testing, the bezier segment-topology agreement between
the samplers/editor/adapter path writer, an adapter-contract guard, a host preflight, and a smoke
test of the built bundle. CI (`.github/workflows/test.yml`) runs it on every push. See
[TESTING.md](TESTING.md) for what each layer guarantees — and the gaps (live-browser integration)
it can't.

### Conventions

- **JS**: ES modules, `const`/`let`, 4-space indent, double quotes, semicolons; `camelCase` for
  functions and variables, `UPPER_SNAKE` for module constants, a leading `_` for private methods
  and for deliberately unused parameters. A file starts with a block comment saying what it owns
  and what it must not know about. `npm run lint` enforces the mechanical part.
- **Python** (`bake.py`, `examples/`, `test/test_*.py`): PEP 8, stdlib only, `unittest`, the same
  4-space/snake_case conventions as pycortex itself.
- **One definition per rule.** Anything two code paths must agree on — the bezier's segment
  topology, the overlay's coordinate mapping, the "is the user typing?" test, default shape names,
  the timer bookkeeping — lives in exactly one module and is imported from there (see the
  Architecture notes above). If you find the same rule restated in two places, that is the bug.

## Requirements

- **Node** ≥ 18 to build/test the JS.
- **Python 3** for `bake.py` (stdlib only). The dynamic example
  (`examples/make_viewer.py`) additionally needs **pycortex** (Python ≤ 3.12) in `.venv`.

## Not here

General pycortex viewer-maintenance tooling (`reengine.py`, `fixups.py`, `add_help.py`,
`convert_huth.py`) once lived here and was moved out in July 2026 to a separate tooling repository
(`jackgallant/pycortex-viewer-tools`, currently private). This repo is the ROI/sulcus-drawing
project only; `bake.py` stays because it injects the drawing bundle.
