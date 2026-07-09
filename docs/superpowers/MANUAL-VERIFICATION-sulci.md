# Manual verification: sulcus drawing (v0.4.0)

Sulcus drawing cannot be exercised headlessly — `adapter/pycortex-adapter.js` talks to pycortex/THREE
internals that only exist in a live viewer, and this environment has no `cortex` install and no
subject data to bake one. Everything below was verified structurally (unit tests, direct function
extraction) but **not** against a real pycortex viewer. Run this checklist by hand before shipping
v0.4.0, and before cutting the GitHub release / re-baking the demo viewer.

## Setup

```bash
npm run build
python3 -m http.server 8911 --directory examples
# or: .venv/bin/python examples/make_viewer.py   (needs pycortex + a subject)
```

Open the viewer, switch to **Draw** mode.

## Checklist

1. **Kind selector present.** The draw panel shows an `ROI | Sulcus` selector, with `ROI`
   preselected.

2. **No ROI regression.** With `ROI` selected, drag a lasso. Confirm it still produces a closed,
   filled-outline ROI, and the panel row shows a vertex count.

3. **Sulcus is open.** Switch the selector to `Sulcus` and drag a stroke along a sulcus. Confirm the
   result is an **open** curve — the two ends must **not** be visually joined (no closing segment
   between the last point and the first).

4. **Stroke weight.** Confirm the sulcus renders visibly heavier (thicker stroke) than an ROI
   outline.

5. **Edit mode on a sulcus.** Click **✎ edit** on the sulcus. Confirm:
   - Anchors appear along the curve.
   - Each of the two endpoints shows **exactly one** handle (not two) and both are draggable.
   - Dragging a handle bends the preview curve, and the preview never shows a closing chord between
     the two endpoints.

6. **Reshaping relabels.** While editing, drag an anchor to noticeably reshape the sulcus. Confirm
   the name label (baked onto the surface) follows the curve to its new position rather than staying
   at the old label vertex.

7. **Duplicate names are allowed.** Trace a second stroke on the other hemisphere and name it `CS`
   (same name as the first sulcus). Confirm the panel shows **two** rows named `CS` and no error is
   raised.

8. **Export sulci (SVG).** Click **Export sulci (SVG)**. Confirm it downloads `sulci.svg` containing
   exactly one `<g inkscape:label="CS">` group, with **two** `<path>` elements inside it (one per
   hemisphere), and that no path's `d` attribute ends in `Z`. Check mechanically:

   ```bash
   grep -o 'd="[^"]*"' ~/Downloads/sulci.svg | grep -c 'Z"'
   ```

   Expected output: `0`.

9. **Round-trip into pycortex.** Paste (or merge) the `sulci.svg` fragment into the subject's
   `overlays.svg` and confirm `cortex.quickflat.make_figure(..., with_sulci=True)` (or the WebGL
   viewer's sulci overlay) renders the traced sulci correctly — open strokes, correct name, correct
   position.

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
