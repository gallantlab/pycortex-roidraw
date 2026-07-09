import test from "node:test";
import assert from "node:assert";
import {
    fitClosedBezier, bezierFromAnchors, evalClosedBezier, catmullRomHandles,
    cloneBezier, moveAnchor, moveHandle, setAnchorSmooth, splitSegment, deleteAnchor,
    nearestOnClosedBezier, nearestOnOpenBezier, nearestOnBezier,
    fitOpenBezier, evalOpenBezier, evalBezier, isClosed, segCount,
} from "../core/bezier.js";

const sq = [[0, 0], [1, 0], [1, 1], [0, 1]]; // unit square ring
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const ptNear = (p, q, e = 1e-9) => near(p[0], q[0], e) && near(p[1], q[1], e);

test("fitClosedBezier: keeps corner anchors of a clean square", () => {
    const bez = fitClosedBezier(sq);
    assert.ok(bez && bez.closed);
    assert.strictEqual(bez.anchors.length, 4);
    assert.strictEqual(bez.inHandles.length, 4);
    assert.strictEqual(bez.outHandles.length, 4);
});

test("fitClosedBezier: drops hand tremor between corners (RDP)", () => {
    // a square edge with a tiny jitter point that RDP should remove
    const ring = [[0, 0], [0.5, 0.0005], [1, 0], [1, 1], [0, 1]];
    const bez = fitClosedBezier(ring, { epsilon: 0.01 });
    assert.strictEqual(bez.anchors.length, 4);
});

test("fitClosedBezier: dedupes a repeated closing point", () => {
    const ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const bez = fitClosedBezier(ring, { epsilon: 0.0001 });
    assert.strictEqual(bez.anchors.length, 4);
});

test("fitClosedBezier: returns null for < 3 points", () => {
    assert.strictEqual(fitClosedBezier([[0, 0], [1, 1]]), null);
    assert.strictEqual(fitClosedBezier(null), null);
});

test("fitClosedBezier: fit is independent of where the ring starts (seam at a stable extreme)", () => {
    // an arrow/house shape with one clear farthest-from-centroid point (the peak)
    const shape = [[0, 0], [1, 0], [1, 0.6], [0.5, 1.2], [0, 0.6]];
    const rot = (a, k) => a.slice(k).concat(a.slice(0, k));   // start the ring at a different vertex
    const a0 = fitClosedBezier(shape).anchors;
    for (let k = 1; k < shape.length; k++) {
        const ak = fitClosedBezier(rot(shape, k)).anchors;
        // same anchor SET regardless of start rotation (order may differ, but the curve is identical)
        const sort = (a) => a.map((p) => p.join(",")).sort();
        assert.deepStrictEqual(sort(ak), sort(a0), `start rotation ${k} produced a different fit`);
    }
});

test("fitClosedBezier: a collinear ring degrades gracefully (no crash, returns a bezier)", () => {
    const bez = fitClosedBezier([[0, 0], [1, 0], [2, 0]]);
    assert.ok(bez && bez.anchors.length >= 3);   // zero-area, but well-formed
});

test("catmullRomHandles: handles mirror about the anchor and follow the tangent", () => {
    const { inHandles, outHandles } = catmullRomHandles(sq);
    for (let i = 0; i < 4; i++) {
        // mirror: anchor is the midpoint of in/out
        assert.ok(Math.abs((inHandles[i][0] + outHandles[i][0]) / 2 - sq[i][0]) < 1e-9);
        assert.ok(Math.abs((inHandles[i][1] + outHandles[i][1]) / 2 - sq[i][1]) < 1e-9);
    }
    // anchor 1 = [1,0]; tangent = (next - prev)/6 = ([1,1]-[0,0])/6
    assert.deepStrictEqual(outHandles[1], [1 + 1 / 6, 0 + 1 / 6]);
});

test("evalClosedBezier: closed, dense, passes through every anchor", () => {
    const bez = bezierFromAnchors(sq);
    const poly = evalClosedBezier(bez, 8);
    assert.strictEqual(poly.length, 4 * 8);
    // each anchor appears in the sampled polyline (it's the t=0 sample of its segment)
    for (const a of sq) {
        assert.ok(poly.some((p) => Math.abs(p[0] - a[0]) < 1e-9 && Math.abs(p[1] - a[1]) < 1e-9),
            `anchor ${a} missing from samples`);
    }
});

test("evalClosedBezier: samplesPerSeg floors to >= 1 (one point per segment)", () => {
    const bez = bezierFromAnchors(sq);
    assert.strictEqual(evalClosedBezier(bez, 0).length, sq.length);    // 0 -> floored to 1/seg
    assert.strictEqual(evalClosedBezier(bez, 0.9).length, sq.length);  // fractional -> floored to 1/seg
});

test("evalClosedBezier: a smooth blob stays near its anchors (no blow-up)", () => {
    const ring = [[0.4, 0.5], [0.5, 0.42], [0.6, 0.5], [0.5, 0.58]];
    const bez = bezierFromAnchors(ring);
    const poly = evalClosedBezier(bez, 16);
    for (const p of poly) {
        assert.ok(p[0] > 0.3 && p[0] < 0.7 && p[1] > 0.3 && p[1] < 0.7, `sample ${p} escaped the blob`);
    }
});

// --- full bezier controls (edit operations) ------------------------------------------------

test("bezierFromAnchors: every anchor starts smooth", () => {
    const bez = bezierFromAnchors(sq);
    assert.deepStrictEqual(bez.smooth, [true, true, true, true]);
});

test("cloneBezier: deep copy + back-fills a missing smooth array as all-true", () => {
    const raw = { closed: true, anchors: [[0, 0], [1, 0], [0, 1]],
                  inHandles: [[0, 0], [1, 0], [0, 1]], outHandles: [[0, 0], [1, 0], [0, 1]] };
    const b = cloneBezier(raw);
    assert.deepStrictEqual(b.smooth, [true, true, true]);
    b.anchors[0][0] = 99;
    assert.strictEqual(raw.anchors[0][0], 0, "clone must not alias the source");
});

test("cloneBezier: pads a too-short smooth array to one-per-anchor (missing tail = smooth)", () => {
    // a malformed bezier whose smooth is shorter than anchors must not leave smooth[i] undefined
    // (undefined reads as 'corner' in moveHandle, silently breaking the curve).
    const raw = { closed: true, anchors: [[0, 0], [1, 0], [1, 1], [0, 1]],
                  inHandles: [[0, 0], [1, 0], [1, 1], [0, 1]], outHandles: [[0, 0], [1, 0], [1, 1], [0, 1]],
                  smooth: [false, true] };  // only 2 of 4
    const b = cloneBezier(raw);
    assert.strictEqual(b.smooth.length, 4, "smooth must be one-per-anchor");
    assert.deepStrictEqual(b.smooth, [false, true, true, true], "preserve given flags, pad tail as smooth");
});

test("moveAnchor: carries both handles by the same delta (does not mutate input)", () => {
    const bez = bezierFromAnchors(sq);
    const before = JSON.stringify(bez);
    const inRel = sub(bez.inHandles[1], bez.anchors[1]);
    const outRel = sub(bez.outHandles[1], bez.anchors[1]);
    const m = moveAnchor(bez, 1, [5, 7]);
    assert.deepStrictEqual(m.anchors[1], [5, 7]);
    assert.ok(ptNear(sub(m.inHandles[1], m.anchors[1]), inRel), "in handle keeps its offset");
    assert.ok(ptNear(sub(m.outHandles[1], m.anchors[1]), outRel), "out handle keeps its offset");
    assert.strictEqual(JSON.stringify(bez), before, "input bezier unchanged");
});

test("moveHandle: smooth anchor mirrors the opposite handle; corner moves it alone", () => {
    let bez = bezierFromAnchors(sq);
    const a = bez.anchors[2];
    bez = moveHandle(bez, 2, "out", [a[0] + 0.3, a[1] + 0.1]);
    // smooth: the in handle is the mirror of the out handle about the anchor
    assert.ok(ptNear(bez.inHandles[2], [2 * a[0] - bez.outHandles[2][0], 2 * a[1] - bez.outHandles[2][1]]));

    let corner = setAnchorSmooth(bezierFromAnchors(sq), 2, false);
    const inBefore = corner.inHandles[2].slice();
    corner = moveHandle(corner, 2, "out", [a[0] + 0.3, a[1] + 0.1]);
    assert.ok(ptNear(corner.inHandles[2], inBefore), "corner anchor leaves the opposite handle put");
});

test("setAnchorSmooth: smoothing makes the handles collinear + mirrored about the anchor", () => {
    let bez = setAnchorSmooth(bezierFromAnchors(sq), 1, false);
    // distort it into a cusp, then re-smooth
    bez.outHandles[1] = [bez.anchors[1][0] + 0.2, bez.anchors[1][1] - 0.4];
    bez.inHandles[1] = [bez.anchors[1][0] - 0.1, bez.anchors[1][1] - 0.05];
    const s = setAnchorSmooth(bez, 1, true);
    const a = s.anchors[1];
    const o = sub(s.outHandles[1], a), i = sub(s.inHandles[1], a);
    assert.ok(near(o[0] + i[0], 0) && near(o[1] + i[1], 0), "in = -out about the anchor (mirrored)");
    assert.ok(s.smooth[1] === true);
});

test("splitSegment: adds one smooth anchor and leaves the curve shape unchanged", () => {
    // local cubic eval, to check the de Casteljau identity exactly (not via discrete samples)
    const cubic = (p0, c1, c2, p3, t) => {
        const mt = 1 - t, A = mt * mt * mt, B = 3 * mt * mt * t, C = 3 * mt * t * t, D = t * t * t;
        return [A * p0[0] + B * c1[0] + C * c2[0] + D * p3[0],
                A * p0[1] + B * c1[1] + C * c2[1] + D * p3[1]];
    };
    const bez = bezierFromAnchors([[0.4, 0.5], [0.5, 0.42], [0.6, 0.5], [0.5, 0.58]]);
    const seg = 1, tsplit = 0.37;
    const O = [bez.anchors[seg], bez.outHandles[seg], bez.inHandles[seg + 1], bez.anchors[seg + 1]];
    const s = splitSegment(bez, seg, tsplit);
    assert.strictEqual(s.anchors.length, bez.anchors.length + 1);
    assert.strictEqual(s.inHandles.length, s.anchors.length);
    assert.strictEqual(s.outHandles.length, s.anchors.length);
    assert.strictEqual(s.smooth.length, s.anchors.length);
    assert.strictEqual(s.smooth[seg + 1], true, "the inserted anchor is smooth");
    assert.ok(ptNear(s.anchors[seg + 1], cubic(...O, tsplit)), "new anchor sits on the original curve");
    // the two sub-cubics reproduce the original segment exactly (de Casteljau identity)
    const left = [s.anchors[seg], s.outHandles[seg], s.inHandles[seg + 1], s.anchors[seg + 1]];
    const right = [s.anchors[seg + 1], s.outHandles[seg + 1], s.inHandles[seg + 2], s.anchors[seg + 2]];
    for (let k = 0; k <= 10; k++) {
        const u = k / 10;
        assert.ok(ptNear(cubic(...left, u), cubic(...O, u * tsplit), 1e-12), "left sub-curve matches");
        assert.ok(ptNear(cubic(...right, u), cubic(...O, tsplit + u * (1 - tsplit)), 1e-12), "right matches");
    }
});

test("deleteAnchor: removes an anchor but refuses to drop below 3", () => {
    const bez = bezierFromAnchors(sq);
    const d = deleteAnchor(bez, 1);
    assert.strictEqual(d.anchors.length, 3);
    assert.strictEqual(d.smooth.length, 3);
    const tri = bezierFromAnchors([[0, 0], [1, 0], [0, 1]]);
    assert.strictEqual(deleteAnchor(tri, 0).anchors.length, 3, "a triangle is the floor");
});

test("deleteAnchor: removing an open curve's first anchor promotes a corner endpoint (smooth=false, unused handle on anchor)", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0], [3, 1]]);
    const d = deleteAnchor(bez, 0);
    assert.strictEqual(d.smooth[0], false, "promoted endpoint must be a corner");
    assert.ok(ptNear(d.inHandles[0], d.anchors[0]), "unused in-handle must sit on the new endpoint anchor");
});

test("deleteAnchor: removing an open curve's last anchor promotes a corner endpoint (smooth=false, unused handle on anchor)", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0], [3, 1]]);
    const d = deleteAnchor(bez, bez.anchors.length - 1);
    const last = d.anchors.length - 1;
    assert.strictEqual(d.smooth[last], false, "promoted endpoint must be a corner");
    assert.ok(ptNear(d.outHandles[last], d.anchors[last]), "unused out-handle must sit on the new endpoint anchor");
});

test("deleteAnchor: removing an interior anchor of an open curve leaves both endpoints untouched", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0], [3, 1]]);
    const d = deleteAnchor(bez, 1); // interior anchor, endpoints (0 and n-1) must be unaffected
    assert.strictEqual(d.smooth[0], false);
    assert.ok(ptNear(d.inHandles[0], d.anchors[0]));
    assert.ok(ptNear(d.outHandles[0], bez.outHandles[0]), "endpoint 0's live handle unchanged");
    const last = d.anchors.length - 1;
    assert.strictEqual(d.smooth[last], false);
    assert.ok(ptNear(d.outHandles[last], d.anchors[last]));
    assert.ok(ptNear(d.inHandles[last], bez.inHandles[bez.anchors.length - 1]), "endpoint n-1's live handle unchanged");
});

test("deleteAnchor: closed bezier anchors are unaffected by the open-endpoint normalization", () => {
    const bez = fitClosedBezier([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, -0.3]]);
    const d = deleteAnchor(bez, 2);
    assert.ok(d.smooth.every((s) => s === true), "closed bezier anchors remain smooth after deletion");
});

test("nearestOnClosedBezier: finds a point on the curve near a query", () => {
    const bez = bezierFromAnchors(sq);
    const hit = nearestOnClosedBezier(bez, [0.5, -0.2], 24);   // near the bottom edge (anchor0->anchor1)
    assert.ok(hit && hit.dist < 0.3);
    assert.ok(hit.seg >= 0 && hit.seg < 4 && hit.t >= 0 && hit.t <= 1);
});

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

function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }

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

/* ---------------------------------------------------------------------------------------------
 * Out-of-range guards. The edit overlay holds a drag target `{i, which}` across events; if the
 * anchor list shrinks under it (Delete pressed mid-drag), a stale `i` used to write past the end
 * of the handle arrays, silently desynchronizing their lengths from `anchors`.
 * ------------------------------------------------------------------------------------------- */

test("moveAnchor: an out-of-range index is a no-op, not array corruption", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    for (const i of [3, 99, -1]) {
        const r = moveAnchor(bez, i, [9, 9]);
        assert.strictEqual(r.anchors.length, 3, "anchors grew at i=" + i);
        assert.strictEqual(r.inHandles.length, 3, "inHandles grew at i=" + i);
        assert.strictEqual(r.outHandles.length, 3, "outHandles grew at i=" + i);
        assert.deepStrictEqual(r.anchors, bez.anchors, "geometry changed at i=" + i);
    }
});

test("moveHandle: an out-of-range index is a no-op, not array corruption", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    for (const i of [3, 99, -1]) {
        for (const which of ["in", "out"]) {
            const r = moveHandle(bez, i, which, [9, 9]);
            assert.strictEqual(r.anchors.length, 3);
            assert.strictEqual(r.inHandles.length, 3, "inHandles grew at i=" + i + "/" + which);
            assert.strictEqual(r.outHandles.length, 3, "outHandles grew at i=" + i + "/" + which);
            assert.deepStrictEqual(r.inHandles, bez.inHandles);
            assert.deepStrictEqual(r.outHandles, bez.outHandles);
        }
    }
});

test("moveAnchor/moveHandle: handle arrays stay parallel to anchors after a delete", () => {
    // the exact sequence the overlay produced: grab the last anchor's handle, then Delete it
    const bez = deleteAnchor(fitOpenBezier([[0, 0], [1, 1], [2, 0], [3, 1]]), 3);
    const r = moveHandle(bez, 3, "in", [9, 9]);            // stale drag index
    assert.strictEqual(r.inHandles.length, r.anchors.length);
    assert.strictEqual(r.outHandles.length, r.anchors.length);
    assert.strictEqual(r.smooth.length, r.anchors.length);
});

test("moveAnchor/moveHandle: an in-range index still works (guard isn't over-broad)", () => {
    const bez = fitOpenBezier([[0, 0], [1, 1], [2, 0]]);
    assert.deepStrictEqual(moveAnchor(bez, 1, [5, 5]).anchors[1], [5, 5]);
    assert.deepStrictEqual(moveHandle(bez, 1, "out", [5, 5]).outHandles[1], [5, 5]);
});
