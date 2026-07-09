# Manual verification: sulcus drawing (v0.4.0)

`adapter/pycortex-adapter.js` talks to pycortex/THREE internals that only exist in a live viewer, so
it has no CI coverage. On **2026-07-09** a subset of this checklist was run against a real baked
viewer (`gallantlab/viewer-stories-group-roidraw`, served locally and driven over the Chrome
DevTools Protocol). What that run established is marked ✅ below. That check is **not** in CI — this
repo carries no baked viewer — so re-run this list by hand before cutting the GitHub release and
re-baking the demo viewer.

Every step still involving a real pointer gesture (marked ⬜) remains unverified: the CDP run drove
controller *state*, never a synthesized mouse drag.

## Setup

```bash
npm run build
# Serve a viewer that already has the bundle baked in, e.g. a clone of
# gallantlab/viewer-stories-group-roidraw with dist/roidraw.bundle.js copied over its own:
python3 -m http.server 8911 --directory path/to/viewer
# or generate one: .venv/bin/python examples/make_viewer.py   (needs pycortex + a subject)
```

Open the viewer, switch to **Draw** mode.

## Checklist

1. ✅ **Kind selector present.** The draw panel shows an `ROI | Sulcus` selector, with `ROI`
   preselected. *(Verified: panel, segmented control, and both export buttons present after
   `autoAttach`.)*

2. ⬜ **No ROI regression.** With `ROI` selected, drag a lasso. Confirm it still produces a closed,
   filled-outline ROI, and the panel row shows a vertex count. *(The closed-path rendering is
   verified — an ROI's baked `<path>` ends in `Z` — but the lasso gesture itself is not.)*

3. ⬜ **Sulcus is open.** Switch the selector to `Sulcus` and drag a stroke along a sulcus. Confirm
   the result is an **open** curve — the two ends must **not** be visually joined. *(Rendering
   verified: sulcal `<path>` elements carry no trailing `Z`. The trace gesture is not.)*

4. ⬜ **Stroke weight.** Confirm the sulcus renders visibly heavier (thicker stroke) than an ROI
   outline.

5. ⬜ **Edit mode on a sulcus.** Click **✎ edit** on the sulcus. Confirm:
   - Anchors appear along the curve.
   - Each of the two endpoints shows **exactly one** handle (not two) and both are draggable.
   - Dragging a handle bends the preview curve, and the preview never shows a closing chord between
     the two endpoints.

6. ⬜ **Reshaping relabels.** While editing, drag an anchor to noticeably reshape the sulcus. Confirm
   the name label (baked onto the surface) follows the curve rather than staying at the old label
   vertex. *(`labelForCurve` is unit-tested; `_applyEdit`'s call site is not.)*

7. ✅ **Duplicate names are allowed.** Trace a second stroke on the other hemisphere and name it `CS`
   (same name as the first sulcus). Confirm the panel shows **two** rows named `CS` and no error is
   raised. *(Verified: two same-named sulci coexist in the model and merge on export.)*

8. ⬜ **Export sulci (SVG).** Click **Export sulci (SVG)**. Confirm it downloads `sulci.svg`, and
   check it mechanically — this is the whole file's structure in one command:

   ```bash
   python3 -c '
   import xml.etree.ElementTree as ET
   S, I = "http://www.w3.org/2000/svg", "http://www.inkscape.org/namespaces/inkscape"
   r = ET.parse("'"$HOME"'/Downloads/sulci.svg").getroot()      # 1. it must PARSE
   g = [l for l in r.findall(f"{{{S}}}g[@{{{I}}}label]") if l.get(f"{{{I}}}label")=="sulci"][0]
   shapes = [l for l in g.findall(f"{{{S}}}g[@{{{I}}}label]") if l.get(f"{{{I}}}label")=="shapes"][0]
   labels = [l for l in g.findall(f"{{{S}}}g[@{{{I}}}label]") if l.get(f"{{{I}}}label")=="labels"][0]
   assert list(labels) == [], "labels layer must be EMPTY"    # 2. else db.get_overlay() raises
   for p in r.iter(f"{{{S}}}path"):
       assert not p.get("d").strip().endswith(("Z","z")), "a sulcus path must stay open"
   print({gg.get(f"{{{I}}}label"): len(gg.findall(f"{{{S}}}path")) for gg in shapes})
   '
   ```

   Expected: `{'CS': 2}` — one group named `CS`, one `<path>` per hemisphere. (`test/test_sulci_svg.py`
   asserts all of this against the writer's output in CI; what this step adds is that the *download*
   produced that output as a real file. The `Blob`/anchor path has never been exercised.)

9. ⬜ **Round-trip into pycortex.** **Copy the `<g inkscape:label="CS">` group** out of the exported
   file's `#sulci_shapes` and into the subject's **existing** `#sulci_shapes` group in
   `overlays.svg`. (Do *not* paste the whole `<g id="sulci">` layer — `SVGOverlay` keys layers by
   `inkscape:label`, so a second one named `sulci` replaces the subject's own and every pre-existing
   sulcus vanishes.) Then confirm `db.get_overlay(subject)` parses it (the sulci appear under
   `svg.sulci`) and `cortex.quickflat.make_figure(..., with_sulci=True)` (or the WebGL viewer's sulci
   overlay) renders the traced sulci correctly — open strokes, correct name, correct position.
   Confirm pycortex **generates** the labels itself, one per path.
   **This is the single most important unverified step**: `cortex/svgoverlay.py`'s parser has never
   run on roidraw's output. `test/test_sulci_svg.py` reproduces that parser's *queries* against an
   XML parser, which is as close as CI can get without a subject.

10. ⬜ **ROI round-trip through a real file.** The ROI side has never been read back either — the
    format round-trip is proven in `test/properties.test.js` (300 seeded trials through a real
    `JSON.stringify`/`JSON.parse`), but the *browser* import path has zero coverage: no test touches
    `FileReader` or `_import`, and the live-viewer check only called `toJSON`. So:

    - Draw an ROI, click **Export ROIs (JSON)**, and confirm `rois.json` actually downloads and is
      non-empty. (The `Blob` → anchor → `revokeObjectURL` path is untested; its 4000 ms deferred
      teardown exists because Firefox otherwise writes a 0-byte file — **test this in Firefox too**.)
    - **Clear all**, then **Import** that file. Confirm the ROI returns with the same vertex count,
      the same outline, and that **✎ edit** still works (the bezier survived).
    - Repeat with a **v1 file** (one with no `bezier`) if you have one: the importer should back-fill
      a bezier from the outline ring and a label vertex, and the shape should become editable.
    - Do the same for **Export sulci (SVG)** — confirm the download fires and the file is non-empty.

    Note there is no external consumer for `rois.json`: no Python reader exists in roidraw or in
    pycortex, by design (`get_roi_masks` does not read it). Re-importing into roidraw is the only
    round-trip that exists.

## If something fails

- Steps 1–7 failing points at `ui/draw-panel.js`, `ui/lasso-overlay.js`, `ui/bezier-edit-overlay.js`,
  or `index.js`'s `_applyEdit` sulcus branch (see `TESTING.md`'s "honest gaps" — none of these have a
  headless test).
- Step 8 failing points at the adapter/controller wiring — `adapter/pycortex-adapter.js`'s
  `exportSulciMarkup`, or the controller's `exportSulciSVG()`/`_download()`. The writer itself
  (`core/svg-export.js`) is pinned by `test/svg-export.test.js` *and* parsed for real by
  `test/test_sulci_svg.py`, so a structural failure here means the writer wasn't called correctly,
  not that it wrote the wrong thing.
- Step 9 failing points at something `cortex/svgoverlay.py` wants that neither test models. The
  known hazards are already handled: the namespace declarations, the empty-but-present `labels`
  layer, and the absence of `<text>` (pycortex generates labels from path geometry and would raise
  `TypeError` on a `<text>` without `x`/`y`). Style is *not* a hazard — pycortex overwrites every
  path's `style` at load from `[overlay_paths]`, so `SULCI_PATH_STYLE` only affects Inkscape.
