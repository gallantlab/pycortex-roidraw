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

### Sulcus SVG export — unit (pure writer) + a real XML parser
`core/svg-export.js` is the pure writer for the sulci layer of an `overlays.svg`.

`test/svg-export.test.js` pins the writer's decisions by string: a sulcus path never closes with a
trailing `Z` (the only on-disk marker separating a sulcus from an ROI); curves that share a name
merge into a single `<g inkscape:label="…">` rather than colliding, exactly as pycortex's own
multi-hemisphere `CaS` does; names are XML-escaped; the labels layer exists and holds no `<text>`.

**String tests were not enough, and had already shipped a broken file.** Every assertion above
passes against a bare fragment that uses the `inkscape:` prefix with no namespace declaration —
which no XML parser will open. So `test/test_sulci_svg.py` generates the writer's real output with
node and parses it with Python's ElementTree, using `cortex/svgoverlay.py`'s own namespaces and
`findall` queries. It asserts the document parses, that `_find_layer` locates the `sulci` layer and
both its sublayers, that same-named curves round-trip through the parser as one group of two paths,
that no `d` closes, and that the labels layer holds no `<text>` — because `Labels.__init__` reads
`float(text.get('x'))` off every `<text>` it finds, so a label carrying only a vertex index makes
`db.get_overlay(subject)` raise `TypeError`. It needs neither pycortex nor a subject, so it runs in
CI. It is the closest thing to the round-trip below that can be automated here.

### Draw-mode state machine — unit (the flat-only latch)
`core/draw-mode.js` (`test/draw-mode.test.js`) is the extracted pure state machine behind Draw mode.
Its job is the subtle bit: the flatten **glide** emits many non-flat frames on its way to flat, and
those must not bounce the user out of Draw — but a genuine inflate *after* reaching flat must. That
logic is now provable in isolation instead of only eyeballed in a browser.

### Draw pipeline — headless against a synthetic surface
`draw-pipeline.js` (`test/draw-pipeline.test.js`) is driven against `test/fake-adapter.js` (a
`ViewerAdapter` over a known grid). The fake projects uv→px through a real rotation+offset (not
`px == uv·scale`) and puts the two hemispheres in disjoint uv bands, so the px→uv round-trip and
hemisphere separation are actually exercised. Because the grid's geometry is analytic, the tests
assert real properties rather than tautologies — no browser, no pycortex:

- the **ROI** path (lasso → select → fit → re-derive) selects exactly the enclosed vertices, fits an
  editable bezier, and re-derives identical membership;
- the **sulcus** path (`curveFromTrace`) round-trips a stroke px→uv through the fitted homography
  back onto the uv points it was drawn through, and returns `null` on a degenerate stroke or a
  collinear/unfittable view;
- `labelForCurve` picks the vertex nearest the curve's midpoint, and picks a *different* vertex for
  a translated curve — the guard that a reshaped sulcus relabels instead of stranding its
  `data-ptidx` at the original midpoint.

### Edit-op index guards — unit
All five edit ops (`moveAnchor`, `moveHandle`, `setAnchorSmooth`, `splitSegment`, `deleteAnchor`)
share one contract, pinned in `test/bezier.test.js`: an out-of-range anchor or segment index is a
no-op returning an unchanged copy. Nothing throws, nothing half-applies, and the four parallel
arrays keep the same length.

The edit overlay holds drag, hover, and selection targets across pointer events, so an anchor list
that shrinks under one (Delete pressed mid-drag) leaves a stale index behind. Writing through it
used to append past the end of the handle arrays, silently desynchronizing their lengths from
`anchors`. The ops used to *disagree* about this — two refused, two threw a `TypeError`, and
`setAnchorSmooth` on a closed curve grew `smooth[]` past `anchors[]` with holes in it — which meant
each caller had to know which op it was calling. The test now sweeps every op × every bad index.

The overlay separately drops its drag and hover targets whenever the anchor count changes, which is
the only place that can catch the other half of that bug — a stale index that is still *in range*
names a different anchor, and no pure function can tell.

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
  into one `<g inkscape:label="CS">` with a `<path>` each; a hostile name XML-escaped; style exactly
  `fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6;stroke-linecap:round`. (That run predates
  the export rewrite: it saw the old bare fragment, `<text data-ptidx>` labels and all. Re-run it.)
- No sulcus leaks into the `vertexset-v2` JSON, and its `format` string is unchanged.

### What roidraw writes, and how far it has been read back

Worth stating plainly, because it is easy to mistake the property tests for end-to-end coverage.
The two export formats have *different* gaps.

**`sulci.svg` has a foreign consumer.** The whole point of matching pycortex's format is that
`cortex/svgoverlay.py`, `quickflat`, the WebGL viewer, and Inkscape read it.

- *Covered:* `test/test_sulci_svg.py` parses the real output with an XML parser and reproduces
  `svgoverlay.py`'s layer/shape/label queries against it (see above). This closed three defects that
  the string-matching tests could not see: an undeclared `inkscape:` namespace prefix (nothing would
  parse the file), `<text data-ptidx>` labels with no `x`/`y` (`db.get_overlay()` raised `TypeError`
  on them), and the absence of the mandatory-but-empty `labels` layer.
- *Still open:* `svgoverlay.py` itself has never run on it. Merging the shape groups into a real
  subject's `overlays.svg`, confirming `db.get_overlay()` exposes them under `svg.sulci`, and
  rendering with `quickflat.make_figure(…, with_sulci=True)` needs a subject and an importable
  `cortex` — neither is available here.

**`rois.json` has no foreign consumer at all.** `pycortex-roidraw/vertexset-v2` is a roidraw-native
format; no Python reader exists here or in pycortex, deliberately (`get_roi_masks` does not read
it). So "read it back" can only mean re-importing into roidraw. The **format** round-trip is
strong — `test/properties.test.js` runs `toJSON` → `JSON.stringify` → `JSON.parse` → `loadJSON`
over 300 seeded trials and compares vertices, outline, label, and bezier — and `loadJSON`'s deep
copy is pinned in `test/shape-model.test.js` (an imported bezier is mutated in place by the edit
overlay; aliasing the parsed document would let an edit reach back into it). But the README's
"re-imports in any viewer on the same surface" has never been demonstrated across two viewers or
against real surface data.

Still open, in both directions:

- The browser **`_import`** path — `FileReader`, the empty-file guard, `reader.onerror`,
  `backfillBezier`/`backfillLabel` for v1 files, `_sync`, the panel refresh — has **zero** coverage.
  No test touches `FileReader` or `_import`, and the live-viewer check called `toJSON` only, never
  `loadJSON`.
- Both **download** paths (`Blob` → anchor → `revokeObjectURL`), for JSON and for SVG. The 4000 ms
  deferred teardown exists because Firefox otherwise writes a 0-byte file — and is untested.
- The exported `sulci.svg` fragment has never been round-tripped through pycortex's
  `svgoverlay.py` parser (see above).
- `index.js` has no unit harness. The `labelForCurve` regression guard (a reshaped sulcus must
  relabel) sits on the pure helper in `draw-pipeline.js`, not on `_applyEdit`'s sulcus branch that
  calls it.
- The `ui/` overlays have no headless test. The interactive gestures — dragging a trace, the
  single handle at an open curve's endpoints, the absent closing chord in the edit preview — were
  never exercised programmatically; only `test/bundle.test.js` catches build breakage.
