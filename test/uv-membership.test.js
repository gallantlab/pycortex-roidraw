/*
 * uv-membership.test.js — guards the composition index.js uses to derive ROI membership from a
 * bezier ENTIRELY in flat-UV space (the view-independent path that makes a reloaded ROI select
 * the same vertices). selectInPolygon/buildOutline are coordinate-agnostic, so we feed them uv.
 */
import test from "node:test";
import assert from "node:assert";
import { bezierFromAnchors, evalClosedBezier } from "../core/bezier.js";
import { selectInPolygon } from "../core/selection.js";
import { buildOutline } from "../core/outline.js";

// a synthetic 21x21 grid of "left-hemi" vertices over [0,1]^2, as allVertexUV() would return
function grid(n = 21) {
    const idx = [], uv = [];
    let g = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        idx.push(g++);
        uv.push([i / (n - 1), j / (n - 1)]);
    }
    return { left: { idx, uv }, right: { idx: [], uv: [] } };
}

test("bezier -> uv polygon -> selectInPolygon selects the enclosed vertices", () => {
    const bez = bezierFromAnchors([[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]]);
    const poly = evalClosedBezier(bez, 16);
    const all = grid();
    const projectedUv = { left: { idx: all.left.idx, px: all.left.uv }, right: { idx: all.right.idx, px: all.right.uv } };
    const sel = selectInPolygon(projectedUv, poly);

    assert.ok(sel.total > 0, "nothing selected");
    // every selected vertex's uv must be inside the bezier's bounding box (sanity)
    for (let k = 0; k < sel.left.length; k++) {
        const uv = all.left.uv[sel.left[k]];
        assert.ok(uv[0] >= 0.25 && uv[0] <= 0.75 && uv[1] >= 0.25 && uv[1] <= 0.75,
            `selected vertex ${uv} is outside the shape`);
    }
    // a deep-interior vertex is selected; far-corner vertices are not
    const interior = all.left.idx[Math.floor(all.left.idx.length / 2)]; // (0.5,0.5)
    assert.ok(sel.left.includes(interior), "center vertex not selected");
    const corner = all.left.uv.findIndex((p) => p[0] === 0 && p[1] === 0);
    assert.ok(!sel.left.includes(corner), "far corner wrongly selected");
});

test("buildOutline over the same uv space returns an ordered ring of >= 3 vertices", () => {
    const bez = bezierFromAnchors([[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]]);
    const poly = evalClosedBezier(bez, 16);
    const all = grid();
    const projectedUv = { left: { idx: all.left.idx, px: all.left.uv }, right: { idx: all.right.idx, px: all.right.uv } };
    const sel = selectInPolygon(projectedUv, poly);
    const ring = buildOutline(poly, sel);
    assert.ok(ring && ring.length >= 3, "no ring built");
    for (const o of ring) assert.strictEqual(o.h, "left");
});
