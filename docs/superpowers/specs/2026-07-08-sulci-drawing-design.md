# Drawing sulci — design

_2026-07-08_

## Goal

Let a roidraw user draw **sulci** in addition to ROIs, and store them the way pycortex already
stores sulci: as open, unfilled cubic-bezier `<path>` elements in an `overlays.svg` layer,
carrying no vertex data.

## Background: how pycortex stores sulci

Established by reading `/Users/gallant/CLAUDE/PYCORTEX/pycortex-src`:

- `cortex/svgoverlay.py` has **no `Sulci` class and no `ROI` class**. A layer is a generic
  `Overlay`; "sulci" and "rois" differ only by the string they are keyed by. Default layers come
  from a plain list: `for layer in ['sulci', 'cutouts', 'display']`.
- Structure on disk (`filestore/db/S1/overlays.svg`):
  `<g id="sulci" inkscape:label="sulci">` → `<g id="sulci_shapes">` → one
  `<g inkscape:label="CaS">` per named sulcus → one or more `<path>`.
- **Sulci paths are open**: no trailing `z`. All 53 ROI paths close; no sulcus path does.
- Styling is config-driven, `cortex/defaults.cfg`:

  ```ini
  [rois_paths]           [sulci_paths]
  stroke = white         stroke = white
  fill = none            fill = none
  stroke-width = 2       stroke-width = 6
  stroke-opacity = 1     stroke-opacity = 0.6
  fill-opacity = 0       fill-opacity = 0
  (no linecap)           stroke-linecap = round
  ```

  (Abridged — each section has ten keys.) Both are `fill:none`. The substantive differences
  between an ROI path and a sulcus path are the trailing `z`, the stroke width, the stroke
  opacity, and `stroke-linecap: round` — which `[rois_paths]` lacks entirely. The linecap is not
  incidental: a sulcus is an *open* stroke, so its end caps are visible geometry.

  Note the style in the file itself is nearly irrelevant. `Overlay.set()` re-applies
  `[sulci_paths]` from config over every path at load, and the `S1/overlays.svg` fixture's own
  sulcus paths carry whatever Inkscape wrote (`stroke:#000000`, `1px`, `butt` caps). So the
  on-disk style governs raw/Inkscape rendering only.
- **Sulci carry no vertex data.** There is no `get_sulci_verts`. `get_roi_verts` →
  `svg.rois.get_mask(name)` → matplotlib point-in-*closed*-polygon, hard-coded to the `rois`
  layer. Sulci are consumed only by renderers (`quickflat.composite.add_sulci`, the WebGL
  `overlays_visible` list).
- The **only** path→vertex mapping in pycortex is `SVGOverlay.set_coords`, which builds a
  cKDTree over flat vertex coords and writes `data-ptidx` onto **label text elements** only.
- A named sulcus commonly has **two disjoint `<path>` children** under one `inkscape:label` —
  one per hemisphere (e.g. `CaS` has `path3451` and `path3453`).

## Key decisions

1. **Storage is pycortex-native.** Sulci are stored and exported as `overlays.svg` markup, not
   as a roidraw JSON format. `quickflat.add_sulci`, the WebGL viewer, and Inkscape read the
   output natively.

2. **ROIs are untouched.** They keep the closed bezier, the enclosed-vertex `vertexset-v2`
   JSON, and the existing export. No format bump, no migration; v1/v2 files keep importing.

3. **Duplicate names are allowed and are the intended workflow.** Users trace a named sulcus
   sequentially — left hemisphere, then right — as two separate curves given the same name. On
   export, same-named sulci merge into a single `<g inkscape:label="NAME">` with one `<path>`
   child per curve. This reproduces pycortex's own two-sub-path convention. Names are therefore
   **not** unique keys; the internal `id` remains the unique key.

4. **The bezier is the source of truth**, as it already is for ROIs. Because sulci store no
   vertex membership, there is no re-derivation step and no consistency risk between a curve
   and a derived vertex set — the entire class of bug that `deriveRoiFromLasso`'s
   zero-enclosure guard exists to handle simply does not arise.

5. **Gyri are out of scope.** Considered and rejected: pycortex models no gyri anywhere (no
   layer, class, config section, or storage; the word appears only as anatomical prose in
   docstrings). A `gyri` layer would be an invention that no pycortex tool reads. Recorded so
   the question is not reopened without new motivation.

## Data model

`core/roi-model.js` (`ROISet`) becomes a shape collection. Each shape gains a `kind`:

```js
kind: "roi" | "sulcus"
```

| field       | roi                          | sulcus |
|-------------|------------------------------|--------|
| `id`        | unique int                   | unique int |
| `name`      | user string (unique-ish)     | user string, **duplicates expected** |
| `color`     | palette                      | palette |
| `bezier`    | `{closed:true, …}`           | `{closed:false, …}` |
| `left`/`right` | enclosed subject vertices | — (absent) |
| `outline`   | ordered closed vertex ring   | — (absent) |
| `labelVert` | `{h,g}` centroid-nearest     | `{h,g}` nearest the curve's parametric midpoint |

`labelVert` exists for sulci solely to place the `data-ptidx` text sprite — the one path→vertex
mapping pycortex sanctions (`set_coords`). It is not a claim about membership.

The `<g id="sulci_labels">` group is empty in pycortex's own fixture, but the group exists and
`Overlay` reads it, so emitting labels there is host-native, not an extension.

## Core geometry (`core/bezier.js`)

Add open-curve analogues; share everything else. An open bezier over `n` anchors has `n-1`
segments (closed has `n`).

- `catmullRomHandles` must not wrap modulo `n` for open curves. Interior anchors keep the
  uniform Catmull-Rom tangent `(next - prev)/6`. Endpoints get a one-sided tangent:
  `outHandles[0] = a0 + (a1 - a0)/3`, `inHandles[n-1] = a_{n-1} - (a_{n-1} - a_{n-2})/3`.
  The unused endpoint handles (`inHandles[0]`, `outHandles[n-1]`) are set to their anchor.
- `fitOpenBezier(polyline, {epsilon})` — **no `rotateToExtreme`.** That helper exists only
  because RDP pins its endpoints and a closed ring's seam is arbitrary. On an open polyline,
  pinning the endpoints is exactly correct. Minimum 2 anchors.
- `evalOpenBezier(bez, samplesPerSeg)` — samples segments `0..n-2`, and appends the final
  anchor (an open curve's last point is not the next segment's start).
- `nearestOnOpenBezier(bez, pt, samplesPerSeg)` — same as the closed version over `n-1` segments.
- `segControls(anchors, in, out, i)` takes the `closed` flag: `j = closed ? (i+1)%n : i+1`.
- `cloneBezier` preserves `closed` (already reads `bez.closed !== false`).
- `moveAnchor` — unchanged.
- `moveHandle` — unchanged (mirroring is a per-anchor property).
- `setAnchorSmooth` — for an **endpoint** of an open curve there is no `prev`/`next` pair to
  derive a tangent from. Endpoints are always corners; `setAnchorSmooth` is a no-op on them
  and the edit overlay renders a single handle.
- `splitSegment(bez, seg, t)` — `seg` in `[0, n-2]` when open.
- `deleteAnchor(bez, i)` — floor is **2** anchors when open (3 when closed).

## Drawing

`ui/lasso-overlay.js` gains a **trace** mode. It already captures a freehand drag; trace mode
differs only in that it does not close the stroke and the pipeline never calls
`selectInPolygon`.

New pipeline function in `draw-pipeline.js`:

```
curveFromTrace(adapter, pts) -> { bezier, labelVert } | null
```

The stroke arrives in screen px and must be stored in view-independent flat-uv. **No new adapter
method is required**: `core/transform.js` already fits a homography between uv and px at the
current flat view, exactly as `ui/bezier-edit-overlay.js` does it — `fitHomography(src, dst)`
over the `(uv, px)` correspondences from the adapter's existing `projectVerticesInUvBounds`,
then `invertHomography` to map px → uv. At full flat the flatmap is one plane, so the homography
is exact.

So: stroke px → uv (via `Hinv`) → `fitOpenBezier` → the curve's parametric midpoint →
`nearestVertexTo(adapter, uv)` for the label.

`nearestVertexTo(adapter, uv) -> {h, g} | null` is a **pure helper in `draw-pipeline.js`**, a
brute-force nearest scan over `adapter.allVertexUV()`. This mirrors how the existing
`backfillLabel` already works (it scans `adapter.vertexUV` over a ring) and is the
generalization of pycortex's `set_coords` KD-tree lookup. Brute force is fine: it runs once per
drawn curve, not per frame. Keeping it out of the adapter means `ViewerAdapter.REQUIRED` and
`test/fake-adapter.js` are untouched.

`curveFromTrace` returns `null` if the homography cannot be fit (degenerate/collinear view) or
if fewer than 2 distinct uv points survive; the controller aborts the add with a message,
mirroring the existing `0 vertices selected` path.

## Rendering (`adapter/pycortex-adapter.js`)

`_bezierSvgPath(bez, W, H)` branches on `bez.closed`:

- **closed** (today's behavior): `M …` then `n` `C` segments wrapping to anchor 0, then `Z`.
- **open**: `M …` then `n-1` `C` segments, **no `Z`**.

The uv → viewBox mapping `uv → (u*W, (1-v)*H)` is unchanged — it already *is* pycortex's
overlay coordinate space, so nothing needs converting.

Live rendering keeps the **single** roidraw-owned `drawnrois` display layer that
`setOverlayLayer` already creates; shapes of both kinds live in it, styled per shape. Only
*export* emits a `sulci` layer. This keeps teardown, visibility toggling, and the label-sprite
lifecycle exactly as they are today.

`setOverlayLayer` picks stroke weights per kind:

| kind   | stroke-width | stroke-opacity | closes with `Z` |
|--------|--------------|----------------|-----------------|
| roi    | `OUTLINE_STROKE_PX` (3, existing) | 1 | yes |
| sulcus | `CURVE_STROKE_PX` (6, from `[sulci_paths]`) | 0.6 | no |

The existing white halo under the colored stroke is retained for both kinds; it keeps a curve
legible over colored data. The halo is a roidraw rendering choice and does **not** appear in the
exported markup, which uses pycortex's own `[sulci_paths]` styling.

## Editing

`ui/bezier-edit-overlay.js` and `ui/overlay-geom.js` work almost unchanged once the geometry
functions accept `closed:false` — anchor drag, handle drag, insert-on-double-click, delete, and
corner/smooth toggle all carry over. Endpoints show one handle instead of two, and are always
corners (see `setAnchorSmooth` above).

## Closed-shape assumptions that must be updated

Audited by reading the tree; each of these hard-codes a closed ring today.

| site | assumption | change |
|------|-----------|--------|
| `core/bezier.js` `evalClosedBezier`, `nearestOnClosedBezier` | `anchors.length < 3` → bail; `(i+1)%n` wrap | dispatch on `bez.closed` |
| `core/bezier.js` `deleteAnchor` | floor of 3 | floor of 2 when open |
| `core/bezier.js` `fitClosedBezier` | `rotateToExtreme`, dedupe seam | not applied to open fits |
| `ui/bezier-edit-overlay.js:116` | `_uvPoly` built only when `anchors.length >= 3` | `>= 2` for open |
| `ui/bezier-edit-overlay.js` | calls `nearestOnClosedBezier` directly | dispatch on `closed` |
| `adapter/…:_bezierSvgPath` | always wraps to anchor 0, always appends `Z` | branch on `closed` |
| `adapter/…:_roiSvgPath` | `outline.length < 3` fallback path | sulci have no `outline`; bezier-only |
| `ui/draw-panel.js:118` | row count is `r.left.length + r.right.length` | sulci have no `left`/`right` — show anchor count instead |
| `ui/draw-panel.js:126` | edit enabled iff `r.bezier` | unchanged (sulci always have one) |
| `index.js:_applyEdit` | re-derives vertices via `roiFromBezier` | skip for sulci; store the bezier only |
| `index.js:exportJSON` | guards on `this.rois.length` | must count ROIs specifically, not all shapes |
| `index.js:_finishLasso` | aborts on `0 vertices selected` | trace has its own abort condition |
| `core/roi-model.js` `loadJSON` | every entry becomes an ROI | tag imported entries `kind:"roi"` |

## UI

`ui/draw-panel.js` gains a two-way **kind selector** at the top of the panel — a segmented
control, `ROI | Sulcus` — that sets the active draw tool. It drives one thing:

- **ROI** → `LassoOverlay` in lasso mode → `deriveRoiFromLasso` (closed, selects vertices).
- **Sulcus** → `LassoOverlay` in trace mode → `curveFromTrace` (open, no selection).

The shape list becomes a single list showing both kinds, each row prefixed by a kind glyph so a
`CS` sulcus and a `CS` ROI are distinguishable. Rows keep the existing color swatch, edit
button, and delete button. The count column shows enclosed-vertex count for ROIs and anchor
count for sulci.

The status line already branches on mode; it gains a trace-mode string
("Drag along the sulcus · ✎ to edit · scroll to zoom · Shift+drag to pan").

Drawing stays **flat-only** for both kinds — `DrawModeMachine` is unchanged, and the homography
that `curveFromTrace` depends on is only valid at full flat.

## Export

Two separate outputs, because they are two genuinely different formats:

- **`Export ROIs (JSON)`** — unchanged `vertexset-v2`, emitted only when ROIs exist.
- **`Export sulci (SVG)`** — an `overlays.svg`-compatible fragment, emitted only when sulci
  exist.

The SVG fragment groups sulci by `name`:

```xml
<g inkscape:groupmode="layer" id="sulci" inkscape:label="sulci" style="display:inline">
  <g inkscape:groupmode="layer" id="sulci_shapes" inkscape:label="shapes">
    <g inkscape:groupmode="layer" inkscape:label="CS">
      <path style="fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6;stroke-linecap:round" d="M … C …"/>
      <path style="fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6;stroke-linecap:round" d="M … C …"/>
    </g>
  </g>
  <g inkscape:groupmode="layer" id="sulci_labels" inkscape:label="labels">
    <text data-ptidx="12345" …>CS</text>
  </g>
</g>
```

Two `<path>` children under one `inkscape:label="CS"` is precisely how `CaS` appears in
pycortex's own `S1/overlays.svg`.

Coordinates are viewBox px, the space `_bezierSvgPath` already emits. Names go through XML
text-escaping (a name is user input and lands in both an attribute and a text node).

**Merging into a subject's `overlays.svg` is out of scope for the browser bundle** — that needs
a Python-side round-trip. The fragment is designed to be pasted or merged by a short script.

## Non-goals

- **Gyri.** See decision 5.
- Editing the subject's *existing* pycortex sulci (the live viewer already loads them into
  `svgo.sulci`; adopting them into roidraw's editable model is a separate feature).
- Importing sulci back from SVG. Export is one-way for now.
- Any vertex membership, mask, or ribbon for sulci. Deliberately excluded: a radius in flat-uv
  units does not correspond to a constant amount of cortex (flattening distortion — cf.
  `examples/surface_analyses/plot_tissots_indicatrix.py`). Doing it honestly requires geodesic
  distance on the fiducial surface, which the adapter does not expose.

## Testing

Follows the project's existing test-first practice (see `TESTING.md`).

- `test/bezier.test.js` — open fit/eval/nearest; `n-1` segments; endpoint handle derivation;
  `deleteAnchor` floor of 2; `splitSegment` bounds; `setAnchorSmooth` no-op on endpoints;
  `cloneBezier` round-trips `closed:false`.
- `test/properties.test.js` — extend the seeded-random invariants: an open fit's first and last
  anchors equal the polyline's endpoints (RDP pins them); `evalOpenBezier` starts at anchor 0
  and ends at anchor `n-1`; edit ops preserve `closed`.
- `test/draw-pipeline.test.js` — `curveFromTrace` against the existing `FakeSurfaceAdapter`
  (whose projection is a real rotation+offset, so the homography round-trip is a genuine test):
  a traced stroke round-trips px → uv → px within tolerance; returns `null` on a degenerate
  (single-point or collinear) stroke; `nearestVertexTo` returns the analytically nearest vertex.
- `test/adapter-contract.test.js` — unchanged. No adapter method is added, so the contract and
  `test/fake-adapter.js` are untouched. Stated explicitly because an earlier draft of this design
  added `nearestVertexAt` to `ViewerAdapter.REQUIRED`; it does not.
- New `test/svg-export.test.js` — pure export function, no DOM: open paths carry **no** `Z`;
  closed paths do; same-named sulci merge into one `<g>` with one `<path>` each; a name
  containing `&`/`<`/`"` is escaped in both the attribute and the text node.

## Risks

- **Open-curve edit UX at endpoints** is the fiddliest part (one handle, always a corner). It
  is also the part unit tests cover least, since the edit overlay is browser code. The existing
  honest gap in `TESTING.md` applies.
- **`OUTLINE_STROKE_PX` is 3**, not the `rois_paths` value of 2. That is a pre-existing roidraw
  rendering choice; this design does not change it, and takes `defaults.cfg` values only for the
  *sulcal* weights. Noted so the mismatch is not later read as a bug.
- **Duplicate names weaken the panel.** Two rows both reading `CS` are only distinguishable by
  position and anchor count. This is the accepted cost of the sequential both-hemispheres
  workflow. Mitigation: the panel row keeps its per-shape color swatch, and the edit highlight
  disambiguates which one is selected.
- **The homography is only valid at full flat.** `curveFromTrace` runs on a strictly flat
  surface (drawing is flat-only, enforced by `DrawModeMachine`), so this holds — but it is a
  precondition, not an invariant of the function.
