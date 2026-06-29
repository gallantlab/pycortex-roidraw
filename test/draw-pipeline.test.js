/*
 * draw-pipeline.test.js — the controller's ROI-derivation pipeline, driven against a synthetic
 * surface (FakeSurfaceAdapter). This is the "is it doing what we think" test: a lasso/curve over a
 * grid whose geometry is analytically known must select exactly the vertices it encloses, fit an
 * editable bezier, and re-derive identical membership. No DOM, no browser, no pycortex.
 */
import test from "node:test";
import assert from "node:assert";
import { FakeSurfaceAdapter } from "./fake-adapter.js";
import { deriveRoiFromLasso, roiFromBezier, backfillBezier } from "../draw-pipeline.js";
import { bezierFromAnchors, evalClosedBezier } from "../core/bezier.js";
import { pointInPolygon } from "../core/geom.js";

// grid 11x11: vertex (i,j) has subject index i*11+j, uv [i/10, j/10], px uv*1000.
const adapter = () => new FakeSurfaceAdapter({ grid: 11 });
const uvOf = (g) => [Math.floor(g / 11) / 10, (g % 11) / 10];

test("deriveRoiFromLasso: selects the enclosed grid vertices and fits a bezier", () => {
    const a = adapter();
    // a px square covering uv [0.25, 0.75]
    const pts = [[250, 250], [750, 250], [750, 750], [250, 750]];
    const roi = deriveRoiFromLasso(a, pts);

    assert.ok(roi && roi.total > 0, "should select something");
    assert.ok(roi.bezier, "should fit an editable bezier");
    assert.strictEqual(roi.right.length, 0, "a left-side lasso must not select the far right vertex");

    const selected = new Set(roi.left);
    for (const g of a.allVertexUV().left.idx) {
        const [u, v] = uvOf(g);
        const wellInside = u >= 0.35 && u <= 0.65 && v >= 0.35 && v <= 0.65;
        const wellOutside = u <= 0.1 || u >= 0.9 || v <= 0.1 || v >= 0.9;
        if (wellInside) assert.ok(selected.has(g), `interior vertex ${g} (uv ${u},${v}) should be selected`);
        if (wellOutside) assert.ok(!selected.has(g), `exterior vertex ${g} (uv ${u},${v}) should NOT be selected`);
    }

    const inSel = new Set(roi.left);
    for (const o of roi.outline) assert.ok(o.h === "left" && inSel.has(o.g), `outline vertex ${o.g} must be in the selection`);
    assert.ok(inSel.has(roi.labelVert.g), "label vertex must be in the selection");
});

test("deriveRoiFromLasso: a lasso enclosing nothing selects nothing", () => {
    const a = adapter();
    const pts = [[5300, 5300], [5400, 5300], [5400, 5400], [5300, 5400]]; // empty region, far from the grid
    const roi = deriveRoiFromLasso(a, pts);
    assert.strictEqual(roi.total, 0);
});

test("roiFromBezier: membership equals exactly the vertices the sampled curve encloses", () => {
    const a = adapter();
    const bez = bezierFromAnchors([[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]]);
    // ground truth: brute-force point-in-polygon over the SAME sampled curve the pipeline uses
    const poly = evalClosedBezier(bez, 16);
    const truth = new Set();
    for (const g of a.allVertexUV().left.idx) if (pointInPolygon(uvOf(g), poly)) truth.add(g);

    const roi = roiFromBezier(a, bez);
    assert.deepStrictEqual(new Set(roi.left), truth, "selected set must match the curve's interior exactly");
    assert.ok(truth.size > 0, "sanity: the curve should enclose some grid vertices");
});

test("roiFromBezier: re-derivation is deterministic (what you see is what you get)", () => {
    const a = adapter();
    const bez = bezierFromAnchors([[0.2, 0.2], [0.8, 0.25], [0.75, 0.8], [0.25, 0.7]]);
    const r1 = roiFromBezier(a, bez);
    const r2 = roiFromBezier(a, bez);
    assert.deepStrictEqual(r1.left, r2.left);
    assert.deepStrictEqual(r1.outline, r2.outline);
    assert.deepStrictEqual(r1.labelVert, r2.labelVert);
});

test("backfillBezier: fits an editable curve for a v1 ROI from its outline ring", () => {
    const a = adapter();
    // corners (2,2)(8,2)(8,8)(2,8) as left subject indices i*11+j
    const ring = [2 * 11 + 2, 8 * 11 + 2, 8 * 11 + 8, 2 * 11 + 8].map((g) => ({ h: "left", g }));
    const bez = backfillBezier(a, ring);
    assert.ok(bez && bez.anchors.length >= 3, "should fit a bezier from the outline ring");
});

test("backfillBezier: returns null when the ring has too few uv-resolvable points", () => {
    const a = adapter();
    assert.strictEqual(backfillBezier(a, [{ h: "left", g: 0 }, { h: "left", g: 1 }]), null);
});

test("round-trip: a drawn lasso's bezier re-derives a non-empty membership inside the lassoed region", () => {
    const a = adapter();
    const pts = [[300, 300], [700, 300], [700, 700], [300, 700]];
    const roi = deriveRoiFromLasso(a, pts);
    const again = roiFromBezier(a, roi.bezier);
    assert.ok(again.total > 0, "re-deriving from the stored bezier must still select vertices");
    for (const g of again.left) {
        const [u, v] = uvOf(g);
        assert.ok(u >= 0.2 && u <= 0.8 && v >= 0.2 && v <= 0.8, `re-derived vertex ${g} should sit within the lassoed region`);
    }
});
