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

8. ✅ **Export sulci (SVG).** Click **Export sulci (SVG)**. Confirm it downloads `sulci.svg`
   containing exactly one `<g inkscape:label="CS">` group, with **two** `<path>` elements inside it
   (one per hemisphere), and that no path's `d` attribute ends in `Z`. Check mechanically:

   ```bash
   grep -o 'd="[^"]*"' ~/Downloads/sulci.svg | grep -c 'Z"'
   ```

   Expected output: `0`.

   *(Verified against the live overlay: `exportSulciMarkup` emitted 3 non-closing paths, merged both
   `CS` curves into one group, XML-escaped a hostile name, and used exactly
   `fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6;stroke-linecap:round`. The download
   itself — the `Blob`/anchor path — was not exercised.)*

9. ⬜ **Round-trip into pycortex.** Paste (or merge) the `sulci.svg` fragment into the subject's
   `overlays.svg` and confirm `db.get_overlay(subject)` parses it (the sulci appear under
   `svg.sulci`) and `cortex.quickflat.make_figure(..., with_sulci=True)` (or the WebGL viewer's sulci
   overlay) renders the traced sulci correctly — open strokes, correct name, correct position.
   **This is the single most important unverified step**: nothing has ever fed roidraw's output to
   `cortex/svgoverlay.py`'s parser.

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
- Step 8 failing points at `core/svg-export.js` — but note its unit tests (`test/svg-export.test.js`)
  already pin the no-`Z`, one-group-per-name, and escaping behaviors, so a failure here more likely
  means the adapter/controller wiring (`adapter/pycortex-adapter.js`'s `exportSulciMarkup`, or the
  controller's `exportSulciSVG()`) isn't calling the writer correctly.
- Step 9 failing points at a mismatch between roidraw's curated `SULCI_PATH_STYLE` subset and what
  `cortex/svgoverlay.py` expects on load — this path has never been run in CI (see `TESTING.md`).
