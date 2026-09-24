/*
 * svg-path.test.js — the one writer of a shape's overlay path `d`: flat-UV -> viewBox px with the
 * v-flip, a closed bezier ends in `Z` and an open one does not, and an ROI whose bezier can't be
 * emitted falls back to its vertex ring while a sulcus never does.
 */
import test from "node:test";
import assert from "node:assert";
import { bezierSvgPath, ringSvgPath, shapeSvgPath, uvToViewBox } from "../core/svg-path.js";

const W = 200, H = 100;

// A straight-handled bezier: each handle sits on its anchor, so every control point is an anchor.
const bez = (anchors, closed) => ({ anchors, inHandles: anchors, outHandles: anchors, closed });
const TRI = [[0, 0], [1, 0], [0.5, 1]];

test("uv maps to viewBox px with v flipped (v=0 is the bottom edge)", () => {
    assert.deepStrictEqual(uvToViewBox([0, 0], W, H), [0, H]);
    assert.deepStrictEqual(uvToViewBox([1, 1], W, H), [W, 0]);
    assert.deepStrictEqual(uvToViewBox([0.25, 0.5], W, H), [50, 50]);
});

test("a closed bezier wraps back to anchor 0 and ends with Z", () => {
    const d = bezierSvgPath(bez(TRI, true), W, H);
    assert.strictEqual(d,
        "M0.00,100.00" +
        "C0.00,100.00 200.00,100.00 200.00,100.00" +
        "C200.00,100.00 100.00,0.00 100.00,0.00" +
        "C100.00,0.00 0.00,100.00 0.00,100.00Z");
});

test("an open bezier has n-1 segments and no Z (what marks a sulcus on disk)", () => {
    const d = bezierSvgPath(bez([[0, 0], [1, 1]], false), W, H);
    assert.strictEqual(d, "M0.00,100.00C0.00,100.00 200.00,0.00 200.00,0.00");
});

test("a bezier with too few anchors for its kind yields null", () => {
    assert.strictEqual(bezierSvgPath(bez([[0, 0], [1, 1]], true), W, H), null);
    assert.strictEqual(bezierSvgPath(bez([[0, 0]], false), W, H), null);
    assert.strictEqual(bezierSvgPath(null, W, H), null);
});

test("a ring is a smoothed closed polyline, or null under 3 points", () => {
    const d = ringSvgPath(TRI, W, H);
    assert.match(d, /^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+)+Z$/);
    assert.strictEqual((d.match(/L/g) || []).length, 3 * 4 - 1, "2 Chaikin passes turn 3 points into 12");
    assert.strictEqual(ringSvgPath(TRI.slice(0, 2), W, H), null);
    assert.strictEqual(ringSvgPath(null, W, H), null);
});

test("shapeSvgPath prefers the bezier, falls back to an ROI's ring, never a sulcus's", () => {
    const ring = [{ h: "left", g: 0 }, { h: "left", g: 1 }, { h: "left", g: 2 }];
    const vertexUV = (o) => TRI[o.g];
    const good = bez(TRI, true), bad = bez([[0, 0]], true);
    assert.strictEqual(shapeSvgPath({ kind: "roi", bezier: good, outline: ring }, W, H, vertexUV), bezierSvgPath(good, W, H));
    assert.strictEqual(shapeSvgPath({ kind: "roi", bezier: bad, outline: ring }, W, H, vertexUV), ringSvgPath(TRI, W, H));
    assert.strictEqual(shapeSvgPath({ kind: "sulcus", bezier: bad, outline: ring }, W, H, vertexUV), null);
    assert.strictEqual(shapeSvgPath({ kind: "roi", outline: ring.slice(0, 2) }, W, H, vertexUV), null);
});

test("ring vertices without uv are dropped before the 3-point check", () => {
    const ring = [{ h: "left", g: 0 }, { h: "left", g: 1 }, { h: "left", g: 9 }];
    const vertexUV = (o) => TRI[o.g] || null;
    assert.strictEqual(shapeSvgPath({ kind: "roi", outline: ring }, W, H, vertexUV), null);
});
