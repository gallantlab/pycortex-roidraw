import test from "node:test";
import assert from "node:assert";
import { selectInPolygon } from "../core/selection.js";
import { buildOutline, pickLabelVertex } from "../core/outline.js";

// A 4x4 grid of left-hemi vertices at px (10..40, 10..40), subject indices 0..15,
// plus one far-away right-hemi vertex that must NOT be selected by a left-side lasso.
function gridProjected() {
    const idx = [], px = [];
    let g = 0;
    for (let y = 10; y <= 40; y += 10)
        for (let x = 10; x <= 40; x += 10) { idx.push(g++); px.push([x, y]); }
    return { left: { idx, px }, right: { idx: [99], px: [[500, 500]] } };
}

const LASSO = [[5, 5], [45, 5], [45, 45], [5, 45]]; // covers the whole left grid, not the right vertex

test("selectInPolygon: selects enclosed vertices, excludes far hemi", () => {
    const sel = selectInPolygon(gridProjected(), LASSO);
    assert.strictEqual(sel.left.length, 16);
    assert.strictEqual(sel.right.length, 0);
    assert.strictEqual(sel.total, 16);
    assert.strictEqual(sel.px.left.length, 16); // px kept aligned with indices
});

test("selectInPolygon: tight lasso selects a subset", () => {
    const sel = selectInPolygon(gridProjected(), [[8, 8], [22, 8], [22, 22], [8, 22]]);
    assert.deepStrictEqual(sel.left.sort((a, b) => a - b), [0, 1, 4, 5]);
});

test("buildOutline: returns a vertex ring; pickLabelVertex returns a selected vertex", () => {
    const sel = selectInPolygon(gridProjected(), LASSO);
    const ring = buildOutline(LASSO, sel);
    assert.ok(Array.isArray(ring) && ring.length >= 3);
    for (const v of ring) { assert.strictEqual(v.h, "left"); assert.ok(sel.left.includes(v.g)); }
    const lv = pickLabelVertex(sel);
    assert.strictEqual(lv.h, "left");
    assert.ok(sel.left.includes(lv.g));
});

test("buildOutline: null when nothing selected", () => {
    assert.strictEqual(buildOutline(LASSO, { left: [], right: [], px: { left: [], right: [] } }), null);
});
