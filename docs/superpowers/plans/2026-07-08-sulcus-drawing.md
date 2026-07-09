# Sulcus Drawing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a roidraw user draw sulci — open, editable bezier curves — alongside ROIs, and export them as pycortex-native `overlays.svg` markup.

**Architecture:** The existing bezier stack is closed-ring only. We generalize it with a `closed` flag rather than forking it: `segControls` takes the flag, `catmullRomHandles` stops wrapping modulo `n`, and every edit op dispatches on it. A sulcus is a `{closed:false}` bezier in flat-UV with **no** vertex membership (matching pycortex, which stores none). The stroke is captured by the existing lasso overlay in a new "trace" mode and mapped px→uv through the homography `core/transform.js` already provides.

**Tech Stack:** Vanilla ES modules, no runtime deps. `node --test` for JS tests. esbuild for the browser bundle.

## Global Constraints

- **No new adapter method.** `ViewerAdapter.REQUIRED` and `test/fake-adapter.js` are untouched. `test/adapter-contract.test.js` must keep passing unchanged.
- **ROIs are untouched.** Closed bezier, enclosed-vertex membership, and the `pycortex-roidraw/vertexset-v2` JSON export all behave exactly as today. No format bump.
- **Sulci carry no vertex membership** — no `left`, `right`, or `outline`. Only `bezier` + `labelVert`.
- **Exported sulcus path style, copied verbatim from `cortex/defaults.cfg` `[sulci_paths]`:** `stroke = white`, `fill = none`, `stroke-width = 6`, `stroke-opacity = 0.6`. (There is **no** `stroke-linecap` in that section — do not add one.)
- **Exported sulcus paths must not end with `Z`/`z`.** That is the single on-disk marker distinguishing a sulcus from an ROI in pycortex.
- **Duplicate sulcus names are legal** and merge into one `<g inkscape:label="NAME">` on export, one `<path>` child per curve.
- **Drawing stays flat-only.** `DrawModeMachine` is unchanged.
- Pure modules (`core/*`, `draw-pipeline.js`) must stay DOM-free and host-free.
- Every commit message ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `core/bezier.js` | Open + closed bezier fit/eval/edit | Modify |
| `core/shape-model.js` | The shape collection (`ShapeSet`), `kind` field, ROI JSON export/import | Create (renamed from `core/roi-model.js`) |
| `core/svg-export.js` | Pure `overlays.svg` fragment writer | Create |
| `draw-pipeline.js` | `curveFromTrace`, `nearestVertexTo` | Modify |
| `adapter/pycortex-adapter.js` | `closed`-aware SVG path + per-kind stroke; `exportSulciMarkup` | Modify |
| `ui/lasso-overlay.js` | Trace mode (open stroke) | Modify |
| `ui/bezier-edit-overlay.js` | Open-curve editing | Modify |
| `ui/draw-panel.js` | Kind selector; mixed shape list | Modify |
| `index.js` | Controller wiring; sulcus export | Modify |

Tests mirror sources: `test/bezier.test.js`, `test/shape-model.test.js`, `test/svg-export.test.js`, `test/draw-pipeline.test.js`, `test/properties.test.js`.

Run the whole JS suite with `npm run test:js` (it builds first via `pretest:js`). A single file: `node --test test/bezier.test.js`.

---

### Task 1: Open-bezier construction and evaluation

**Files:**
- Modify: `core/bezier.js`
- Test: `test/bezier.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isClosed(bez) -> boolean` (`bez.closed !== false`)
  - `segCount(bez) -> number` (`n` if closed, `n-1` if open)
  - `catmullRomHandles(anchors, closed = true) -> {inHandles, outHandles}`
  - `bezierFromAnchors(anchors, closed = true) -> bezier`
  - `fitOpenBezier(polyline, {epsilon}) -> bezier | null`
  - `evalOpenBezier(bez, samplesPerSeg) -> [[x,y],…]`
  - `evalBezier(bez, samplesPerSeg) -> [[x,y],…]` (dispatches on `closed`)

A bezier is `{closed, anchors, inHandles, outHandles, smooth}`. For an **open** curve, `inHandles[0]` and `outHandles[n-1]` are unused and set equal to their anchor, and `smooth[0] === smooth[n-1] === false` (endpoints are always corners — there is no `prev`/`next` pair to derive a symmetric tangent from).

- [ ] **Step 1: Write the failing tests**

Append to `test/bezier.test.js`. Also add the new names to the existing import block at the top of that file.

```js
import {
    fitOpenBezier, evalOpenBezier, evalBezier, isClosed, segCount,
} from "../core/bezier.js";

const line = [[0, 0], [1, 0], [2, 0]];

test("fitOpenBezier: pins both endpoints and stays open", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    assert.strictEqual(bez.closed, false);
    assert.strictEqual(isClosed(bez), false);
    assert.strictEqual(bez.anchors.length, 3);
    assert.ok(ptNear(bez.anchors[0], [0, 0]));
    assert.ok(ptNear(bez.anchors[2], [2, 0]));
});

test("fitOpenBezier: two points are enough (a straight segment)", () => {
    const bez = fitOpenBezier([[0, 0], [3, 0]]);
    assert.strictEqual(bez.anchors.length, 2);
    assert.strictEqual(segCount(bez), 1);
    // endpoint handles lie 1/3 along the segment; the unused ones sit on their anchor
    assert.ok(ptNear(bez.outHandles[0], [1, 0]));
    assert.ok(ptNear(bez.inHandles[1], [2, 0]));
    assert.ok(ptNear(bez.inHandles[0], [0, 0]));
    assert.ok(ptNear(bez.outHandles[1], [3, 0]));
});

test("fitOpenBezier: endpoints are corners, interior anchors are smooth", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    assert.deepStrictEqual(bez.smooth, [false, true, false]);
});

test("fitOpenBezier: collinear-with-tremor simplifies but keeps the ends", () => {
    const bez = fitOpenBezier([[0, 0], [1, 0.0005], [2, 0]], { epsilon: 0.01 });
    assert.strictEqual(bez.anchors.length, 2);
    assert.ok(ptNear(bez.anchors[0], [0, 0]));
    assert.ok(ptNear(bez.anchors[1], [2, 0]));
});

test("fitOpenBezier: rejects fewer than 2 distinct points", () => {
    assert.strictEqual(fitOpenBezier([[1, 1]]), null);
    assert.strictEqual(fitOpenBezier([[1, 1], [1, 1], [1, 1]]), null);
    assert.strictEqual(fitOpenBezier([]), null);
    assert.strictEqual(fitOpenBezier(null), null);
});

test("segCount: open has n-1 segments, closed has n", () => {
    assert.strictEqual(segCount(fitOpenBezier(line)), 1);   // RDP collapses to 2 anchors
    assert.strictEqual(segCount(fitClosedBezier(sq)), 4);
});

test("evalOpenBezier: starts at the first anchor and ends at the last", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    const poly = evalOpenBezier(bez, 8);
    assert.ok(ptNear(poly[0], bez.anchors[0]));
    assert.ok(ptNear(poly[poly.length - 1], bez.anchors[bez.anchors.length - 1]));
    // 2 segments * 8 samples + the final anchor
    assert.strictEqual(poly.length, 2 * 8 + 1);
});

test("evalOpenBezier: a straight fit stays on the line", () => {
    const poly = evalOpenBezier(fitOpenBezier([[0, 0], [3, 0]]), 6);
    for (const p of poly) assert.ok(near(p[1], 0));
});

test("evalOpenBezier: too few anchors yields nothing", () => {
    assert.deepStrictEqual(evalOpenBezier({ closed: false, anchors: [[0, 0]] }, 4), []);
});

test("evalBezier: dispatches on the closed flag", () => {
    const open = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    const closed = fitClosedBezier(sq);
    assert.deepStrictEqual(evalBezier(open, 8), evalOpenBezier(open, 8));
    assert.deepStrictEqual(evalBezier(closed, 8), evalClosedBezier(closed, 8));
});

test("catmullRomHandles: closed still wraps (regression)", () => {
    const { inHandles, outHandles } = catmullRomHandles(sq);
    // anchor 0's tangent uses anchor 3 as prev (the wrap)
    const t = [(sq[1][0] - sq[3][0]) / 6, (sq[1][1] - sq[3][1]) / 6];
    assert.ok(ptNear(outHandles[0], [sq[0][0] + t[0], sq[0][1] + t[1]]));
    assert.ok(ptNear(inHandles[0], [sq[0][0] - t[0], sq[0][1] - t[1]]));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/bezier.test.js`
Expected: FAIL — `SyntaxError: The requested module '../core/bezier.js' does not provide an export named 'fitOpenBezier'`

- [ ] **Step 3: Implement**

In `core/bezier.js`, replace `catmullRomHandles`, `bezierFromAnchors`, and `segControls`, and add the new functions.

```js
/* True unless explicitly opened. A bezier from an older file has no `closed` key. */
export function isClosed(bez) { return !bez || bez.closed !== false; }

/* Number of cubic segments: a closed ring wraps (n), an open curve does not (n-1). */
export function segCount(bez) {
    const n = (bez && bez.anchors) ? bez.anchors.length : 0;
    return isClosed(bez) ? n : Math.max(0, n - 1);
}

/* Catmull-Rom -> cubic-bezier tangent handles. Returns { inHandles, outHandles } parallel to
 * `anchors`. For a CLOSED ring every anchor's handles are mirrored about it, using the wrapped
 * neighbours. For an OPEN curve the endpoints have no neighbour on one side: they get a one-sided
 * tangent (a third of the terminal segment), and their unused handle sits on the anchor itself. */
export function catmullRomHandles(anchors, closed = true) {
    const n = anchors.length;
    const inHandles = new Array(n), outHandles = new Array(n);
    for (let i = 0; i < n; i++) {
        const a = anchors[i];
        if (!closed && n >= 2 && i === 0) {
            const b = anchors[1];
            outHandles[0] = [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3];
            inHandles[0] = [a[0], a[1]];                       // unused
            continue;
        }
        if (!closed && n >= 2 && i === n - 1) {
            const b = anchors[n - 2];
            inHandles[i] = [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3];
            outHandles[i] = [a[0], a[1]];                      // unused
            continue;
        }
        const prev = anchors[(i - 1 + n) % n], next = anchors[(i + 1) % n];
        const tx = (next[0] - prev[0]) / 6, ty = (next[1] - prev[1]) / 6;
        outHandles[i] = [a[0] + tx, a[1] + ty];
        inHandles[i] = [a[0] - tx, a[1] - ty];
    }
    return { inHandles, outHandles };
}

/* Build a bezier descriptor from anchors alone (handles auto-derived). Every anchor of a closed
 * ring is smooth; an open curve's ENDPOINTS are corners (no symmetric tangent exists there). */
export function bezierFromAnchors(anchors, closed = true) {
    const a = anchors.map((p) => [p[0], p[1]]);
    const { inHandles, outHandles } = catmullRomHandles(a, closed);
    const smooth = a.map((_, i) => closed || (i !== 0 && i !== a.length - 1));
    return { closed, anchors: a, inHandles, outHandles, smooth };
}
```

Replace `segControls` (it is used by `evalClosedBezier` and `nearestOnClosedBezier`, which pass `true`):

```js
// The four control points of segment i (anchor i -> anchor i+1):
// [start anchor, its out-handle, the next anchor's in-handle, the next anchor]. A closed ring
// wraps from the last anchor back to the first; an open curve has no such segment.
function segControls(anchors, inHandles, outHandles, i, closed = true) {
    const j = closed ? (i + 1) % anchors.length : i + 1;
    return [anchors[i], outHandles[i], inHandles[j], anchors[j]];
}
```

Add, after `fitClosedBezier`:

```js
/* Drop consecutive duplicate points (a slow drag emits repeats at the same pixel). */
function dedupe(pts) {
    const out = [];
    for (const p of pts) {
        const q = out[out.length - 1];
        if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push([p[0], p[1]]);
    }
    return out;
}

/*
 * Fit an editable OPEN bezier to a traced polyline (e.g. a sulcus stroke mapped to uv).
 * polyline : [[u,v], ...] (>= 2 distinct points). epsilon: RDP tolerance in uv units.
 *
 * No rotateToExtreme here: that exists only because RDP pins its endpoints while a closed ring's
 * seam is arbitrary. On an open polyline pinning the endpoints is exactly what we want — the
 * traced start and end of the sulcus are real, meaningful points.
 */
export function fitOpenBezier(polyline, { epsilon = UV_RDP_EPSILON } = {}) {
    if (!polyline || polyline.length < 2) return null;
    const pts = dedupe(polyline);
    if (pts.length < 2) return null;
    let anchors = simplifyRDP(pts, epsilon);
    if (anchors.length < 2) anchors = pts;          // RDP can't drop an endpoint, but be defensive
    return bezierFromAnchors(anchors, false);
}

/*
 * Sample an OPEN bezier to a polyline. samplesPerSeg points per segment (the segment's start
 * anchor, then interior samples), plus the final anchor — which, unlike a closed ring, is not the
 * next segment's start. Returns [x,y] points; [] if there aren't 2 anchors.
 */
export function evalOpenBezier(bez, samplesPerSeg = 12) {
    if (!bez || !bez.anchors || bez.anchors.length < 2) return [];
    const { anchors, inHandles, outHandles } = bez;
    const n = anchors.length, out = [];
    const steps = Math.max(1, samplesPerSeg | 0);
    for (let i = 0; i < n - 1; i++) {
        const [p0, c1, c2, p3] = segControls(anchors, inHandles, outHandles, i, false);
        for (let s = 0; s < steps; s++) out.push(cubicAt(p0, c1, c2, p3, s / steps));
    }
    out.push([anchors[n - 1][0], anchors[n - 1][1]]);
    return out;
}

/* Sample any bezier, dispatching on its `closed` flag. */
export function evalBezier(bez, samplesPerSeg = 12) {
    return isClosed(bez) ? evalClosedBezier(bez, samplesPerSeg) : evalOpenBezier(bez, samplesPerSeg);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/bezier.test.js`
Expected: PASS, all tests (existing closed-bezier tests included — `catmullRomHandles(anchors)` still defaults to `closed = true`).

- [ ] **Step 5: Commit**

```bash
git add core/bezier.js test/bezier.test.js
git commit -m "Add open-bezier fit and evaluation

Generalize segControls/catmullRomHandles with a `closed` flag rather than
forking the stack. Open endpoints get a one-sided tangent and are corners:
no symmetric tangent exists at a curve's end.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Open-bezier editing operations

**Files:**
- Modify: `core/bezier.js`
- Test: `test/bezier.test.js`

**Interfaces:**
- Consumes: `isClosed`, `segCount`, `bezierFromAnchors` (Task 1).
- Produces:
  - `nearestOnOpenBezier(bez, pt, samplesPerSeg) -> {seg, t, point, dist} | null`
  - `nearestOnBezier(bez, pt, samplesPerSeg)` (dispatches)
  - `cloneBezier` preserves `closed`
  - `deleteAnchor` floor: 3 closed, **2 open**
  - `splitSegment` accepts `seg` in `[0, n-2]` when open
  - `setAnchorSmooth` forces `false` on an open curve's endpoints

- [ ] **Step 1: Write the failing tests**

Append to `test/bezier.test.js`, adding `nearestOnOpenBezier, nearestOnBezier` to the import block.

```js
test("cloneBezier: round-trips an open curve", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    const c = cloneBezier(bez);
    assert.strictEqual(c.closed, false);
    assert.deepStrictEqual(c.anchors, bez.anchors);
    assert.deepStrictEqual(c.smooth, [false, true, false]);
    c.anchors[0][0] = 99;
    assert.strictEqual(bez.anchors[0][0], 0);            // deep copy
});

test("deleteAnchor: open floor is 2, closed floor is 3", () => {
    const open3 = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    const open2 = deleteAnchor(open3, 1);
    assert.strictEqual(open2.anchors.length, 2);
    assert.strictEqual(deleteAnchor(open2, 0).anchors.length, 2);   // refuses below 2

    const tri = fitClosedBezier([[0, 0], [1, 0], [0, 1]]);
    assert.strictEqual(deleteAnchor(tri, 0).anchors.length, 3);     // refuses below 3
});

test("deleteAnchor: removing an open endpoint re-derives nothing (handles kept)", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0], [3, 1]]);
    const d = deleteAnchor(bez, 0);
    assert.strictEqual(d.anchors.length, 3);
    assert.ok(ptNear(d.anchors[0], [1, 1]));
    assert.strictEqual(d.smooth.length, 3);
});

test("setAnchorSmooth: an open curve's endpoints stay corners", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    assert.strictEqual(setAnchorSmooth(bez, 0, true).smooth[0], false);
    assert.strictEqual(setAnchorSmooth(bez, 2, true).smooth[2], false);
});

test("setAnchorSmooth: an open curve's interior anchor still toggles", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    assert.strictEqual(setAnchorSmooth(bez, 1, false).smooth[1], false);
    const s = setAnchorSmooth(setAnchorSmooth(bez, 1, false), 1, true);
    assert.strictEqual(s.smooth[1], true);
    // re-derived symmetric about the anchor
    const a = s.anchors[1];
    assert.ok(ptNear([2 * a[0] - s.outHandles[1][0], 2 * a[1] - s.outHandles[1][1]], s.inHandles[1], 1e-9));
});

test("splitSegment: inserts on an open segment without changing the curve", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    const before = evalOpenBezier(bez, 16);
    const split = splitSegment(bez, 0, 0.5);
    assert.strictEqual(split.anchors.length, 4);
    assert.strictEqual(split.closed, false);
    const after = evalOpenBezier(split, 16);
    assert.ok(ptNear(after[0], before[0], 1e-9));
    assert.ok(ptNear(after[after.length - 1], before[before.length - 1], 1e-9));
});

test("moveAnchor: preserves the open flag", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    assert.strictEqual(moveAnchor(bez, 1, [1, 5]).closed, false);
});

test("nearestOnOpenBezier: finds a point on a straight open curve", () => {
    const bez = fitOpenBezier([[0, 0], [4, 0]]);
    const hit = nearestOnOpenBezier(bez, [2, 1], 32);
    assert.strictEqual(hit.seg, 0);
    assert.ok(near(hit.point[1], 0, 1e-6));
    assert.ok(near(hit.dist, 1, 1e-3));
});

test("nearestOnOpenBezier: never reports the phantom closing segment", () => {
    // an L: the closing segment (end -> start) would pass near [0.2,0.2]; an open curve has none
    const bez = fitOpenBezier([[0, 2], [0, 0], [2, 0]]);
    const hit = nearestOnOpenBezier(bez, [1.6, 1.6], 32);
    assert.ok(hit.dist > 1.0, "expected far from the open curve, got " + hit.dist);
});

test("nearestOnOpenBezier: needs 2 anchors", () => {
    assert.strictEqual(nearestOnOpenBezier({ closed: false, anchors: [[0, 0]] }, [0, 0]), null);
});

test("nearestOnBezier: dispatches on the closed flag", () => {
    const bez = fitOpenBezier([[0, 0], [4, 0]]);
    assert.deepStrictEqual(nearestOnBezier(bez, [2, 1], 32), nearestOnOpenBezier(bez, [2, 1], 32));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/bezier.test.js`
Expected: FAIL — no export named `nearestOnOpenBezier`; and once imported, `deleteAnchor` returns 3 anchors for the open floor-of-2 case.

- [ ] **Step 3: Implement**

In `core/bezier.js`, replace `setAnchorSmooth`, `splitSegment`, `deleteAnchor`, and add the nearest-on-open functions. (`cloneBezier` already reads `bez.closed !== false`, so it needs no change; the tests lock that in.)

```js
/* Set anchor i smooth or corner. An OPEN curve's endpoints have no prev/next pair to build a
 * symmetric tangent from, so they are permanently corners: forcing them smooth is a no-op. */
export function setAnchorSmooth(bez, i, smooth) {
    const b = cloneBezier(bez);
    const n = b.anchors.length;
    const endpoint = !isClosed(b) && (i === 0 || i === n - 1);
    b.smooth[i] = endpoint ? false : !!smooth;
    if (endpoint || !smooth) return b;
    const a = b.anchors[i], prev = b.anchors[(i - 1 + n) % n], next = b.anchors[(i + 1) % n];
    let dir = sub(next, prev);
    let dl = len(dir);
    if (dl < 1e-9) { dir = sub(b.outHandles[i], a); dl = len(dir); }
    if (dl < 1e-9) { dir = [1, 0]; dl = 1; }
    dir = [dir[0] / dl, dir[1] / dl];
    let r = (len(sub(b.outHandles[i], a)) + len(sub(b.inHandles[i], a))) / 2;
    if (r < 1e-9) r = dl / 6;
    b.outHandles[i] = [a[0] + dir[0] * r, a[1] + dir[1] * r];
    b.inHandles[i] = [a[0] - dir[0] * r, a[1] - dir[1] * r];
    return b;
}

/* Insert an anchor on segment `seg` at parameter t in (0,1), splitting the cubic with de Casteljau
 * so the curve shape is UNCHANGED. For an open curve `seg` must be in [0, n-2]. */
export function splitSegment(bez, seg, t) {
    const b = cloneBezier(bez);
    const n = b.anchors.length;
    const j = isClosed(b) ? (seg + 1) % n : seg + 1;
    const p0 = b.anchors[seg], p1 = b.outHandles[seg], p2 = b.inHandles[j], p3 = b.anchors[j];
    const ab = lerp(p0, p1, t), bc = lerp(p1, p2, t), cd = lerp(p2, p3, t);
    const abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t);
    const mid = lerp(abc, bcd, t);
    b.outHandles[seg] = ab;
    b.inHandles[j] = cd;
    b.anchors.splice(seg + 1, 0, mid);
    b.inHandles.splice(seg + 1, 0, abc);
    b.outHandles.splice(seg + 1, 0, bcd);
    b.smooth.splice(seg + 1, 0, true);
    return b;
}

/* Remove anchor i. A closed bezier needs 3 anchors; an open one needs only 2. Returns the input
 * unchanged at the floor. Neighboring handles are left as-is, so the curve reconnects through them. */
export function deleteAnchor(bez, i) {
    const floor = isClosed(bez) ? 3 : 2;
    if (bez.anchors.length <= floor) return bez;
    const b = cloneBezier(bez);
    b.anchors.splice(i, 1);
    b.inHandles.splice(i, 1);
    b.outHandles.splice(i, 1);
    b.smooth.splice(i, 1);
    return b;
}

/* Nearest point on an OPEN bezier to `pt`, by sampling each of its n-1 segments. There is no
 * wrap segment, so a point "inside the elbow" of an L-shaped curve is correctly reported far. */
export function nearestOnOpenBezier(bez, pt, samplesPerSeg = 24) {
    if (!bez || !bez.anchors || bez.anchors.length < 2) return null;
    const { anchors, inHandles, outHandles } = bez;
    const n = anchors.length, steps = Math.max(2, samplesPerSeg | 0);
    let best = null;
    for (let i = 0; i < n - 1; i++) {
        const [p0, c1, c2, p3] = segControls(anchors, inHandles, outHandles, i, false);
        for (let s = 0; s <= steps; s++) {
            const t = s / steps, q = cubicAt(p0, c1, c2, p3, t);
            const dx = q[0] - pt[0], dy = q[1] - pt[1], d = dx * dx + dy * dy;
            if (!best || d < best.d2) best = { seg: i, t, point: q, d2: d };
        }
    }
    return best ? { seg: best.seg, t: best.t, point: best.point, dist: Math.sqrt(best.d2) } : null;
}

/* Nearest point on any bezier, dispatching on its `closed` flag. */
export function nearestOnBezier(bez, pt, samplesPerSeg = 24) {
    return isClosed(bez) ? nearestOnClosedBezier(bez, pt, samplesPerSeg)
                         : nearestOnOpenBezier(bez, pt, samplesPerSeg);
}
```

Also update the `deleteAnchor` doc-comment reference in `evalClosedBezier`'s neighbours if it mentions "needs 3" — the function comments above supersede it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/bezier.test.js`
Expected: PASS. In particular the existing closed-bezier `splitSegment`/`deleteAnchor` tests must still pass — `isClosed()` defaults to `true` for beziers with no `closed` key.

- [ ] **Step 5: Commit**

```bash
git add core/bezier.js test/bezier.test.js
git commit -m "Add open-bezier editing operations

deleteAnchor floors at 2 anchors when open (3 when closed); splitSegment and
nearestOn* skip the wrap segment; setAnchorSmooth is a no-op on an open
curve's endpoints, which have no symmetric tangent.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Open-bezier property invariants

**Files:**
- Modify: `test/properties.test.js`

**Interfaces:**
- Consumes: `fitOpenBezier`, `evalOpenBezier`, `isClosed`, `moveAnchor`, `splitSegment`, `deleteAnchor`, `setAnchorSmooth` (Tasks 1–2).
- Produces: nothing.

Reuse the file's existing helpers rather than defining new ones. **Verified names** (do not invent others): the seeded PRNG factory is `rng(seed)` (a mulberry32, declared around line 24) and the iteration count is `const TRIALS = 300;` (around line 33).

- [ ] **Step 1: Write the failing tests**

Append to `test/properties.test.js`:

```js
// A random open polyline with strictly increasing x, so it never self-touches.
function randomOpenPolyline(rnd, n) {
    const pts = [];
    let x = 0;
    for (let i = 0; i < n; i++) { x += 0.01 + rnd() * 0.05; pts.push([x, rnd()]); }
    return pts;
}

test("property: fitOpenBezier pins the traced endpoints", () => {
    const rnd = rng(0xBEEF);
    for (let c = 0; c < TRIALS; c++) {
        const poly = randomOpenPolyline(rnd, 3 + Math.floor(rnd() * 12));
        const bez = fitOpenBezier(poly);
        assert.ok(bez, "expected a fit");
        assert.deepStrictEqual(bez.anchors[0], poly[0]);
        assert.deepStrictEqual(bez.anchors[bez.anchors.length - 1], poly[poly.length - 1]);
    }
});

test("property: evalOpenBezier runs from the first anchor to the last", () => {
    const rnd = rng(0xF00D);
    for (let c = 0; c < TRIALS; c++) {
        const bez = fitOpenBezier(randomOpenPolyline(rnd, 3 + Math.floor(rnd() * 12)));
        const poly = evalOpenBezier(bez, 8);
        const last = bez.anchors[bez.anchors.length - 1];
        assert.deepStrictEqual(poly[0], bez.anchors[0]);
        assert.deepStrictEqual(poly[poly.length - 1], [last[0], last[1]]);
    }
});

test("property: every edit op preserves the closed flag", () => {
    const rnd = rng(0x1234);
    for (let c = 0; c < TRIALS; c++) {
        const bez = fitOpenBezier(randomOpenPolyline(rnd, 4 + Math.floor(rnd() * 8)));
        const n = bez.anchors.length;
        const i = Math.floor(rnd() * n);
        assert.strictEqual(isClosed(moveAnchor(bez, i, [rnd(), rnd()])), false);
        assert.strictEqual(isClosed(setAnchorSmooth(bez, i, true)), false);
        assert.strictEqual(isClosed(deleteAnchor(bez, i)), false);
        assert.strictEqual(isClosed(splitSegment(bez, Math.floor(rnd() * (n - 1)), 0.5)), false);
    }
});

test("property: an open curve's endpoints are always corners after a fit", () => {
    const rnd = rng(0x5EED);
    for (let c = 0; c < TRIALS; c++) {
        const bez = fitOpenBezier(randomOpenPolyline(rnd, 3 + Math.floor(rnd() * 12)));
        assert.strictEqual(bez.smooth[0], false);
        assert.strictEqual(bez.smooth[bez.smooth.length - 1], false);
    }
});
```

`test/properties.test.js` imports only `fitClosedBezier`/`evalClosedBezier` from `core/bezier.js` today. Extend that import to add exactly: `fitOpenBezier, evalOpenBezier, isClosed, moveAnchor, setAnchorSmooth, deleteAnchor, splitSegment`.

Note `randomOpenPolyline` returns anchors that RDP may thin, but it can never drop an endpoint — that is the property under test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/properties.test.js`
Expected: FAIL — no export named `fitOpenBezier` if Tasks 1–2 were skipped; otherwise PASS (which is the point: these lock in Task 1–2 behavior across 300 seeded cases).

If they pass immediately, that is expected. Confirm they *can* fail by temporarily changing `bezierFromAnchors`' open branch to `smooth = a.map(() => true)`; the endpoint-corner property must go red. Revert.

- [ ] **Step 3: No implementation needed**

These properties describe Task 1–2 code. If any fails, fix `core/bezier.js`, not the test.

- [ ] **Step 4: Run the full suite**

Run: `npm run test:js`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add test/properties.test.js
git commit -m "Add open-bezier property invariants

Endpoints pinned by RDP, eval spans first->last anchor, edit ops preserve
`closed`, and a fresh open fit always has corner endpoints -- each over 300
seeded-random cases.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The shape model — `kind` and `ShapeSet`

**Files:**
- Create: `core/shape-model.js` (via `git mv core/roi-model.js core/shape-model.js`)
- Delete: `core/roi-model.js`
- Create: `test/shape-model.test.js` (via `git mv test/roi-model.test.js test/shape-model.test.js`)
- Modify: `index.js` (import + the two `this.rois` uses; full wiring lands in Task 11)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ShapeSet` with `shapes` (array), `length`, `add({kind, …})`, `remove(id)`, `clear()`, `byKind(kind)`, `toJSON(surfaceId)`, `loadJSON(doc)`
  - `FORMAT` unchanged: `"pycortex-roidraw/vertexset-v2"`
  - Every shape has `kind: "roi" | "sulcus"`; `add()` defaults to `"roi"`.
  - `toJSON()` serializes **only** `kind === "roi"` shapes; `loadJSON()` tags every imported entry `kind: "roi"`.

Read `test/roi-model.test.js` before rewriting it — keep every existing assertion, only renaming `ROISet` → `ShapeSet` and `set.rois` → `set.shapes`.

- [ ] **Step 1: Write the failing tests**

```bash
git mv core/roi-model.js core/shape-model.js
git mv test/roi-model.test.js test/shape-model.test.js
```

In `test/shape-model.test.js`, change the import to `import { ShapeSet, FORMAT } from "../core/shape-model.js";`, rename every `new ROISet()` to `new ShapeSet()` and every `.rois` **collection** access to `.shapes`, then append:

```js
test("add: defaults to kind 'roi'", () => {
    const s = new ShapeSet();
    const r = s.add({ name: "V1", left: [1], right: [] });
    assert.strictEqual(r.kind, "roi");
});

test("add: accepts a sulcus with no vertex fields", () => {
    const s = new ShapeSet();
    const cs = s.add({ kind: "sulcus", name: "CS", bezier: { closed: false, anchors: [[0, 0], [1, 1]] } });
    assert.strictEqual(cs.kind, "sulcus");
    assert.strictEqual(cs.left, undefined);
    assert.strictEqual(cs.right, undefined);
    assert.strictEqual(cs.outline, undefined);
});

test("byKind: partitions the collection", () => {
    const s = new ShapeSet();
    s.add({ name: "V1", left: [1], right: [] });
    s.add({ kind: "sulcus", name: "CS", bezier: {} });
    s.add({ kind: "sulcus", name: "CS", bezier: {} });   // duplicate names are legal
    assert.strictEqual(s.byKind("roi").length, 1);
    assert.strictEqual(s.byKind("sulcus").length, 2);
    assert.strictEqual(s.length, 3);
});

test("ids stay unique across kinds", () => {
    const s = new ShapeSet();
    const a = s.add({ name: "V1", left: [], right: [] });
    const b = s.add({ kind: "sulcus", name: "CS", bezier: {} });
    assert.notStrictEqual(a.id, b.id);
});

test("toJSON: serializes ROIs only, never sulci", () => {
    const s = new ShapeSet();
    s.add({ name: "V1", left: [1, 2], right: [] });
    s.add({ kind: "sulcus", name: "CS", bezier: { closed: false, anchors: [[0, 0], [1, 1]] } });
    const doc = s.toJSON("subj");
    assert.strictEqual(doc.format, FORMAT);
    assert.strictEqual(doc.rois.length, 1);
    assert.strictEqual(doc.rois[0].name, "V1");
});

test("loadJSON: tags imported entries as ROIs", () => {
    const s = new ShapeSet();
    const added = s.loadJSON({ format: FORMAT, rois: [{ name: "V1", vertices: { left: [1], right: [] } }] });
    assert.strictEqual(added.length, 1);
    assert.strictEqual(added[0].kind, "roi");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/shape-model.test.js`
Expected: FAIL — no export named `ShapeSet`.

- [ ] **Step 3: Implement**

Rewrite `core/shape-model.js`. Update its header comment: it is now the shape collection, holding both ROIs (closed, with vertex membership) and sulci (open, geometry only — matching pycortex, which stores no vertex data for sulci).

```js
export const FORMAT = "pycortex-roidraw/vertexset-v2";

const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c"];

export class ShapeSet {
    constructor() {
        this.shapes = [];
        this.nextId = 1;
    }

    get length() { return this.shapes.length; }

    byKind(kind) { return this.shapes.filter((s) => s.kind === kind); }

    nextColor() { return PALETTE[(this.nextId - 1) % PALETTE.length]; }

    /* An ROI carries membership (left/right/outline); a sulcus carries only its open bezier and a
     * label vertex. Vertex fields are omitted entirely for sulci rather than set to empty arrays,
     * so a downstream reader can't mistake "no membership" for "membership of nothing". */
    add({ kind = "roi", name, color, left, right, outline = null, labelVert = null, bezier = null }) {
        const shape = { id: this.nextId++, kind, name, color: color || this.nextColor(), labelVert, bezier };
        if (kind === "roi") { shape.left = left; shape.right = right; shape.outline = outline; }
        this.shapes.push(shape);
        return shape;
    }

    remove(id) { this.shapes = this.shapes.filter((s) => s.id !== id); }

    clear() { this.shapes = []; }

    /* The vertexset-v2 document is an ROI format: it describes per-hemisphere vertex membership,
     * which a sulcus does not have. Sulci export separately, as overlays.svg markup — see
     * core/svg-export.js. Unchanged from v2 on purpose; v1/v2 files keep importing. */
    toJSON(surfaceId) {
        return {
            format: FORMAT,
            generated: new Date().toISOString(),
            surface: surfaceId || null,
            note: "Per-hemisphere subject vertex indices + an ordered boundary ring (outline) + an " +
                  "editable flat-UV bezier. Portable to any viewer built on the same surface.",
            rois: this.byKind("roi").map((r) => ({
                name: r.name,
                color: r.color,
                counts: { left: r.left.length, right: r.right.length },
                vertices: { left: r.left, right: r.right },
                outline: r.outline || null,
                labelVert: r.labelVert || null,
                bezier: r.bezier || null,
            })),
        };
    }

    /* Append ROIs from a parsed document. A vertexset document only ever holds ROIs, so every
     * entry is tagged kind:"roi". Returns the shapes added. Throws on an unknown format. */
    loadJSON(doc) {
        if (!doc || !doc.format || !String(doc.format).startsWith("pycortex-roidraw"))
            throw new Error("unrecognized format: " + (doc && doc.format));
        const added = [];
        for (const r of (doc.rois || [])) {
            const v = r.vertices || {};
            added.push(this.add({
                kind: "roi",
                name: r.name || ("roi" + this.nextId),
                color: r.color,
                left: (v.left || []).slice(), right: (v.right || []).slice(),
                outline: r.outline ? r.outline.slice() : null,
                labelVert: r.labelVert || null,
                bezier: r.bezier || null,
            }));
        }
        return added;
    }
}
```

Then keep `index.js` compiling — change only the import and the collection references:

- `import { ROISet } from "./core/roi-model.js";` → `import { ShapeSet } from "./core/shape-model.js";`
- `this.rois = new ROISet();` → `this.shapes = new ShapeSet();`
- Replace every `this.rois.rois` with `this.shapes.shapes`, every other `this.rois.` with `this.shapes.` (there are uses in `_finishLasso`, `_editToggle`, `_applyEdit`, `_sync`, `remove`, `clear`, `exportJSON`, `_import`).
- In `exportJSON`, change the guard `if (!this.rois.length)` to `if (!this.shapes.byKind("roi").length)`.
- In `_finishLasso`, change `"roi" + (this.rois.length + 1)` to `"roi" + (this.shapes.byKind("roi").length + 1)` and pass `kind: "roi"` explicitly to `add()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:js`
Expected: PASS. `test/bundle.test.js` must still pass — it builds `dist/roidraw.bundle.js`, so a broken import in `index.js` fails here.

- [ ] **Step 5: Commit**

```bash
git add -A core/ test/ index.js
git commit -m "Rename ROISet to ShapeSet and add a kind field

Sulci and ROIs share one collection. A sulcus omits left/right/outline
entirely rather than carrying empty arrays, so a reader can't mistake
'no membership' for 'membership of nothing'. toJSON still emits ROIs only:
vertexset-v2 is an ROI format and is unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `curveFromTrace` and `nearestVertexTo`

**Files:**
- Modify: `draw-pipeline.js`
- Test: `test/draw-pipeline.test.js`

**Interfaces:**
- Consumes: `fitOpenBezier`, `evalOpenBezier` (Task 1); `fitHomography`, `applyHomography`, `invertHomography` from `core/transform.js`.
- Produces:
  - `nearestVertexTo(adapter, uv) -> {h, g} | null`
  - `curveFromTrace(adapter, pts) -> {bezier, labelVert} | null`

`pts` are canvas-relative screen px. The adapter method used is the existing `projectVerticesInUvBounds(bounds)`, which returns `{left:{uv,px,idx}, right:{…}}`.

Read `test/fake-adapter.js` first: its `projectVerticesInUvBounds` returns `{uv, px}` per hemisphere (no `idx`), and `allVertexUV()` returns `{left:{idx, uv}, right:{idx, uv}}`. Its projection is a real rotation+offset, so the homography round-trip below is a genuine test, not a tautology.

- [ ] **Step 1: Write the failing tests**

Append to `test/draw-pipeline.test.js`, adding `curveFromTrace, nearestVertexTo` to its import from `../draw-pipeline.js`.

```js
test("nearestVertexTo: returns the analytically nearest vertex", () => {
    const a = new FakeSurfaceAdapter();
    const all = a.allVertexUV();
    const target = all.left.uv[7];
    const hit = nearestVertexTo(a, [target[0] + 1e-6, target[1] - 1e-6]);
    assert.deepStrictEqual(hit, { h: "left", g: all.left.idx[7] });
});

test("nearestVertexTo: null on an empty surface", () => {
    const empty = { allVertexUV: () => ({ left: { idx: [], uv: [] }, right: { idx: [], uv: [] } }) };
    assert.strictEqual(nearestVertexTo(empty, [0.5, 0.5]), null);
});

test("curveFromTrace: recovers a stroke drawn along known uv points", () => {
    const a = new FakeSurfaceAdapter();
    // pick 5 uv points along a line, project them to px, and trace exactly through them
    const uvPath = [[0.30, 0.50], [0.40, 0.52], [0.50, 0.54], [0.60, 0.56], [0.70, 0.58]];
    const proj = a.projectVerticesInUvBounds({ minu: -Infinity, maxu: Infinity, minv: -Infinity, maxv: Infinity });
    const src = [], dst = [];
    for (const h of ["left", "right"]) for (let i = 0; i < proj[h].uv.length; i++) { src.push(proj[h].uv[i]); dst.push(proj[h].px[i]); }
    const H = fitHomography(src, dst);
    const pxPath = uvPath.map((uv) => applyHomography(H, uv));

    const out = curveFromTrace(a, pxPath);
    assert.ok(out && out.bezier, "expected a curve");
    assert.strictEqual(out.bezier.closed, false);
    // endpoints round-trip back to the uv we drew through
    const first = out.bezier.anchors[0];
    const last = out.bezier.anchors[out.bezier.anchors.length - 1];
    assert.ok(Math.hypot(first[0] - 0.30, first[1] - 0.50) < 1e-6, "first anchor " + first);
    assert.ok(Math.hypot(last[0] - 0.70, last[1] - 0.58) < 1e-6, "last anchor " + last);
    assert.ok(out.labelVert && (out.labelVert.h === "left" || out.labelVert.h === "right"));
});

test("curveFromTrace: null on a degenerate single-point stroke", () => {
    const a = new FakeSurfaceAdapter();
    assert.strictEqual(curveFromTrace(a, [[10, 10]]), null);
    assert.strictEqual(curveFromTrace(a, [[10, 10], [10, 10]]), null);
    assert.strictEqual(curveFromTrace(a, []), null);
});

test("curveFromTrace: null when the homography cannot be fit", () => {
    const collinear = {
        projectVerticesInUvBounds: () => ({
            left: { uv: [[0, 0], [1, 1], [2, 2], [3, 3]], px: [[0, 0], [1, 1], [2, 2], [3, 3]] },
            right: { uv: [], px: [] },
        }),
        allVertexUV: () => ({ left: { idx: [0], uv: [[0, 0]] }, right: { idx: [], uv: [] } }),
    };
    assert.strictEqual(curveFromTrace(collinear, [[0, 0], [5, 5], [9, 1]]), null);
});
```

Add to the imports of `test/draw-pipeline.test.js`:

```js
import { fitHomography, applyHomography } from "../core/transform.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/draw-pipeline.test.js`
Expected: FAIL — no export named `curveFromTrace`.

- [ ] **Step 3: Implement**

Add to `draw-pipeline.js` (extend the existing import from `./core/bezier.js` with `fitOpenBezier, evalOpenBezier`, and add a new import from `./core/transform.js`):

```js
import { fitHomography, applyHomography, invertHomography } from "./core/transform.js";

const TRACE_SAMPLES = 24;     // samples/segment when locating a curve's parametric midpoint
const ALL_UV_BOUNDS = { minu: -Infinity, maxu: Infinity, minv: -Infinity, maxv: Infinity };

/*
 * Nearest surface vertex to a flat-UV point. Brute force over every vertex: this runs once per
 * drawn curve, not per frame. It is the roidraw analogue of pycortex's SVGOverlay.set_coords,
 * which builds a cKDTree over the flat vertex coords purely to place a LABEL (`data-ptidx`) — the
 * only path->vertex mapping pycortex sanctions. Returns {h,g} or null on an empty surface.
 */
export function nearestVertexTo(adapter, uv) {
    const all = adapter.allVertexUV();
    let best = null, bd = Infinity;
    for (const h of ["left", "right"]) {
        const p = all[h];
        if (!p) continue;
        for (let k = 0; k < p.uv.length; k++) {
            const dx = p.uv[k][0] - uv[0], dy = p.uv[k][1] - uv[1], d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = { h, g: p.idx[k] }; }
        }
    }
    return best;
}

/* uv->px correspondences over the whole flatmap, as the edit overlay builds them. */
function correspondences(adapter) {
    const proj = adapter.projectVerticesInUvBounds(ALL_UV_BOUNDS);
    const src = [], dst = [];
    for (const h of ["left", "right"]) {
        const p = proj[h];
        if (!p) continue;
        for (let i = 0; i < p.uv.length; i++) { src.push(p.uv[i]); dst.push(p.px[i]); }
    }
    return { src, dst };
}

/*
 * A traced stroke -> an editable OPEN bezier, plus a label vertex.
 *
 * A sulcus stores NO vertex membership — pycortex stores none either (there is no
 * get_sulci_verts; sulci are display geometry). The curve is the datum, so there is no
 * re-derivation step and no way for stored vertices to disagree with the editable curve.
 *
 * The stroke arrives in screen px and must be stored in view-independent flat-uv. At full flat the
 * flatmap is one plane, so uv->px is exactly a homography; we fit it from the (uv, px)
 * correspondences the adapter already produces and invert it. PRECONDITION: the surface is flat
 * (drawing is flat-only — see DrawModeMachine). Returns null on a degenerate stroke or a
 * homography that won't fit (a collinear/degenerate view).
 */
export function curveFromTrace(adapter, pts) {
    if (!pts || pts.length < 2) return null;
    const c = correspondences(adapter);
    if (c.src.length < 4) return null;
    const H = fitHomography(c.src, c.dst);
    if (!H) return null;
    const Hinv = invertHomography(H);
    if (!Hinv) return null;

    const uvPts = [];
    for (const p of pts) { const uv = applyHomography(Hinv, p); if (uv) uvPts.push(uv); }
    const bezier = fitOpenBezier(uvPts);
    if (!bezier) return null;

    const poly = evalOpenBezier(bezier, TRACE_SAMPLES);
    const mid = poly[poly.length >> 1];
    return { bezier, labelVert: mid ? nearestVertexTo(adapter, mid) : null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/draw-pipeline.test.js`
Expected: PASS, including the existing `deriveRoiFromLasso` tests.

- [ ] **Step 5: Commit**

```bash
git add draw-pipeline.js test/draw-pipeline.test.js
git commit -m "Add curveFromTrace and nearestVertexTo

A traced stroke becomes an open bezier in flat-uv via the homography
core/transform.js already fits. No new adapter method: the existing
projectVerticesInUvBounds supplies the correspondences.

nearestVertexTo is the roidraw analogue of pycortex's set_coords KD-tree,
used only to place a label -- the one path->vertex mapping pycortex has.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The pure `overlays.svg` writer

**Files:**
- Create: `core/svg-export.js`
- Create: `test/svg-export.test.js`

**Interfaces:**
- Consumes: nothing (fully pure; the caller injects geometry).
- Produces:
  - `SULCI_PATH_STYLE` — the verbatim `[sulci_paths]` style string
  - `escapeXml(s) -> string`
  - `exportSulciSvg(sulci, {pathFor, ptidxFor}) -> string`

`sulci` is an array of `{name, bezier, labelVert}`. `pathFor(bezier) -> string|null` yields the `d` attribute (the adapter supplies one that maps uv→viewBox px). `ptidxFor(labelVert) -> number|null` yields the `data-ptidx` for a label.

- [ ] **Step 1: Write the failing test**

Create `test/svg-export.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { exportSulciSvg, escapeXml, SULCI_PATH_STYLE } from "../core/svg-export.js";

// The caller injects geometry; these fakes make the writer's behavior observable.
const pathFor = (bez) => "M0,0 C1,1 2,2 3,3";      // never ends with Z — the writer must not add one
const ptidxFor = (lv) => (lv ? lv.g : null);

const sulcus = (name, g) => ({ name, bezier: { closed: false, anchors: [[0, 0], [1, 1]] }, labelVert: g == null ? null : { h: "left", g } });

test("escapeXml: escapes the five XML entities", () => {
    assert.strictEqual(escapeXml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});

test("SULCI_PATH_STYLE matches pycortex defaults.cfg [sulci_paths]", () => {
    assert.strictEqual(SULCI_PATH_STYLE, "fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6");
});

test("exportSulciSvg: emits a sulci layer with shapes and labels groups", () => {
    const xml = exportSulciSvg([sulcus("CS", 12)], { pathFor, ptidxFor });
    assert.match(xml, /<g inkscape:groupmode="layer" id="sulci" inkscape:label="sulci"/);
    assert.match(xml, /id="sulci_shapes"/);
    assert.match(xml, /id="sulci_labels"/);
    assert.match(xml, /inkscape:label="CS"/);
});

test("exportSulciSvg: open paths never close with Z", () => {
    const xml = exportSulciSvg([sulcus("CS", 12)], { pathFor, ptidxFor });
    const ds = [...xml.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]);
    assert.strictEqual(ds.length, 1);
    for (const d of ds) assert.ok(!/[Zz]\s*$/.test(d), "sulcus path must not close: " + d);
});

test("exportSulciSvg: same-named sulci merge into one group, one path each", () => {
    const xml = exportSulciSvg([sulcus("CS", 12), sulcus("CS", 34), sulcus("STS", 56)], { pathFor, ptidxFor });
    const groups = [...xml.matchAll(/inkscape:label="(CS|STS)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(groups, ["CS", "STS"]);       // one <g> per distinct name
    const csGroup = xml.split('inkscape:label="CS"')[1].split("</g>")[0];
    assert.strictEqual((csGroup.match(/<path /g) || []).length, 2);
});

test("exportSulciSvg: one label per distinct name, using the first labelVert", () => {
    const xml = exportSulciSvg([sulcus("CS", 12), sulcus("CS", 34)], { pathFor, ptidxFor });
    const texts = [...xml.matchAll(/<text data-ptidx="(\d+)"[^>]*>([^<]*)<\/text>/g)];
    assert.strictEqual(texts.length, 1);
    assert.strictEqual(texts[0][1], "12");
    assert.strictEqual(texts[0][2], "CS");
});

test("exportSulciSvg: a sulcus with no labelVert emits no text", () => {
    const xml = exportSulciSvg([sulcus("CS", null)], { pathFor, ptidxFor });
    assert.ok(!xml.includes("<text"));
    assert.match(xml, /<path /);
});

test("exportSulciSvg: escapes a hostile name in both attribute and text node", () => {
    const xml = exportSulciSvg([sulcus('a&b<c>"d', 12)], { pathFor, ptidxFor });
    assert.ok(!xml.includes('inkscape:label="a&b'), "raw ampersand leaked into the attribute");
    assert.match(xml, /inkscape:label="a&amp;b&lt;c&gt;&quot;d"/);
    assert.match(xml, />a&amp;b&lt;c&gt;&quot;d<\/text>/);
});

test("exportSulciSvg: skips a sulcus whose path cannot be built", () => {
    const xml = exportSulciSvg([sulcus("CS", 12)], { pathFor: () => null, ptidxFor });
    assert.ok(!xml.includes("<path"));
});

test("exportSulciSvg: no sulci yields an empty string", () => {
    assert.strictEqual(exportSulciSvg([], { pathFor, ptidxFor }), "");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/svg-export.test.js`
Expected: FAIL — `Cannot find module '.../core/svg-export.js'`

- [ ] **Step 3: Implement**

Create `core/svg-export.js`:

```js
/*
 * svg-export.js — write drawn sulci as a pycortex `overlays.svg` fragment. Pure (no DOM, no host):
 * the caller injects the geometry via `pathFor` / `ptidxFor`.
 *
 * This is pycortex's OWN storage format for sulci, not a roidraw invention. From
 * cortex/svgoverlay.py + a real fixture (filestore/db/S1/overlays.svg), a sulcus is:
 *
 *   <g id="sulci" inkscape:label="sulci">
 *     <g id="sulci_shapes"> <g inkscape:label="CaS"> <path d="m …"/> <path d="m …"/> </g> </g>
 *     <g id="sulci_labels"> … </g>
 *   </g>
 *
 * Two facts drive this module:
 *  1. Sulcus paths are OPEN — no trailing `z`. That is the only on-disk marker separating a
 *     sulcus from an ROI (both are fill:none). `pathFor` must not emit one.
 *  2. One named sulcus commonly holds SEVERAL <path> children — pycortex's own `CaS` has two,
 *     one per hemisphere. So same-named curves merge into a single group rather than colliding.
 *
 * Style is copied verbatim from cortex/defaults.cfg [sulci_paths]. (That section has no
 * stroke-linecap; don't add one.)
 */

export const SULCI_PATH_STYLE = "fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6";

const LABEL_STYLE = "font-family:Helvetica, sans-serif;font-size:14pt;font-style:italic;" +
                    "fill:white;fill-opacity:1;text-anchor:middle";

/* A shape name is user input and lands in both an attribute value and a text node. */
export function escapeXml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/*
 * sulci     : [{ name, bezier, labelVert }]
 * pathFor   : (bezier) -> `d` string or null   (must NOT close the path)
 * ptidxFor  : (labelVert) -> integer or null   (the flat vertex index pycortex labels use)
 * Returns an overlays.svg-compatible fragment, or "" when there is nothing to write.
 */
export function exportSulciSvg(sulci, { pathFor, ptidxFor }) {
    if (!sulci || !sulci.length) return "";

    // group by name, preserving first-seen order — a named sulcus may span both hemispheres
    const groups = new Map();
    for (const s of sulci) {
        if (!groups.has(s.name)) groups.set(s.name, { name: s.name, ds: [], labelVert: null });
        const g = groups.get(s.name);
        const d = pathFor(s.bezier);
        if (d) g.ds.push(d);
        if (!g.labelVert && s.labelVert) g.labelVert = s.labelVert;
    }

    const shapes = [], labels = [];
    for (const g of groups.values()) {
        if (!g.ds.length) continue;
        const name = escapeXml(g.name);
        const paths = g.ds.map((d) => `        <path style="${SULCI_PATH_STYLE}" d="${escapeXml(d)}" />`);
        shapes.push(`      <g inkscape:groupmode="layer" inkscape:label="${name}">\n${paths.join("\n")}\n      </g>`);
        const ptidx = g.labelVert ? ptidxFor(g.labelVert) : null;
        if (ptidx != null) labels.push(`      <text data-ptidx="${ptidx}" style="${LABEL_STYLE}">${name}</text>`);
    }
    if (!shapes.length) return "";

    return [
        '<g inkscape:groupmode="layer" id="sulci" inkscape:label="sulci" style="display:inline">',
        '    <g inkscape:groupmode="layer" id="sulci_shapes" inkscape:label="shapes">',
        shapes.join("\n"),
        "    </g>",
        '    <g inkscape:groupmode="layer" id="sulci_labels" inkscape:label="labels">',
        labels.join("\n"),
        "    </g>",
        "</g>",
        "",
    ].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/svg-export.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add core/svg-export.js test/svg-export.test.js
git commit -m "Add pure overlays.svg writer for sulci

Emits pycortex's own sulci-layer markup: open fill:none paths with no
trailing Z, same-named curves merged into one inkscape-labeled group (as
pycortex's own CaS does, one path per hemisphere). Style copied verbatim
from defaults.cfg [sulci_paths]. Names are XML-escaped in both the
attribute and the text node.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Adapter — render open curves, export sulci markup

**Files:**
- Modify: `adapter/pycortex-adapter.js`
- Modify: `adapter/viewer-adapter.js` (doc comment only — **not** `REQUIRED`)

**Interfaces:**
- Consumes: `isClosed` (Task 1); `exportSulciSvg` (Task 6).
- Produces:
  - `PycortexAdapter.exportSulciMarkup(sulci) -> string`
  - `setOverlayLayer(name, shapes)` renders `kind:"sulcus"` shapes as open strokes.

There is no headless test for this file (it needs a live pycortex viewer); `test/bundle.test.js` catches build breakage. Verify by reading, then by the browser check in Task 12.

- [ ] **Step 1: Add the constants and the closed-aware path builder**

In `adapter/pycortex-adapter.js`, near the existing `OUTLINE_STROKE_PX`:

```js
const CURVE_STROKE_PX = 6;        // sulcus stroke width, from pycortex defaults.cfg [sulci_paths]
const CURVE_STROKE_OPACITY = 0.6; // ...and its stroke-opacity
```

Add to the `core/bezier.js` import: `isClosed`. Add a new import:

```js
import { exportSulciSvg } from "../core/svg-export.js";
```

Replace `_bezierSvgPath`:

```js
    // Cubic-bezier path from {anchors,inHandles,outHandles} in flat-uv -> viewBox px. This IS
    // pycortex's overlay coordinate space, so the `d` we emit here is directly usable in an
    // overlays.svg. A CLOSED bezier wraps back to anchor 0 and ends with `Z`; an OPEN one (a
    // sulcus) has n-1 segments and MUST NOT close — the missing `Z` is exactly what distinguishes
    // a sulcus from an ROI on disk.
    _bezierSvgPath(bez, W, H) {
        const { anchors, inHandles, outHandles } = bez;
        const n = anchors.length;
        const closed = isClosed(bez);
        if (n < (closed ? 3 : 2)) return null;
        const P = (uv) => (uv[0] * W).toFixed(2) + "," + ((1 - uv[1]) * H).toFixed(2);
        let d = "M" + P(anchors[0]);
        const segs = closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
            const j = closed ? (i + 1) % n : i + 1;
            d += "C" + P(outHandles[i]) + " " + P(inHandles[j]) + " " + P(anchors[j]);
        }
        return closed ? d + "Z" : d;
    }
```

Rename `_roiSvgPath` to `_shapeSvgPath` and make it bezier-only for sulci (a sulcus has no `outline` to fall back on):

```js
    // A shape's outline as an SVG path in overlay (flat-uv) coords. A bezier is emitted as a
    // native cubic path. Only ROIs have the legacy vertex-ring fallback (v1 files); a sulcus is
    // always bezier-backed, since it is created from a fitted open curve.
    _shapeSvgPath(shape, W, H) {
        if (shape.bezier && shape.bezier.anchors && shape.bezier.anchors.length >= 2)
            return this._bezierSvgPath(shape.bezier, W, H);
        if (shape.kind === "sulcus") return null;
        if (!shape.outline || shape.outline.length < 3) return null;
        const pts = [];
        for (const o of shape.outline) {
            const uv = this.vertexUV(o);
            if (uv) pts.push([uv[0] * W, (1 - uv[1]) * H]);
        }
        if (pts.length < 3) return null;
        const c = chaikin(pts, 2);
        let d = "M" + c[0][0].toFixed(2) + "," + c[0][1].toFixed(2);
        for (let i = 1; i < c.length; i++) d += "L" + c[i][0].toFixed(2) + "," + c[i][1].toFixed(2);
        return d + "Z";
    }
```

- [ ] **Step 2: Style each shape by kind in `setOverlayLayer`**

In `setOverlayLayer`, replace the `for (const roi of rois)` body's path block. Rename the loop variable to `shape` and the parameter `rois` to `shapes` throughout the method.

```js
        for (const shape of shapes) {
            const d = this._shapeSvgPath(shape, W, H);
            if (d) {
                const sulcus = shape.kind === "sulcus";
                const w = sulcus ? CURVE_STROKE_PX : OUTLINE_STROKE_PX;
                const op = sulcus ? CURVE_STROKE_OPACITY : 1;
                // White halo under a colored stroke: the halo keeps the outline legible on any
                // background (colored data or white anatomy), while the color carries the shape
                // identity the panel swatch shows. Same path `d`, drawn wider + white underneath.
                // This halo is a roidraw rendering choice and is NOT part of the exported markup.
                const halo = doc.createElementNS(SVGNS, "path");
                halo.setAttribute("d", d);
                halo.setAttribute("style", "fill:none;stroke:#ffffff;stroke-width:" + (w + OUTLINE_HALO_PX) + ";stroke-opacity:0.9");
                shapesEl.appendChild(halo);
                const path = doc.createElementNS(SVGNS, "path");
                path.setAttribute("d", d);
                path.setAttribute("style", "fill:none;stroke:" + safeColor(shape.color) + ";stroke-width:" + w + ";stroke-opacity:" + op);
                shapesEl.appendChild(path);
            }
            const ptidx = this._labelPtidx(shape.labelVert);
            if (ptidx != null) {
                const t = doc.createElementNS(SVGNS, "text");
                t.setAttribute("data-ptidx", String(ptidx));
                t.setAttribute("style", "font-family:Helvetica, sans-serif;font-size:" + LABEL_FONT_PT + "pt;font-weight:bold;" +
                    "font-style:italic;fill:white;fill-opacity:1;text-anchor:middle;filter:url(#dropshadow)");
                t.appendChild(doc.createTextNode(shape.name)); // createTextNode => no injection
                labelsEl.appendChild(t);
            }
        }
```

Also change the early return `if (!rois.length)` to `if (!shapes.length)`.

- [ ] **Step 3: Add `exportSulciMarkup`**

Add a method to `PycortexAdapter`, next to `setOverlayLayer`:

```js
    /*
     * Serialize drawn sulci as a pycortex overlays.svg fragment. The `d` strings come from the
     * SAME uv->viewBox mapping the live overlay uses, which is pycortex's own overlay coordinate
     * space — so the output drops straight into a subject's overlays.svg. Returns "" if the
     * overlay isn't loaded yet or there are no sulci.
     */
    exportSulciMarkup(sulci) {
        const svgo = this.surface.svg;
        if (!svgo || !svgo.svg) return "";
        const vb = (svgo.svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(parseFloat);
        const W = (vb.length === 4 && vb[2]) ? vb[2] : svgo.width;
        const H = (vb.length === 4 && vb[3]) ? vb[3] : svgo.height;
        return exportSulciSvg(sulci, {
            pathFor: (bez) => (bez ? this._bezierSvgPath(bez, W, H) : null),
            ptidxFor: (lv) => this._labelPtidx(lv),
        });
    }
```

- [ ] **Step 4: Update the `viewer-adapter.js` doc comment**

`setOverlayLayer`'s JSDoc currently says `rois`. Change the `@param` block only — **do not touch `ViewerAdapter.REQUIRED`**:

```js
    /**
     * Create/replace a named overlay layer rendered INTO the surface (so it occludes and morphs
     * like built-in ROIs). `shapes` carries, per shape, its `kind` ("roi" | "sulcus"), a label
     * vertex, a display color, and an editable flat-UV `bezier` the adapter renders as a cubic
     * path — closed for an ROI, open (no `Z`) for a sulcus. ROIs may also carry a boundary ring
     * (`outline`) used as a fallback for files predating the bezier.
     * @param {string} name
     * @param {Array<{kind, name, color?, outline?:[{h,g}], labelVert:{h,g}, bezier?}>} shapes
     */
    setOverlayLayer(_name, _shapes) { throw new Error("ViewerAdapter.setOverlayLayer not implemented"); }
```

- [ ] **Step 5: Verify the build and the contract test**

Run: `npm run test:js`
Expected: PASS. `test/adapter-contract.test.js` must pass **unchanged** — no method was added to `REQUIRED`, and `exportSulciMarkup` is a `PycortexAdapter` extra, not part of the contract.

Then confirm the closed path still ends with `Z` and no `Z` leaks into an open one:

Run: `node -e "import('./core/bezier.js').then(async b=>{const {isClosed}=b;console.log('isClosed open:',isClosed({closed:false}),'default:',isClosed({}))})"`
Expected: `isClosed open: false default: true`

- [ ] **Step 6: Commit**

```bash
git add adapter/
git commit -m "Render open sulcus curves and export overlays.svg markup

_bezierSvgPath branches on `closed`: an open curve emits n-1 segments and no
trailing Z -- the one on-disk marker separating a sulcus from an ROI.
Sulci stroke at defaults.cfg's [sulci_paths] weight (6 / 0.6).

exportSulciMarkup reuses the same uv->viewBox mapping the live overlay uses,
which already IS pycortex's overlay coordinate space, so the fragment drops
straight into a subject's overlays.svg. No adapter contract change.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Lasso overlay — trace mode

**Files:**
- Modify: `ui/lasso-overlay.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LassoOverlay` constructor takes an added callback `onTrace(points)`.
  - `setTool(tool)` where `tool` is `"lasso" | "trace"`.
  - In `"lasso"` the stroke closes visually and fires `onLasso` at `>= 3` points (today's behavior).
  - In `"trace"` the stroke stays open and fires `onTrace` at `>= 2` points.

- [ ] **Step 1: Add the tool state**

In the constructor, after `this.drawing = false;`:

```js
        this.tool = "lasso";        // "lasso" (closed ROI) | "trace" (open sulcus)
```

And accept the callback:

```js
    constructor(adapter, { onLasso, onInspect, onTrace } = {}) {
        this.adapter = adapter;
        this.onLasso = onLasso || (() => {});
        this.onTrace = onTrace || (() => {});
        this.onInspect = onInspect || (() => {});
```

Update the file header comment to document the new emission:

```js
 *   onLasso(points)   — a completed CLOSED lasso (>= 3 points), in canvas-relative px.
 *   onTrace(points)   — a completed OPEN stroke (>= 2 points), in canvas-relative px (a sulcus).
 *   onInspect(x, y)   — a Shift-click (not drag), so the host can pick the voxel underneath.
```

- [ ] **Step 2: Add `setTool` and route the mouseup**

```js
    /* Which gesture a plain drag performs: a closed ROI lasso, or an open sulcus trace. */
    setTool(tool) {
        if (tool === this.tool) return;
        this.tool = tool === "trace" ? "trace" : "lasso";
        this._cancel();            // an in-flight stroke belongs to the old tool
    }
```

Replace the tail of `_onUp`:

```js
        if (g !== "lasso") return;
        this.drawing = false;
        const pts = this.lasso;
        this.lasso = [];
        this._redraw();
        // A trace needs only 2 points (a line); a closed lasso needs 3 to bound an area.
        if (this.tool === "trace") { if (pts.length >= 2) this.onTrace(pts); return; }
        if (pts.length >= 3) this.onLasso(pts);
```

- [ ] **Step 3: Show the in-progress stroke unclosed in trace mode**

`_redraw` already strokes an open polyline (it never calls `closePath`), so it is correct as-is for both tools. Add a comment so a later reader doesn't "fix" it:

```js
    _redraw() {
        const ctx = this.ctx;
        if (!ctx) return;
        ctx.clearRect(0, 0, this.el.width, this.el.height);
        if (this.lasso.length > 1) {
            // Drawn as an open polyline for BOTH tools: a lasso's closure is implied by the
            // point-in-polygon test, not by the preview stroke.
            ctx.strokeStyle = LASSO_STROKE;
            ctx.lineWidth = LASSO_WIDTH;
            ctx.beginPath();
            ctx.moveTo(this.lasso[0][0], this.lasso[0][1]);
            for (let j = 1; j < this.lasso.length; j++) ctx.lineTo(this.lasso[j][0], this.lasso[j][1]);
            ctx.stroke();
        }
    }
```

- [ ] **Step 4: Verify the build**

Run: `npm run test:js`
Expected: PASS (no behavior change until Task 11 wires `setTool`; `test/bundle.test.js` catches syntax errors).

- [ ] **Step 5: Commit**

```bash
git add ui/lasso-overlay.js
git commit -m "Add trace mode to the lasso overlay

A plain drag either closes into an ROI lasso (>=3 pts) or stays an open
sulcus trace (>=2 pts), selected by setTool(). The preview stroke was
already drawn unclosed, so only the emission differs.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Edit overlay — open curves

**Files:**
- Modify: `ui/bezier-edit-overlay.js`

**Interfaces:**
- Consumes: `isClosed`, `evalBezier`, `nearestOnBezier`, `segCount` (Tasks 1–2).
- Produces: the edit overlay accepts a `{closed:false}` bezier.

Read the whole file first. There are exactly four closed-shape assumptions in it; find each by grepping.

- [ ] **Step 1: Swap the closed-only imports for the dispatching ones**

Change the import from `../core/bezier.js`: replace `evalClosedBezier` with `evalBezier`, replace `nearestOnClosedBezier` with `nearestOnBezier`, and add `isClosed`.

Run: `grep -n "evalClosedBezier\|nearestOnClosedBezier" ui/bezier-edit-overlay.js`
Expected after the edit: no matches.

- [ ] **Step 2: Lower the anchor-count floors**

Add a helper near the top of the class file:

```js
/* A closed bezier needs 3 anchors to bound an area; an open one needs only 2 to be a curve. */
const minAnchors = (bez) => (isClosed(bez) ? 3 : 2);
```

In `_recurve`:

```js
    _recurve() {
        this._uvPoly = (this.bez && this.bez.anchors.length >= minAnchors(this.bez))
            ? evalBezier(this.bez, CURVE_SAMPLES) : null;
    }
```

In `reproject`:

```js
        if (!this.bez || this.bez.anchors.length < minAnchors(this.bez)) { this._clear(); return; }
```

- [ ] **Step 3: Dispatch the curve hit-test**

Find the `nearestOnClosedBezier` call (around line 195, in the double-click-to-insert path) and change it to `nearestOnBezier(this.bez, uv, …)`. `splitSegment` then receives a `seg` already bounded by `segCount`, because `nearestOnOpenBezier` only ever reports `seg` in `[0, n-2]`.

- [ ] **Step 4: Draw only the live handles at an open curve's endpoints**

In `_redraw`, where each anchor's two handles are drawn, skip the unused one. An open curve's `inHandles[0]` and `outHandles[n-1]` sit exactly on their anchor, so drawing them would stack a handle dot on the anchor dot and make it undraggable.

```js
        const open = !isClosed(this.bez);
        const n = this.bez.anchors.length;
        // ...inside the per-anchor loop, guard each handle:
        const drawIn  = !(open && i === 0);
        const drawOut = !(open && i === n - 1);
```

Guard both the handle *drawing* and the handle *hit-testing* (`_hitTest` / the `nearestWithin` call that considers handle positions) with the same two flags, so an endpoint's phantom handle can neither be seen nor grabbed.

- [ ] **Step 5: Verify**

Run: `npm run test:js`
Expected: PASS. `test/overlay-geom.test.js` is unaffected (`nearestWithin`/`hitTest` are pure and take explicit point lists).

Then read back the four changed regions and confirm no `evalClosedBezier`, `nearestOnClosedBezier`, or bare `>= 3` anchor guard remains:

Run: `grep -n "Closed\|>= 3\|< 3" ui/bezier-edit-overlay.js`
Expected: no matches (or only matches inside comments that explain the closed case).

- [ ] **Step 6: Commit**

```bash
git add ui/bezier-edit-overlay.js
git commit -m "Support editing open curves in the bezier overlay

Anchor floors drop to 2 when open; eval and hit-test dispatch on `closed`.
An open curve's endpoint handles sit on their anchor, so they are neither
drawn nor grabbable -- otherwise a handle dot would stack on the anchor
and make it undraggable.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Draw panel — kind selector and a mixed list

**Files:**
- Modify: `ui/draw-panel.js`
- Modify: `ui/roidraw.css`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DrawPanel` constructor takes an added callback `onTool(tool)` where `tool` is `"lasso" | "trace"`.
  - `renderList(shapes)` handles both kinds.
  - `setStatus` / `message` / `setEditingId` / `setVisible` / `destroy` unchanged.

- [ ] **Step 1: Add the kind selector**

In the `DrawPanel` constructor, after the `<h2>` and before `this.statusEl`:

```js
        // Which gesture a plain drag performs. An ROI is a closed lasso; a sulcus is an open trace.
        this.tool = "lasso";
        const tools = document.createElement("div");
        tools.className = "roidraw-tools";
        tools.setAttribute("role", "group");
        tools.setAttribute("aria-label", "shape kind");
        this._toolBtns = {};
        for (const [tool, label] of [["lasso", "ROI"], ["trace", "Sulcus"]]) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "roidraw-tools__btn";
            b.textContent = label;
            b.setAttribute("aria-pressed", String(tool === this.tool));
            b.onclick = () => this.setTool(tool);
            this._toolBtns[tool] = b;
            tools.appendChild(b);
        }
        el.appendChild(tools);
```

Accept and store the callback:

```js
    constructor({ onExport, onExportSulci, onImport, onClear, onRemove, onEdit, onTool } = {}) {
        this.onRemove = onRemove || (() => {});
        this.onEdit = onEdit || (() => {});
        this.onTool = onTool || (() => {});
```

Add the setter and a separate reflector:

```js
    /* Paint the segmented control to match this.tool. Fires no callback. */
    _reflectTool() {
        for (const [t, b] of Object.entries(this._toolBtns)) {
            const on = t === this.tool;
            b.classList.toggle("roidraw-tools__btn--on", on);
            b.setAttribute("aria-pressed", String(on));
        }
    }

    /* Select the active draw tool, reflect it, and notify the controller. */
    setTool(tool) {
        this.tool = tool === "trace" ? "trace" : "lasso";
        this._reflectTool();
        this.onTool(this.tool);
    }
```

At the end of the constructor, just before `this.renderList([])`, call **`this._reflectTool()`** — **not** `this.setTool("lasso")`.

This matters. `setTool` fires `onTool`, which the controller (Task 11) routes to `_setTool` → `_renderStatus()` → `this.panel.setStatus(...)`. During `this.panel = new DrawPanel({…})` the field `this.panel` is still `undefined`, so that call would throw. It happens not to today only because `_renderStatus` early-returns while the mode is `"display"` — an accident, not a guarantee. Paint the initial state without emitting an event.

- [ ] **Step 2: Add the sulcus export button**

After the existing `Export JSON` button:

```js
        const exp = document.createElement("button");
        exp.type = "button";
        exp.textContent = "Export ROIs (JSON)";
        exp.onclick = () => onExport && onExport();
        el.appendChild(exp);

        const expS = document.createElement("button");
        expS.type = "button";
        expS.textContent = "Export sulci (SVG)";
        expS.onclick = () => onExportSulci && onExportSulci();
        el.appendChild(expS);
```

- [ ] **Step 3: Render both kinds in the list**

Replace `renderList`. A sulcus has no `left`/`right`, so its count column shows its anchor count.

```js
    renderList(shapes) {
        const ed = shapes.find((s) => s.id === this._editingId);
        this.doneEl.style.display = ed ? "" : "none";
        if (ed) this.doneEl.textContent = "✓ Done editing “" + ed.name + "”";

        const list = this.listEl;
        list.textContent = "";
        if (!shapes.length) {
            const e = document.createElement("span");
            e.className = "roidraw-list__empty";
            e.textContent = "nothing drawn yet";
            list.appendChild(e);
            return;
        }
        for (const s of shapes) {
            const editing = s.id === this._editingId;
            const sulcus = s.kind === "sulcus";
            const row = document.createElement("div");
            row.className = "roidraw-roi" + (editing ? " roidraw-roi--editing" : "");

            const sw = document.createElement("span");
            sw.className = "roidraw-roi__swatch";
            sw.style.background = s.color;            // style property (not HTML) — safe
            row.appendChild(sw);

            // Duplicate names are legal (a sulcus is traced once per hemisphere), and an ROI and a
            // sulcus may share a name too — so the row states its kind.
            const kd = document.createElement("span");
            kd.className = "roidraw-roi__kind";
            kd.textContent = sulcus ? "∿" : "◯";
            kd.title = sulcus ? "sulcus" : "ROI";
            row.appendChild(kd);

            const nm = document.createElement("span");
            nm.className = "roidraw-roi__name";
            nm.textContent = s.name;                  // textContent — no injection
            row.appendChild(nm);

            const ct = document.createElement("span");
            ct.className = "roidraw-roi__count";
            // ROIs count enclosed vertices; a sulcus has no membership, so it counts its anchors.
            ct.textContent = sulcus
                ? String(s.bezier && s.bezier.anchors ? s.bezier.anchors.length : 0)
                : String(s.left.length + s.right.length);
            ct.title = sulcus ? "anchors" : "vertices";
            row.appendChild(ct);

            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "roidraw-roi__editbtn" + (editing ? " roidraw-roi__editbtn--on" : "");
            edit.textContent = editing ? "editing" : "✎ edit";
            edit.title = s.bezier ? (editing ? "finish editing" : "edit shape") : "no editable curve";
            edit.disabled = !s.bezier;
            edit.onclick = (e) => { e.preventDefault(); if (s.bezier) this.onEdit(editing ? null : s.id); };
            row.appendChild(edit);

            const del = document.createElement("button");
            del.type = "button";
            del.className = "roidraw-roi__del";
            del.textContent = "✕";
            del.title = "remove";
            del.setAttribute("aria-label", "remove " + (sulcus ? "sulcus " : "ROI ") + s.name);
            del.onclick = (e) => { e.preventDefault(); this.onRemove(s.id); };
            row.appendChild(del);

            list.appendChild(row);
        }
    }
```

- [ ] **Step 4: Style the new elements**

Append to `ui/roidraw.css`:

```css
.roidraw-tools { display: flex; gap: 0; margin: 6px 0 8px; }
.roidraw-tools__btn {
    flex: 1; padding: 5px 8px; font: inherit; cursor: pointer;
    background: #2a2a2a; color: #ddd; border: 1px solid #444;
}
.roidraw-tools__btn:first-child { border-radius: 3px 0 0 3px; }
.roidraw-tools__btn:last-child { border-radius: 0 3px 3px 0; border-left: none; }
.roidraw-tools__btn--on { background: #ffcc00; color: #111; border-color: #ffcc00; }
.roidraw-roi__kind { width: 1.2em; text-align: center; opacity: 0.75; }
```

- [ ] **Step 5: Verify**

Run: `npm run test:js`
Expected: PASS (`test/bundle.test.js` asserts the CSS is inlined into the bundle, so a CSS syntax error fails here).

- [ ] **Step 6: Commit**

```bash
git add ui/draw-panel.js ui/roidraw.css
git commit -m "Add a kind selector and a mixed shape list to the panel

Rows state their kind, because duplicate names are legal: a sulcus is traced
once per hemisphere under one name. A sulcus counts anchors, not vertices --
it has no membership.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Controller wiring

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: `ShapeSet` (Task 4); `curveFromTrace` (Task 5); `adapter.exportSulciMarkup` (Task 7); `LassoOverlay.setTool` (Task 8); `DrawPanel.onTool` / `onExportSulci` (Task 10).
- Produces: nothing.

Task 4 already renamed `this.rois` → `this.shapes`. This task adds the trace path, the tool switch, the sulcus export, and the edit guard.

- [ ] **Step 1: Wire the trace callback and the tool switch**

Extend the import: `import { deriveRoiFromLasso, roiFromBezier, backfillBezier, backfillLabel, curveFromTrace } from "./draw-pipeline.js";`

In the constructor:

```js
        this.overlay = new LassoOverlay(this.adapter, {
            onLasso: (pts) => this._finishLasso(pts),
            onTrace: (pts) => this._finishTrace(pts),
            onInspect: (x, y) => this.adapter.inspectAt(x, y),
        });
```

```js
        this.panel = new DrawPanel({
            onExport: () => this.exportJSON(),
            onExportSulci: () => this.exportSulciSVG(),
            onImport: (file) => this._import(file),
            onClear: () => this.clear(),
            onRemove: (id) => this.remove(id),
            onEdit: (id) => this._editToggle(id),
            onTool: (tool) => this._setTool(tool),
        });
```

Add:

```js
    // Which gesture a plain drag performs. Ending an in-flight edit first: the edit overlay owns
    // the pointer while it is up, and the new tool's stroke would be swallowed by it.
    _setTool(tool) {
        if (this.editOverlay.isEditing()) this._editToggle(null);
        this.overlay.setTool(tool);
        this._renderStatus();
    }
```

- [ ] **Step 2: Add `_finishTrace`**

Below `_finishLasso`:

```js
    _finishTrace(pts) {
        // A sulcus is an OPEN curve with no vertex membership — pycortex stores none either. The
        // fitted bezier is the whole datum, so there is nothing to re-derive and nothing that can
        // fall out of sync with it.
        const curve = curveFromTrace(this.adapter, pts);
        if (!curve) { this.panel.message("Couldn't fit a curve — trace a longer stroke on the flatmap."); return; }

        const fallback = "sulcus" + (this.shapes.byKind("sulcus").length + 1);
        const entered = window.prompt("Sulcus name (reuse a name for the other hemisphere):", fallback);
        if (entered === null) return;                 // Cancel
        const name = entered.trim() || fallback;
        this.shapes.add({ kind: "sulcus", name, bezier: curve.bezier, labelVert: curve.labelVert });
        this._sync();
        this.panel.message('Sulcus "' + name + '": ' + curve.bezier.anchors.length + " anchors. ✎ editable.");
    }
```

- [ ] **Step 3: Guard `_applyEdit` for sulci**

```js
    // A drag-release from the edit overlay: store the new bezier. For an ROI, re-derive its vertex
    // membership from the curve (the bezier is the source of truth). A sulcus HAS no membership.
    _applyEdit(bezier) {
        const shape = this.shapes.shapes.find((s) => s.id === this.editingId);
        if (!shape) return;
        shape.bezier = bezier;
        if (shape.kind === "roi") {
            const d = roiFromBezier(this.adapter, bezier);
            if (d && d.total) { shape.left = d.left; shape.right = d.right; shape.outline = d.outline; shape.labelVert = d.labelVert; }
        }
        this.adapter.setOverlayLayer(LAYER, this.shapes.shapes);
        this.panel.renderList(this.shapes.shapes);
    }
```

- [ ] **Step 4: Add the sulcus SVG export**

Factor the download out of `exportJSON` (it and the new export share it):

```js
    _download(text, filename, mime) {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        // Firefox writes a 0-byte file if the anchor is removed / the URL revoked before the
        // download starts — defer both well past the click instead of tearing down immediately.
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
    }

    /* Sulci export as pycortex's OWN overlays.svg markup, not as a roidraw JSON format: paste or
     * merge the fragment into the subject's overlays.svg and quickflat/WebGL/Inkscape read it. */
    exportSulciSVG() {
        const sulci = this.shapes.byKind("sulcus");
        if (!sulci.length) { this.panel.message("No sulci to export."); return; }
        let xml;
        try { xml = this.adapter.exportSulciMarkup(sulci); }
        catch (e) { this.panel.message("Export failed: " + (e && e.message ? e.message : e)); return; }
        if (!xml) { this.panel.message("Export failed: the SVG overlay isn't loaded yet."); return; }
        this._download(xml, "sulci.svg", "image/svg+xml");
        this.panel.message("Exported " + sulci.length + " sulcus curve(s), " + xml.length + " bytes, to sulci.svg.");
    }
```

Rewrite `exportJSON` to use `_download`:

```js
    exportJSON() {
        const rois = this.shapes.byKind("roi");
        if (!rois.length) { this.panel.message("No ROIs to export."); return; }
        let text;
        try { text = JSON.stringify(this.shapes.toJSON(this.adapter.surfaceId()), null, 2); }
        catch (e) { this.panel.message("Export failed: " + (e && e.message ? e.message : e)); return; }
        this._download(text, "rois.json", "application/json");
        this.panel.message("Exported " + rois.length + " ROI(s), " + text.length + " bytes, to rois.json.");
    }
```

- [ ] **Step 5: Back-fill only ROIs on import**

In `_import`, the `backfillLabel` / `backfillBezier` loop runs over `added`, which `loadJSON` now tags `kind:"roi"`. No change is needed, but add a guard comment so the intent survives:

```js
                // Imported documents are vertexset-v2, which is an ROI format — every entry is an
                // ROI. Sulci import is not supported (export is one-way; see the design spec).
                for (const roi of added) {
```

- [ ] **Step 6: Add the trace status line**

In `_renderStatus`, after the editing branch:

```js
        if (this.editOverlay.isEditing()) this.panel.setStatus("Editing — drag ● to move · click an anchor, drag ○ to bend · double-click the line to add a point · double-click ● to toggle corner/smooth · select + Delete to remove · scroll to zoom · ✓ done when finished.", "draw");
        else if (this.overlay.tool === "trace") this.panel.setStatus("Drag along the sulcus · ✎ to edit a curve · scroll to zoom · Shift+drag to pan · Shift+click to inspect.", "draw");
        else this.panel.setStatus("Lasso to draw an ROI · ✎ to edit a shape · scroll to zoom · Shift+drag to pan · Shift+click to inspect.", "draw");
```

- [ ] **Step 7: Verify**

Run: `npm run test:js`
Expected: PASS, all files including `test/bundle.test.js`.

Confirm no stale `this.rois` remains:

Run: `grep -n "this\.rois" index.js`
Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add index.js
git commit -m "Wire sulcus drawing into the controller

Trace gesture -> curveFromTrace -> an open bezier with no membership.
_applyEdit skips vertex re-derivation for sulci (they have none), and sulci
export as overlays.svg markup via a shared _download helper.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Docs, bundle, and a live browser check

**Files:**
- Modify: `README.md`
- Modify: `TESTING.md`
- Modify: `package.json` (version bump)

**Interfaces:**
- Consumes: everything.
- Produces: a rebuilt `dist/roidraw.bundle.js`.

- [ ] **Step 1: Run the full suite green**

Run: `npm test`
Expected: PASS — JS tests plus the five Python suites.

Record the new JS test count; the README/TESTING docs quote it.

- [ ] **Step 2: Update the README**

In the architecture block, the file list currently names `core/roi-model.js`. Replace that entry and add the two new files:

```
core/shape-model.js   the shape collection (ROIs + sulci) + the vertexset-v2 ROI export/import
core/svg-export.js    pure writer for pycortex overlays.svg sulci markup
```

Add a short "Sulci" section after the ROI usage section:

```markdown
### Sulci

Switch the panel's kind selector to **Sulcus** and drag along the sulcus. A sulcus is an *open*
curve, editable exactly like an ROI's boundary. Trace each hemisphere separately and give both
strokes the same name — on export they merge into one group, which is how pycortex's own overlays
store a sulcus (`CaS` has one `<path>` per hemisphere).

**Export sulci (SVG)** downloads an `overlays.svg`-compatible fragment. This is pycortex's own
storage format for sulci: open `fill:none` paths in a `sulci` layer, carrying no vertex data.
Paste or merge it into the subject's `overlays.svg` and `quickflat.add_sulci`, the WebGL viewer,
and Inkscape will all read it.

Sulci deliberately store **no vertex membership** — pycortex stores none either (there is no
`get_sulci_verts`; sulci are display geometry). ROIs still export vertex indices as JSON,
unchanged.
```

- [ ] **Step 3: Update TESTING.md**

Add to the layer table:

```markdown
| `core/svg-export.js` | `test/svg-export.test.js` | Sulcus paths never close with `Z`; same-named curves merge into one group; names are XML-escaped. |
```

And extend the open/closed line under `core/bezier.js` to mention that open-curve invariants are covered by `test/properties.test.js`.

Under the "honest gap" section, add:

> The exported `sulci.svg` fragment is asserted structurally (open paths, merged groups, escaping)
> but has never been round-tripped through pycortex's `svgoverlay.py` parser in CI. Loading it into
> a real subject's `overlays.svg` is a manual check.

- [ ] **Step 4: Bump the version and rebuild**

Edit `package.json`: `"version": "0.3.4"` → `"version": "0.4.0"` (a new user-facing feature, not a fix).

Run: `npm run build`
Then: `node --check dist/roidraw.bundle.js && wc -c dist/roidraw.bundle.js`
Expected: no output from `--check`; a byte count larger than 94,844.

- [ ] **Step 5: Live browser check**

The adapter cannot be tested headlessly — it talks to pycortex internals. Serve the demo viewer and confirm by eye:

```bash
python3 -m http.server 8911 --directory examples
```

Open the viewer, then verify each of these:
1. The panel shows an `ROI | Sulcus` selector; `ROI` is selected.
2. Drawing a lasso with `ROI` selected still creates a closed, filled-outline ROI with a vertex count.
3. Switching to `Sulcus` and dragging a stroke creates an open curve — **the two ends must not be joined**.
4. The sulcus renders at a visibly heavier stroke than an ROI outline.
5. `✎ edit` on the sulcus shows anchors; the two endpoints each show **one** handle, and both are draggable.
6. Naming a second stroke `CS` (same as the first) produces two rows, not an error.
7. **Export sulci (SVG)** downloads `sulci.svg`. Open it: exactly one `<g inkscape:label="CS">`, containing two `<path>` elements, and **no `d` attribute ends in `Z`**.

Confirm point 7 mechanically:

```bash
grep -o 'd="[^"]*"' ~/Downloads/sulci.svg | grep -c 'Z"' 
```
Expected: `0`

- [ ] **Step 6: Commit**

```bash
git add README.md TESTING.md package.json
git commit -m "Document sulcus drawing; bump to v0.4.0

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Release (only when the user asks)**

`dist/` is gitignored — the GitHub release asset is the distribution, and the demo viewer at
`gallantlab/viewer-stories-group-roidraw` is pinned to a bundle, not to `/releases/latest`. So
shipping this feature to users needs, in order:

1. `gh release create v0.4.0` with `dist/roidraw.bundle.js` attached.
2. Re-bake the demo viewer: swap its root `roidraw.bundle.js` for the release asset, `git add`
   (a bare `git commit -m` stages nothing here), commit, push.
3. Verify the live raw SHA-256 matches the release asset.

Do **not** do this without an explicit instruction — publishing a release is an outward-facing
action. Detect v0.4.0 in a built bundle via the positive marker `fitOpenBezier` or `exportSulciSvg`.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: open geometry → 1–3; `kind`/`ShapeSet` → 4;
`curveFromTrace`/`nearestVertexTo` → 5; the SVG writer → 6; adapter rendering + `exportSulciMarkup`
→ 7; trace mode → 8; open-curve editing → 9; UI → 10; controller + export → 11; docs/bundle → 12.
The spec's "closed-shape assumptions" table is discharged by Tasks 1, 2, 7, 9, 10, and 11 — each row
appears as a concrete edit.

**Deliberately out of scope** (spec non-goals, no task): gyri; importing sulci from SVG; editing the
subject's existing pycortex sulci; any vertex membership or ribbon for sulci; merging into a
subject's `overlays.svg` from the browser.

**Type consistency.** `isClosed`/`segCount`/`evalBezier`/`nearestOnBezier` are defined in Tasks 1–2
and consumed under those exact names in Tasks 7 and 9. `ShapeSet.shapes` (the array) and
`ShapeSet.byKind()` are defined in Task 4 and used under those names in 10 and 11. `exportSulciSvg`
(pure, Task 6) is wrapped by `exportSulciMarkup` (adapter, Task 7) and called as
`exportSulciSVG()` (controller, Task 11) — three distinct names for three distinct layers, used
consistently. `LassoOverlay.setTool` / `DrawPanel.setTool` share a name but are separate objects;
the controller's `_setTool` bridges them.

**Known risk carried forward.** Task 9 step 4 is the only step whose exact code depends on a region
of `ui/bezier-edit-overlay.js` not quoted verbatim here (the per-anchor draw loop). The implementer
must read that loop before editing. Everything else is fully specified.
