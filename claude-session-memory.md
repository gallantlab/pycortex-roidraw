# Claude session memory — pycortex-roidraw

_Current status file. Most recent session at top._

## 2026-07-02 — Full-project code review → 4 fixes (v0.3.4); release + demo re-bake PENDING (auth-blocked)

User asked for a full code review (accuracy/bugs/edge cases/style/clarity/efficiency), then "do 1
through 4", then to update the example viewer and "push it all", then "clean". Read the whole tree
(core / adapter / ui / controller / Python tooling); **no correctness blockers** — the code is
already well-audited. Surfaced 6 findings; the user took the top 4 and I implemented them test-first
where headless-testable. Suite **93→94** JS tests (all green), Python suites green.

**Fixes landed (commit `7d4e847`, pushed to `main`):**
- **#1 Colored ROI outlines.** The palette `color` was stored/exported and shown as a panel swatch
  but the baked outline was hard-coded white (`stroke:#ffffff`) — swatch meant nothing on the
  surface. Adapter now strokes each ROI in its color over a **white halo** (new `OUTLINE_HALO_PX`),
  kept legible on data + anatomy. Imported colors pass through a new hex-only `safeColor()` before
  entering the SVG `style` attr (injection-safe). Updated `setOverlayLayer` JSDoc + README ("white
  outline"→colored). NOTE: color is **machine-assigned** by creation order (`nextColor()` cycles an
  8-entry PALETTE by `(nextId-1)%8`); there is **no color picker** — user only gets prompted for a
  name. Possible follow-up the user flagged interest in: an `<input type=color>` in the panel row.
- **#2 Bezier/vertex consistency.** `deriveRoiFromLasso` no longer attaches a fitted bezier when
  re-derivation from it encloses 0 vertices (would leave the source-of-truth curve disagreeing with
  the fallback lasso vertices). New headless test (`draw-pipeline.test.js`) forces the fallback via a
  starved adapter + asserts the normal-case equality; fails against old code.
- **#3 Display-mode framing.** `_onMix` now auto-frames only while `mode==="draw"` — unfolding in
  Display no longer fights the user's zoom/pan every morph frame (Draw's flatten glide still frames).
- **#4 `_worldOf` hardening.** Applies the `flatoff` y-offset to our own `this._v` instead of
  mutating `get_position().pos` (may be a shared/cached vector in mriview).
- Declined #5 (`ndcToPixel` dead in prod — only tests use it; adapter has its own `_ndc`) and #6
  (mode-toggle lacks `aria-pressed`; `add_help.bound_keys` regex is broad) as low-value.

**v0.3.4:** package.json bumped 0.3.3→0.3.4; bundle rebuilt = **94,844 B**, SHA-256
`f3c070dce309f6aade95ac8cd5cabd6e3455a5597860eee4cbcbfd66024c9d53`, `node --check` clean. (Bundle is
version-independent — build.mjs embeds no version.) The repo's own example `examples/make_viewer.py`
needs NO edit — it copies the current `dist/` bundle at run time, so rebuilding already updates it.

**OPEN / next time — release + demo re-bake NOT done (auth-blocked):**
The auto-mode permission classifier **denied `gh release create`** ("push it all" authorized the code
push but not publishing a release, since the release-first question went unanswered). The demo re-bake
(clone + push to the public `viewer-stories-group-roidraw`) would hit the same wall, so I stopped.
As of this "clean": **`/releases/latest` is still v0.3.3** and the **demo viewer is still on the
v0.3.3 bundle** — both LAG the pushed `main` (v0.3.4 source). To finish, the user runs (via `!` or
after adding a `gh`/`git` permission rule and telling me to retry):
- `gh release create v0.3.4 dist/roidraw.bundle.js --repo gallantlab/pycortex-roidraw --title v0.3.4 --notes "..."`
- clone `gallantlab/viewer-stories-group-roidraw`, `cp` the bundle (verify SHA == `f3c070…c9d53` for
  byte-identical), commit + push its `main`. (Bundle sits next to `viewer.html` there.)
Detect v0.3.4 via positive marker `safeColor` / `OUTLINE_HALO` in the bundle.

## 2026-06-29 (cont.) — Adversarial audit + fixes (Tiers 1–4) + documentation audit (80→93 tests)

User asked for a full adversarial readability/best-practices audit ("be mean, be neurotic"), then
fixes, then a doc audit. Ran 4 parallel review agents (core / adapter+pipeline / ui+controller /
tests+hygiene); verified every load-bearing finding against source myself before acting. Verdict:
pure `core/` is excellent; the gaps were the 575-line adapter, UI lifecycle, and false-confidence in
the tests I'd just written. **No correctness blockers.** All work test-first, behavior-preserving
except where noted. Suite 80→93.

Fixes landed (uncommitted until this "clean"; one commit on top of `359073b`):
- **Tier 1 (footguns + my own errors):** `subsample`→`targetSamples` in measureFrame (it's a count,
  not a stride — opposite of projectVertices); `DEFAULT_EPSILON`→`UV_RDP_EPSILON`/`PIXEL_RDP_EPSILON`
  (same name, 1000× apart); `cloneBezier` now PADS a short `smooth` (was truncate-only); `preflightHost`
  now checks BOTH hemis' position AND uv; CI `npm install`→`npm ci`+cache (a lockfile IS committed —
  my earlier comment was false).
- **Tier 2 (lifecycle/a11y/errors):** `destroy()` on ROIDrawer + DrawPanel + ModeToggle (overlays
  already had it); stored the anonymous blur listener; `autoAttach` disposes a prior instance; delete
  control `<a>`→`<button>`+aria-label (+CSS reset)+`type=button`; `reader.onerror`; empty-name falls
  back to default; one-shot breadcrumbs in the silent adapter catches.
- **Tier 3 (test false-confidence):** FakeSurfaceAdapter now uses a REAL rotation+offset projection
  (not px==uv·scale) + disjoint-uv hemispheres; selection property uses an INDEPENDENT rectangle
  oracle (not its own pointInPolygon); `pretest:js` (no stale bundle, single build); explicit
  `ViewerAdapter.REQUIRED` + a drift cross-check (replaced fragile `.toString().includes`).
- **Tier 4 (items 1–4, user-chosen from a ranked menu):** named magic numbers/strings (adapter
  `DEFAULT_THICKMIX`/`FALLBACK_TEX_*`/`OUTLINE_STROKE_PX`/`LABEL_FONT_PT`; edit-overlay `COLOR`
  palette+radii+`now()`; lasso color; `MODE` consts; transform epsilons; tagged measureFrame/
  animateCamera host-only); `segControls()` dedup in bezier; `loadJSON` defensive-copy+`startsWith`+
  shorthand; **unified label heuristic** — loadJSON now purely structural, controller back-fills a
  missing label via new `backfillLabel()` (centroid-nearest, same rule as fresh ROIs); **extracted
  pure hit-testing** to new `ui/overlay-geom.js` (`nearestWithin`/`hitTest`, 7 tests) — the edit
  overlay delegates, killing the `_hitTest`/`_hitTestAnchorOnly` dup. Declined #5–#8 (UI-plumbing
  dedup, adapter per-hemi loop, jsdom, adapter split) as churn-over-value on untested browser code;
  skipped the shared HEMIS const (cross-module coupling > the duplication).
- **Doc audit:** README architecture block missing the 3 new files (draw-mode, draw-pipeline,
  overlay-geom) — added. TESTING.md said "via pretest" (→pretest:js) and "cross-checked against
  point-in-polygon" (→ independent oracle — was the OPPOSITE of the real test). In-code: viewer-adapter
  projectVertices "view-framing"→selection-only; geom simplifyRDP "px"→unit-agnostic; two stale
  `_roiFromBezier` test comments → `roiFromBezier`; preflight "every internal"→"core internals".

New files: `core/draw-mode.js` (earlier), `draw-pipeline.js` (earlier), `ui/overlay-geom.js`,
`test/overlay-geom.test.js`. Behavior changes worth noting: empty-name fallback, stricter preflight,
unified label, cloneBezier pad. Audit-fix commit `0aec331`.

**Released v0.3.3** (commit `19cb8d0`, tag + GitHub release, `/releases/latest` → v0.3.3, asset
94,012 B) so the audit fixes ship. **Example viewer re-baked to v0.3.3** —
`gallantlab/viewer-stories-group-roidraw` commit `e2a2726abb`: swapped in the v0.3.3 bundle
(byte-identical to the release asset, verified; viewer.html overlay fix intact). All three artifacts
aligned again: roidraw `/releases/latest`=v0.3.3, example viewer=v0.3.3, pycortex docs auto-track
`/releases/latest`. (Detect v0.3.3 via positive marker `backfillLabel`.)

## 2026-06-29 — Test hardening: "is it doing what we think?" → provably so (45→80 JS tests)

User worried the package might not do what we think; asked what tests/checks would make it provably
correct. Diagnosis: the pure `core/` geometry was well covered, but the ~888 LOC bridging to reality
(adapter + controller) had **zero** tests — exactly where silent breakage hides. Did it all test-first
(TDD skill), behavior-preserving. **No real bugs found** — the one property-test counterexample was a
test-fidelity issue (fed buildOutline pixel-scale inputs where it wants uv-scale), not a code defect.

What landed (all green: 80 JS tests + Python tooling; `npm test` now builds first via `pretest`):
- **`core/draw-mode.js`** — extracted the flat-only Draw latch (`_sawFlatInDraw`) into a pure
  `DrawModeMachine`; `index.js` delegates to it. The glide-doesn't-bounce-out vs.
  inflate-after-flat-exits logic is now provable in isolation (`test/draw-mode.test.js`).
- **`draw-pipeline.js`** — extracted the lasso→select→fit→re-derive pipeline (`deriveRoiFromLasso`,
  `roiFromBezier`, `backfillBezier`) out of the controller; `index.js` delegates. Tested headless
  against **`test/fake-adapter.js`** (a `ViewerAdapter` over a synthetic analytic grid) — asserts it
  selects exactly the enclosed vertices (`test/draw-pipeline.test.js`).
- **`test/properties.test.js`** — 7 property-based invariants over 300 seeded-random cases each
  (lossless round-trip, seam-independent fit, no bezier blow-up, selection == point-in-polygon truth,
  ring ⊆ selection, deterministic curve→membership, H∘H⁻¹ = id). Hand-rolled mulberry32 PRNG (no deps).
- **`preflightHost()`** in pycortex-adapter.js — replaced 3 ad-hoc constructor throws with one
  comprehensive, **testable** check that names exactly which pycortex internal is missing, so drift
  fails loudly not silently (`test/host-preflight.test.js`).
- **`test/adapter-contract.test.js`** — reflection guard: both PycortexAdapter and the fake must
  implement the whole ViewerAdapter contract (catches "extended the interface, forgot an adapter").
- **`test/bundle.test.js`** — loads the built `dist/roidraw.bundle.js` in a vm sandbox, asserts
  `window.ROIDraw.{attach,autoAttach,…}` + inlined CSS. Catches a broken/half-built release artifact.
- **`.github/workflows/test.yml`** — CI runs the whole suite on every push/PR (nothing ran before).
- **`TESTING.md`** (+ README pointer) — documents each layer's guarantee AND the honest gap.

The honest gap: unit tests can't prove the adapter talks to a LIVE pycortex viewer (its spec is
pycortex internals we don't own). Mitigated by `preflightHost()` + the browser-verified demo viewer.
Recommended closer (documented, not yet wired): a Playwright headless smoke against a checked-in
viewer fixture. Commits: `4c3f53e` (suite) + `6b14cb0` (v0.3.2 bump).

**Released v0.3.2** (tag + GitHub release, `/releases/latest` → v0.3.2, asset 89,140 B). Refactor is
behavior-identical to v0.3.1; released anyway so the distributed asset tracks the CI-tested source
(no stale-bundle drift). Principle established with user: keep distributed artifacts in lockstep with
tested source rather than letting them drift.

**Demo viewer re-baked to v0.3.2** — `gallantlab/viewer-stories-group-roidraw` commit `8adf85dc69`:
swapped in the v0.3.2 bundle (byte-identical to the release asset, SHA verified; viewer.html overlay
fix untouched). All three artifacts now aligned: roidraw `/releases/latest`=v0.3.2, demo viewer=v0.3.2,
pycortex docs auto-track `/releases/latest`. Detection note: v0.3.2 EXTRACTED the `_sawFlatInDraw`
latch into DrawModeMachine, so that old marker is gone — verify v0.3.2 via positive markers
`DrawModeMachine` / `deriveRoiFromLasso` / `preflightHost` instead.

## 2026-06-25 (later) — Refresh the dormant demo viewer to latest-and-greatest

Follow-up: confirmed the dormant demo at **`gallantlab/viewer-stories-group-roidraw`**
(the repo we'd browser-tested against) was **stale** — last pushed 2026-06-01, baked with
**roidraw v0.3.0** (86,728 B, no `_sawFlatInDraw`/`_flattenForDraw`) and **no overlay race
fix** (`_updateGen` guard absent). The earlier "fix" we tested was only a *scratchpad*
working-tree patch, never committed to that repo.

Refreshed it for real:
- Dropped in the canonical **v0.3.1** `roidraw.bundle.js` (87,359 B, byte-identical to
  `/releases/latest` asset; `node --check` clean).
- Applied the overlay/label texture-bake race fix to its inline `viewer.html` JS (surgical
  +34/−9: generation guard ×2 + `Labels` EventDispatcher/redraw wiring + surf
  `update`→schedule). Same patch the user browser-verified.
- Committed **`3659d6ad6f`** and **pushed to `main`**; verified live via GitHub raw
  (`_updateGen`×2 in viewer.html, `_sawFlatInDraw`×4 in bundle).
- Re-served locally (localhost:8911) for a final browser check — user confirmed "looks good".
- Repo is **already PUBLIC** (`isPrivate:false`) — no visibility change needed.
- Note: this viewer is a self-contained static file → **pinned to v0.3.1** (does NOT track
  `/releases/latest` like the pycortex docs do). Future roidraw releases need a re-bake here.
- Repo **description updated** (was "Private demo …", contradictory once public) →
  "Public demo: gallantlab group stories viewer + in-browser ROI drawing
  (pycortex-roidraw v0.3.1)".

## 2026-06-25 — Public release, core-docs PR, overlay-race fix, Draw-mode UX (v0.3.1)

**Goal:** make `pycortex-roidraw` available to outside users; document it in core
pycortex; fix a WebGL overlay/label texture-bake race; refine Draw-mode UX. All one day.

### pycortex-roidraw repo (this repo)
- Added **`LICENSE`** (BSD 2-Clause, matching pycortex; copyright "2026, The Regents
  of the University of California (Gallant Lab)") and `"license": "BSD-2-Clause"` in
  `package.json`. Repo was previously unlicensed.
- Updated README install step to link the GitHub **release** asset instead of a
  non-existent committed bundle.
- Verified green before shipping: `npm run build` OK; **JS 45/45**, **Python 56 tests** OK.
- Flipped the GitHub repo from **PRIVATE → PUBLIC**.
- Cut release **`v0.3.0`** with `roidraw.bundle.js` (86,728 bytes) attached as the
  download asset. `releases/latest` resolves to v0.3.0.
- Commit `0b135db` pushed to `main`.
- Decision: kept `"private": true` in package.json. roidraw is distributed as a
  prebuilt browser bundle via GitHub release, NOT as an npm package — `npm publish`
  is not needed. Only revisit if a JS dev wants to `import` it as a library.
- Note: `dist/` stays gitignored; the **release asset is the distribution**. Future
  JS changes need `npm run build` + a new tagged release for users to get them.
- **v0.3.1** (commit `4a01cdc`, release published, `/releases/latest` → v0.3.1):
  Draw-mode UX in `index.js` — (1) inflating the surface while in Draw returns to
  Display (drawing is flat-only); (2) clicking an ROI's ✎ edit re-flattens if inflated.
  Both via a `_flattenForDraw()` helper + a `_sawFlatInDraw` latch that ignores the
  transient non-flat mix events during Draw's own flatten glide (so selecting Draw
  doesn't bounce out). README updated. Interaction note: because (1) keeps Draw flat,
  (2)'s re-flatten is usually a no-op — flagged to user, who confirmed "looks good".

### Core pycortex docs (separate repo: /Users/gallant/CLAUDE/pycortex-src)
- Added **`docs/roidraw.rst`** — "In-browser ROI drawing" page (concise + link-out
  to the roidraw repo/README; avoids cross-repo doc drift).
- Wired into `docs/index.rst` toctree after `rois`; added `.. seealso::` cross-links
  in `docs/rois.rst` and `docs/userguide/webgl.rst`.
- Key framing: a `.. note::` states roidraw is a **separate repo** and its JSON
  vertex-set output is **independent of the Inkscape ROI-mask system** (`get_roi_masks`
  does not read it) — so users don't assume they're interchangeable.
- Hit a Sphinx simple-table parse error (2nd-column separator 74 chars but a cell was
  75); widened separators to 76 and verified.
- Shipped as **PR #652** against `gallantlab/pycortex`, **merged** (squash) to `main`
  at `2cc73098`; `build-docs` check passed; PR branch auto-deleted.

### WebGL overlay/label texture-bake race fix (pycortex-src) — MERGED (PR #653)
Investigated the long-suspected overlay-toggle bug. History: fixes #643 (race guard) +
#644 (redraw-on-bake) were merged then **both reverted** (#645/#646) because #644 caused
**black-square labels** on load. Root cause confirmed in live code — THREE intertwined
async bugs:
1. `SVGOverlay.update()` bakes the overlay texture async with **no sequencing guard** →
   rapid toggles resolve out of order → stale overlay.
2. `addSurf` never wired `surf "update" → Viewer.schedule()` → a toggle isn't drawn
   until next interaction.
3. `Labels.set_tex` built the glyph texture from a **not-yet-loaded image** (empty GPU
   upload → black squares) with no redraw on load — this is what broke #644.
**Complete fix** on branch **`claude/overlay-bake-race-fix`** (commit `3ee0bbd3`):
generation guard + `surf "update"→schedule` + `Labels.set_tex` waits for `img.onload`
then signals redraw via `this.surf.dispatchEvent({type:"update"})` (routed through the
surface's own update, NOT the overlay-texture path, so it doesn't clobber
`uniforms.overlay.value`; no `mriview_surface.js` change needed). `node --check` passes.
**Browser-verified** by the user against a patched copy of the real
`viewer-stories-group-roidraw` (drawing viewer baked w/ roidraw bundle) — looked good.
**Shipped as PR #653, merged (squash) to `main` at `8f021cab`; branch auto-deleted.**
Note: repo has NO required status checks, so `gh pr merge --auto` merges immediately
(this is why #652/#653 landed on the spot, not after CI).

### Branch tidy (pycortex-src)
- Deleted merged `claude/document-roidraw`, and the now-redundant `claude/revert-overlay-guard`
  + `claude/revert-overlay-redraw` (their reverts already on `main` via #645/#646).
- Kept the two original-fix branches `claude/overlay-toggle-race` +
  `claude/overlay-redraw-on-update` (source of fix parts 1 & 2) and the new
  `claude/overlay-bake-race-fix` (the complete fix).

### Open / next time
- Nothing outstanding — public release, docs PR (#652), and overlay fix (#653) all merged.
- pycortex docs site will surface the new roidraw page on its next build/deploy.
- Docs link to roidraw `/releases/latest`, so users always get newest; remember to cut a
  new GitHub release (build + tag) whenever the roidraw JS changes, else the link lags.
- If roidraw JS changes: rebuild + cut a new release so `/releases/latest` updates.
- Browser-test scaffolding was in the session scratchpad (1.5 GB viewer clone +
  localhost:8911 server) — disposable, cleaned at session end.
