import test from "node:test";
import assert from "node:assert";
import { fitClosedBezier, bezierFromAnchors, evalClosedBezier, catmullRomHandles } from "../core/bezier.js";

const sq = [[0, 0], [1, 0], [1, 1], [0, 1]]; // unit square ring

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
