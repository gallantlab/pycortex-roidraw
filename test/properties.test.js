/*
 * properties.test.js — property-based invariants over the pure core. Instead of a handful of
 * hand-picked cases, each test asserts a property that must hold for HUNDREDS of seeded-random
 * inputs. A failure prints the seed + the offending case so it reproduces deterministically.
 *
 * These encode the package's actual correctness CLAIMS:
 *   - serialize/deserialize is lossless,
 *   - the bezier fit is independent of where the boundary ring starts,
 *   - a sampled bezier never blows up outside its control points,
 *   - selection truly selects the vertices the polygon encloses (and nothing else),
 *   - the boundary ring is always a subset of the selection,
 *   - membership re-derived from a curve is deterministic — "what you see is what you get".
 */
import test from "node:test";
import assert from "node:assert";
import { ShapeSet } from "../core/shape-model.js";
import { fitClosedBezier, evalClosedBezier, bezierFromAnchors, fitOpenBezier, evalOpenBezier, isClosed, moveAnchor, setAnchorSmooth, deleteAnchor, splitSegment } from "../core/bezier.js";
import { fitHomography, applyHomography, invertHomography } from "../core/transform.js";
import { selectInPolygon } from "../core/selection.js";
import { buildOutline } from "../core/outline.js";
import { pointInPolygon, polygonBounds } from "../core/geom.js";

// --- seeded PRNG (mulberry32): reproducible random so any counterexample is replayable ---------
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const TRIALS = 300;

// A convex polygon of `n` vertices on a jittered circle — convex so point-in-polygon is
// unambiguous and the bezier seam (rotateToExtreme) is stable.
function convexRing(r, n, cx = 0.5, cy = 0.5, rad = 0.3) {
    const pts = [];
    for (let i = 0; i < n; i++) {
        const ang = (2 * Math.PI * i) / n;
        const rr = rad * (0.7 + 0.3 * r());
        pts.push([cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)]);
    }
    return pts;
}

// A random uv vertex cloud in [0,1]^2, shaped like the adapter's `projected` (left hemi only).
function cloud(r, n) {
    const idx = [], px = [];
    for (let i = 0; i < n; i++) { idx.push(i); px.push([r(), r()]); }
    return { left: { idx, px }, right: { idx: [], px: [] } };
}

// ----------------------------------------------------------------------------------------------
test("PROPERTY: ROI export/import is lossless (vertices, outline, label, bezier)", () => {
    const r = rng(1);
    for (let t = 0; t < TRIALS; t++) {
        const src = new ShapeSet();
        const nrois = 1 + (Math.floor(r() * 4));
        for (let k = 0; k < nrois; k++) {
            const ring = convexRing(r, 3 + Math.floor(r() * 6));
            const bez = fitClosedBezier(ring);
            const left = Array.from({ length: 1 + Math.floor(r() * 8) }, () => Math.floor(r() * 1000));
            const right = Array.from({ length: Math.floor(r() * 5) }, () => Math.floor(r() * 1000));
            const outline = ring.map((_, i) => ({ h: i % 2 ? "right" : "left", g: Math.floor(r() * 1000) }));
            src.add({ name: "roi" + k, left, right, outline, labelVert: outline[0], bezier: bez });
        }
        const doc = JSON.parse(JSON.stringify(src.toJSON("surfX")));  // simulate a file round-trip
        const dst = new ShapeSet();
        dst.loadJSON(doc);
        assert.strictEqual(dst.shapes.length, src.shapes.length, `trial ${t}: roi count`);
        for (let i = 0; i < src.shapes.length; i++) {
            const a = src.shapes[i], b = dst.shapes[i];
            assert.deepStrictEqual(b.left, a.left, `trial ${t} roi ${i}: left verts`);
            assert.deepStrictEqual(b.right, a.right, `trial ${t} roi ${i}: right verts`);
            assert.deepStrictEqual(b.outline, a.outline, `trial ${t} roi ${i}: outline`);
            assert.deepStrictEqual(b.labelVert, a.labelVert, `trial ${t} roi ${i}: labelVert`);
            assert.deepStrictEqual(b.bezier, a.bezier, `trial ${t} roi ${i}: bezier`);
        }
    }
});

test("PROPERTY: the bezier fit is independent of where the boundary ring starts", () => {
    const r = rng(2);
    for (let t = 0; t < TRIALS; t++) {
        const n = 3 + Math.floor(r() * 7);
        const ring = convexRing(r, n);
        const base = fitClosedBezier(ring);
        assert.ok(base, `trial ${t}: base fit`);
        // rotate the ring to start at a different vertex; the fitted anchor SET must not change
        const k = 1 + Math.floor(r() * (n - 1));
        const rotated = ring.slice(k).concat(ring.slice(0, k));
        const rot = fitClosedBezier(rotated);
        assert.ok(rot, `trial ${t}: rotated fit`);
        const key = (b) => b.anchors.map((p) => p[0].toFixed(6) + "," + p[1].toFixed(6)).sort().join(";");
        assert.strictEqual(key(rot), key(base), `trial ${t}: anchor set differs after rotating start by ${k}`);
    }
});

test("PROPERTY: a sampled bezier stays within the bbox of its control points (no blow-up)", () => {
    const r = rng(3);
    for (let t = 0; t < TRIALS; t++) {
        const bez = bezierFromAnchors(convexRing(r, 3 + Math.floor(r() * 8)));
        // a cubic bezier lies within the convex hull (hence bbox) of its 4 control points; the whole
        // closed curve therefore lies within the bbox of ALL anchors + handles.
        const ctrl = bez.anchors.concat(bez.inHandles, bez.outHandles);
        const b = polygonBounds(ctrl);
        const EPS = 1e-9;
        for (const [x, y] of evalClosedBezier(bez, 16)) {
            assert.ok(x >= b.minx - EPS && x <= b.maxx + EPS, `trial ${t}: x ${x} outside [${b.minx},${b.maxx}]`);
            assert.ok(y >= b.miny - EPS && y <= b.maxy + EPS, `trial ${t}: y ${y} outside [${b.miny},${b.maxy}]`);
        }
    }
});

test("PROPERTY: selection selects exactly the vertices inside an axis-aligned rectangle (independent oracle)", () => {
    // The oracle is a direct point-in-rectangle test — NOT pointInPolygon (which selectInPolygon
    // uses internally). So this grades selectInPolygon against independent geometry, not itself.
    const r = rng(4);
    for (let t = 0; t < TRIALS; t++) {
        const verts = cloud(r, 60);
        const x0 = r() * 0.5, y0 = r() * 0.5, x1 = x0 + 0.15 + r() * 0.3, y1 = y0 + 0.15 + r() * 0.3;
        const rect = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];   // CCW rectangle as a polygon
        const sel = selectInPolygon(verts, rect);
        const selected = new Set(sel.left);
        for (let k = 0; k < verts.left.idx.length; k++) {
            const [x, y] = verts.left.px[k];
            const inside = x > x0 && x < x1 && y > y0 && y < y1;   // independent strict containment
            const onEdge = Math.min(Math.abs(x - x0), Math.abs(x - x1), Math.abs(y - y0), Math.abs(y - y1)) < 1e-9;
            if (!onEdge) assert.strictEqual(selected.has(verts.left.idx[k]), inside,
                `trial ${t}: vertex ${k} at (${x},${y}) vs rect [${x0},${y0}]-[${x1},${y1}]`);
        }
        assert.strictEqual(sel.total, sel.left.length, `trial ${t}: total counts left+right`);
    }
});

test("PROPERTY: the boundary ring is a subset of the selection and traces it (realistic uv usage)", () => {
    // Faithful to draw-pipeline.js's roiFromBezier path: the lasso is a DENSELY sampled bezier and
    // buildOutline gets a uv-scale epsilon. (buildOutline's default epsilon is screen-pixel scale —
    // outline.js:10-12 — so a uv caller must pass its own, which the controller does.)
    const r = rng(5);
    for (let t = 0; t < TRIALS; t++) {
        const bez = bezierFromAnchors(convexRing(r, 3 + Math.floor(r() * 6)));
        const verts = cloud(r, 100);
        const poly = evalClosedBezier(bez, 16);                   // dense lasso, as the controller samples
        const sel = selectInPolygon(verts, poly);
        const ring = buildOutline(poly, sel, { epsilon: 0.003 }); // uv-scale epsilon, as the controller passes
        const inLeft = new Set(sel.left);
        if (sel.total >= 3) {
            assert.ok(ring && ring.length >= 3, `trial ${t}: ${sel.total} selected should yield a ring >= 3`);
            for (const v of ring) {
                assert.strictEqual(v.h, "left", `trial ${t}: ring vertex hemi`);
                assert.ok(inLeft.has(v.g), `trial ${t}: ring vertex ${v.g} not in selection`);
            }
        } else if (ring) {                                        // <3 selected can't form a ring, but if
            for (const v of ring) assert.ok(inLeft.has(v.g), `trial ${t}: ring vertex not in selection`);
        }
    }
});

test("PROPERTY: membership derived from a curve is deterministic — what you see is what you get", () => {
    // Mirrors draw-pipeline.js's roiFromBezier with pure core functions: a curve is sampled
    // to a polygon, vertices are selected from it, and the boundary is re-derived. Re-running must be
    // bit-identical, and every selected/ring vertex must actually lie inside the sampled curve.
    const r = rng(6);
    for (let t = 0; t < TRIALS; t++) {
        const bez = bezierFromAnchors(convexRing(r, 3 + Math.floor(r() * 7)));
        const verts = cloud(r, 100);
        const poly = evalClosedBezier(bez, 16);

        const a = selectInPolygon(verts, poly);
        const b = selectInPolygon(verts, poly);
        assert.deepStrictEqual(b.left, a.left, `trial ${t}: selection not deterministic`);

        for (const g of a.left) {
            const k = verts.left.idx.indexOf(g);
            assert.ok(pointInPolygon(verts.left.px[k], poly), `trial ${t}: selected vertex ${g} outside the curve`);
        }
        const ring = buildOutline(poly, a);
        if (a.total) {
            const inSel = new Set(a.left);
            for (const v of ring) assert.ok(inSel.has(v.g), `trial ${t}: derived ring vertex ${v.g} not in selection`);
        }
    }
});

test("PROPERTY: a homography composed with its inverse is the identity", () => {
    const r = rng(7);
    let tested = 0;
    for (let t = 0; t < TRIALS; t++) {
        // unit square -> a convex quad (jittered so it stays well-conditioned)
        const src = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const j = () => (r() - 0.5) * 0.3;
        const dst = [[j(), j()], [1 + j(), j()], [1 + j(), 1 + j()], [j(), 1 + j()]];
        const H = fitHomography(src, dst);
        if (!H) continue;                       // skip a degenerate draw
        const Hinv = invertHomography(H);
        if (!Hinv) continue;
        for (let s = 0; s < 5; s++) {
            const p = [r(), r()];
            const back = applyHomography(Hinv, applyHomography(H, p));
            assert.ok(Math.hypot(back[0] - p[0], back[1] - p[1]) < 1e-6,
                `trial ${t}: round-trip drift on ${JSON.stringify(p)} -> ${JSON.stringify(back)}`);
        }
        tested++;
    }
    assert.ok(tested > TRIALS * 0.8, `expected most draws well-conditioned, only ${tested}/${TRIALS}`);
});

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

// Regression guard: deleteAnchor once promoted an interior anchor to endpoint while leaving its
// `smooth:true` flag and a live off-anchor handle behind. An open curve's endpoints are corners
// no matter HOW the curve got to its current anchor list, not just when freshly fit.
test("property: an open curve's endpoints stay corners after any single delete", () => {
    const rnd = rng(0xC0FFEE);
    const eq = (p, q) => p[0] === q[0] && p[1] === q[1];
    for (let c = 0; c < TRIALS; c++) {
        const bez = fitOpenBezier(randomOpenPolyline(rnd, 4 + Math.floor(rnd() * 10)));
        if (bez.anchors.length <= 2) continue;               // at the floor, delete is a no-op
        const d = deleteAnchor(bez, Math.floor(rnd() * bez.anchors.length));
        const n = d.anchors.length;
        assert.strictEqual(d.smooth[0], false, "first anchor must be a corner");
        assert.strictEqual(d.smooth[n - 1], false, "last anchor must be a corner");
        assert.ok(eq(d.inHandles[0], d.anchors[0]), "unused in-handle must sit on the first anchor");
        assert.ok(eq(d.outHandles[n - 1], d.anchors[n - 1]), "unused out-handle must sit on the last anchor");
    }
});
