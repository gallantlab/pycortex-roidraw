# Testing & correctness

`npm test` builds the bundle (via `pretest:js`) and runs the JS suite (`node --test`) plus the Python
tooling tests. CI runs the same on every push/PR to `main` (`.github/workflows/test.yml`).

The suite is layered by how strong a guarantee each layer can give.

## What's covered

### Pure geometry — property-based (near-proof)
`test/properties.test.js` checks invariants over hundreds of seeded-random inputs (a counterexample
prints the seed and reproduces deterministically):

- export/import is lossless (vertices, outline, label, **and** the editable bezier);
- the bezier fit is independent of where the boundary ring starts;
- a sampled bezier never escapes the bbox of its control points (no blow-up);
- selection selects **exactly** the vertices a polygon encloses (graded against an *independent*
  rectangle oracle, not the impl's own point-in-polygon);
- the boundary ring is always a subset of the selection;
- membership re-derived from a curve is deterministic — *what you see is what you get*;
- a homography composed with its inverse is the identity;
- `core/bezier.js`'s **open**-curve invariants: `fitOpenBezier` pins the traced endpoints, an open
  curve's endpoints stay corners (never smooth) through a fit and through any single edit
  (move/smooth-toggle/delete/split), and `isClosed` reports `false` throughout — a sulcus can never
  silently acquire a closing segment.

The example-based core tests (`geom`, `selection`, `bezier`, `transform`, `shape-model`, `outline`,
`uv-membership`) remain as targeted cases.

### Sulcus SVG export — unit (pure writer)
`core/svg-export.js` (`test/svg-export.test.js`) is the pure writer for the `overlays.svg`-compatible
sulci fragment. It guarantees: a sulcus path never closes with a trailing `Z` (the only on-disk
marker separating a sulcus from an ROI); curves that share a name merge into a single
`<g inkscape:label="…">` rather than colliding, exactly as pycortex's own multi-hemisphere `CaS`
does; and names are XML-escaped before landing in an attribute or a text node.

### Draw-mode state machine — unit (the flat-only latch)
`core/draw-mode.js` (`test/draw-mode.test.js`) is the extracted pure state machine behind Draw mode.
Its job is the subtle bit: the flatten **glide** emits many non-flat frames on its way to flat, and
those must not bounce the user out of Draw — but a genuine inflate *after* reaching flat must. That
logic is now provable in isolation instead of only eyeballed in a browser.

### Draw pipeline — headless against a synthetic surface
`draw-pipeline.js` (`test/draw-pipeline.test.js`) is the lasso → select → fit → re-derive pipeline,
driven against `test/fake-adapter.js` (a `ViewerAdapter` over a known grid). The fake projects uv→px
through a real rotation+offset (not `px == uv·scale`) and puts the two hemispheres in disjoint uv
bands, so the px→uv round-trip and hemisphere separation are actually exercised. Because the grid's
geometry is analytic, the tests assert the pipeline selects exactly the enclosed vertices, fits an
editable bezier, and re-derives identical membership — no browser, no pycortex.

### Edit-overlay hit-testing — unit (pure helpers)
`ui/overlay-geom.js` (`test/overlay-geom.test.js`) holds the grab-an-anchor / grab-a-handle math the
edit overlay delegates to, so the hit-testing is testable without a canvas.

### Adapter contract + host preflight — drift guards
- `test/adapter-contract.test.js` asserts both the real `PycortexAdapter` and the fake implement the
  whole `ViewerAdapter` contract, so adding a contract method can't silently leave one adapter behind.
- `preflightHost()` (`test/host-preflight.test.js`) inspects the host for the core pycortex internals
  the adapter needs (THREE, `mriview.get_position`, the surface + pivots, and **both** hemispheres'
  `position` and `uv` geometry, svgoverlay) and, at attach time, throws a **loud, specific** error
  naming what's missing — so if pycortex drifts (renamed `get_position`, restructured surface), users
  get a clear message instead of silent wrongness.

### Distributed bundle — smoke
`test/bundle.test.js` loads the freshly built `dist/roidraw.bundle.js` in a sandbox and asserts it
exposes `window.ROIDraw.{attach,autoAttach,…}` with its CSS inlined. A broken/half-built bundle —
exactly what a release would ship — fails here, not in someone's browser.

## The remaining gap (and why)

The one thing unit tests **cannot** prove is that `PycortexAdapter` talks correctly to a *live*
pycortex viewer — its correctness is defined by pycortex/THREE internals we don't control. Two things
mitigate this today:

1. **`preflightHost()`** converts integration breakage into a clear runtime error.
2. The public demo viewer (`gallantlab/viewer-stories-group-roidraw`) is a real baked viewer that was
   manually browser-verified.

The strongest closer would be a **headless-browser smoke test** (Playwright): load a real baked
viewer, `autoAttach`, dispatch a synthetic lasso, click Export, assert non-empty JSON of the right
shape — run in CI against a pinned viewer fixture. That needs a checked-in viewer fixture + a browser
in CI, so it's deliberately *not* wired into `npm test` yet; it's the recommended next step for true
end-to-end coverage.

Sulcus drawing adds gaps of the same kind. Some were closed by a one-off browser check against the
live `viewer-stories-group-roidraw` viewer, driven over the Chrome DevTools Protocol (2026-07-09).
That check is **not in CI** — it needs a baked static viewer, which this repo does not carry.

Closed by that check, against a real pycortex viewer:

- `adapter/pycortex-adapter.js`'s open-curve rendering. With three sulci and one ROI in the model,
  `setOverlayLayer` produced 8 `<path>` elements (halo + stroke per shape): the 6 sulcal ones carry
  no trailing `Z`, the 2 ROI ones do.
- `exportSulciMarkup` on the live overlay: 3 paths, none closing; two same-named `CS` curves merged
  into one `<g inkscape:label="CS">` with a `<path>` each; a hostile name XML-escaped in both the
  attribute and the text node; style exactly
  `fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6;stroke-linecap:round`.
- No sulcus leaks into the `vertexset-v2` JSON, and its `format` string is unchanged.

Still open:

- The exported `sulci.svg` fragment has never been round-tripped through pycortex's
  `svgoverlay.py` parser. Loading it into a real subject's `overlays.svg` and rendering with
  `quickflat` is still a manual check.
- `index.js` has no unit harness. The `labelForCurve` regression guard (a reshaped sulcus must
  relabel) sits on the pure helper in `draw-pipeline.js`, not on `_applyEdit`'s sulcus branch that
  calls it.
- The `ui/` overlays have no headless test. The interactive gestures — dragging a trace, the
  single handle at an open curve's endpoints, the absent closing chord in the edit preview — were
  never exercised programmatically; only `test/bundle.test.js` catches build breakage.
