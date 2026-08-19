/*
 * draw-pipeline.test.js — the controller's ROI-derivation pipeline, driven against a synthetic
 * surface (FakeSurfaceAdapter). This is the "is it doing what we think" test: a lasso/curve over a
 * grid whose geometry is analytically known must select exactly the vertices it encloses, fit an
 * editable bezier, and re-derive identical membership. No DOM, no browser, no pycortex.
 */
import test from "node:test";
import assert from "node:assert";
import { FakeSurfaceAdapter } from "./fake-adapter.js";
import { deriveRoiFromLasso, roiFromBezier, backfillBezier, backfillLabel, curveFromTrace, nearestVertexTo, labelForCurve } from "../draw-pipeline.js";
import { bezierFromAnchors, evalClosedBezier, evalOpenBezier } from "../core/bezier.js";
import { pointInPolygon } from "../core/geom.js";
import { fitHomography, applyHomography } from "../core/transform.js";

// grid 11x11: vertex (i,j) has subject index i*11+j, uv [i/10, j/10]. px is a REAL rotated/offset
// projection of uv (see fake-adapter.js), so px-space lassos must round-trip through that transform.
const adapter = () => new FakeSurfaceAdapter({ grid: 11 });
const uvOf = (g) => [Math.floor(g / 11) / 10, (g % 11) / 10];
// build a px lasso by projecting a uv rectangle's corners through the same projection the surface uses
const lassoUvRect = (a, u0, v0, u1, v1) =>
    [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => a.projectUv("left", u, v));

test("deriveRoiFromLasso: selects the enclosed grid vertices and fits a bezier", () => {
    const a = adapter();
    // lasso the PROJECTED image of the uv square [0.25, 0.75] — a rotated quad in px space
    const pts = lassoUvRect(a, 0.25, 0.25, 0.75, 0.75);
    const roi = deriveRoiFromLasso(a, pts);

    assert.ok(roi && roi.total > 0, "should select something");
    assert.ok(roi.bezier, "should fit an editable bezier");
    assert.strictEqual(roi.right.length, 0, "a left-side lasso must not select the beside-it right hemisphere grid");

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

test("deriveRoiFromLasso: a lasso in a gap BETWEEN grid rows selects nothing", () => {
    const a = adapter();
    // grid vertices sit at uv multiples of 0.1; this rect lives strictly between rows/cols → no vertex
    const pts = lassoUvRect(a, 0.42, 0.42, 0.48, 0.48);
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

test("backfillLabel: picks the ring vertex nearest the centroid (same rule as fresh ROIs)", () => {
    const a = adapter();
    // a small square ring around uv (0.4..0.6); the centroid sits at (0.5,0.5). Add a center vertex
    // (5,5)=uv(0.5,0.5) which must win as nearest-to-centroid.
    const corner = (i, j) => ({ h: "left", g: i * 11 + j });
    const ring = [corner(4, 4), corner(6, 4), corner(6, 6), corner(4, 6), corner(5, 5)];
    const lv = backfillLabel(a, ring);
    assert.deepStrictEqual(lv, { h: "left", g: 5 * 11 + 5 }, "the centre vertex is nearest the centroid");
});

test("backfillLabel: returns null for an empty/uv-less ring", () => {
    assert.strictEqual(backfillLabel(adapter(), []), null);
});

test("deriveRoiFromLasso: a returned bezier always matches the stored vertices; else it is dropped", () => {
    // Force the fallback branch deterministically: a surface where the lasso projection still selects
    // vertices (projectVertices non-empty) but the uv-space membership is empty (allVertexUV empty), so
    // roiFromBezier re-derives to zero. The pipeline must NOT keep a bezier that encloses nothing.
    const base = adapter();
    const starved = Object.create(base);
    starved.allVertexUV = () => ({ left: { idx: [], uv: [] }, right: { idx: [], uv: [] } });
    const roi = deriveRoiFromLasso(starved, lassoUvRect(base, 0.25, 0.25, 0.75, 0.75));
    assert.ok(roi.total > 0, "the lasso still selects vertices (fallback path)");
    assert.strictEqual(roi.bezier, null, "a bezier that encloses nothing must not be attached");

    // and in the normal case the attached bezier's re-derived membership equals the stored vertices
    const ok = deriveRoiFromLasso(adapter(), lassoUvRect(base, 0.25, 0.25, 0.75, 0.75));
    assert.ok(ok.bezier, "normal case keeps the editable bezier");
    assert.deepStrictEqual(new Set(roiFromBezier(adapter(), ok.bezier).left), new Set(ok.left),
        "stored vertices equal the bezier's own membership (no disagreement)");
});

test("round-trip: a drawn lasso's bezier re-derives a non-empty membership inside the lassoed region", () => {
    const a = adapter();
    const pts = lassoUvRect(a, 0.3, 0.3, 0.7, 0.7);
    const roi = deriveRoiFromLasso(a, pts);
    const again = roiFromBezier(a, roi.bezier);
    assert.ok(again.total > 0, "re-deriving from the stored bezier must still select vertices");
    for (const g of again.left) {
        const [u, v] = uvOf(g);
        // tight: every re-derived vertex must lie within the actual lassoed uv rectangle [0.3,0.7]
        assert.ok(u >= 0.3 && u <= 0.7 && v >= 0.3 && v <= 0.7, `re-derived vertex ${g} (uv ${u},${v}) should sit within the lassoed region`);
    }
});

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

test("labelForCurve: equals nearestVertexTo of the curve's midpoint sample, computed independently", () => {
    const a = adapter();
    const bez = bezierFromAnchors([[0.2, 0.3], [0.4, 0.35], [0.6, 0.4], [0.8, 0.45]], false);
    // independently reproduce the "midpoint sample" rule: sample the open curve, take the middle point
    const TRACE_SAMPLES = 24;
    const poly = evalOpenBezier(bez, TRACE_SAMPLES);
    const expected = nearestVertexTo(a, poly[poly.length >> 1]);

    const lv = labelForCurve(a, bez);
    assert.deepStrictEqual(lv, expected, "labelForCurve must pick the vertex nearest the curve's midpoint sample");
});

test("labelForCurve: a differently-placed (translated) curve gets a DIFFERENT label vertex", () => {
    // This is the regression test for the stale-label bug: reshaping a sulcus must relabel it.
    const a = adapter();
    const bez1 = bezierFromAnchors([[0.2, 0.3], [0.4, 0.35], [0.6, 0.4], [0.8, 0.45]], false);
    const bez2 = bezierFromAnchors([[0.2, 0.6], [0.4, 0.65], [0.6, 0.7], [0.8, 0.75]], false); // shifted in v
    const lv1 = labelForCurve(a, bez1);
    const lv2 = labelForCurve(a, bez2);
    assert.ok(lv1 && lv2, "both curves should resolve a label vertex");
    assert.notDeepStrictEqual(lv1, lv2, "a reshaped/moved curve must not keep the old label vertex");
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

test("uvPxCorrespondences: flattens both hemispheres, default bounds = the whole flatmap", async () => {
    const { uvPxCorrespondences, ALL_UV_BOUNDS } = await import("../adapter/viewer-adapter.js");
    const ad = new FakeSurfaceAdapter({ grid: 5 });
    const all = uvPxCorrespondences(ad);
    assert.equal(all.src.length, 2 * 25);
    assert.equal(all.dst.length, all.src.length);
    assert.deepEqual(all.src[0], ad.allVertexUV().left.uv[0]);
    assert.deepEqual(all.dst[0], ad.projectVertices().left.px[0]);
    assert.deepEqual(uvPxCorrespondences(ad, ALL_UV_BOUNDS), all);
    // a local box around the left hemi's corner keeps only those vertices
    const local = uvPxCorrespondences(ad, { minu: -0.1, maxu: 0.3, minv: -0.1, maxv: 0.3 });
    assert.equal(local.src.length, 4);
});
