/*
 * overlay-geom.test.js — the pure hit-testing math behind the bezier edit overlay, extracted so the
 * grab-an-anchor / grab-a-handle logic is unit-testable without a canvas or DOM.
 */
import test from "node:test";
import assert from "node:assert";
import { nearestWithin, hitTest } from "../ui/overlay-geom.js";

test("nearestWithin: returns the closest point within the radius", () => {
    const pts = [[0, 0], [10, 0], [3, 4]];
    assert.strictEqual(nearestWithin(pts, [3, 5], 5), 2, "the (3,4) point is closest to (3,5)");
});

test("nearestWithin: returns -1 when nothing is within the radius", () => {
    assert.strictEqual(nearestWithin([[0, 0], [100, 100]], [50, 50], 5), -1);
});

test("nearestWithin: a point exactly on the radius counts (<=)", () => {
    assert.strictEqual(nearestWithin([[5, 0]], [0, 0], 5), 0);
});

test("hitTest: a selected anchor's handle takes priority over the anchor", () => {
    const anchorPx = [[0, 0], [50, 0]];
    const handlePx = { out: [60, 0], in: [40, 0] };   // handles of the selected anchor #1
    const hit = hitTest(anchorPx, handlePx, 1, [60, 1], { hitRadius: 9, handleRadius: 8 });
    assert.deepStrictEqual(hit, { kind: "handle", i: 1, which: "out" });
});

test("hitTest: falls back to the nearest anchor when no handle is hit", () => {
    const hit = hitTest([[0, 0], [50, 0]], { out: [200, 0], in: [-200, 0] }, 1, [49, 1], { hitRadius: 9, handleRadius: 8 });
    assert.deepStrictEqual(hit, { kind: "anchor", i: 1 });
});

test("hitTest: handles are ignored when no anchor is selected", () => {
    const hit = hitTest([[0, 0]], null, -1, [0, 0], { hitRadius: 9, handleRadius: 8 });
    assert.deepStrictEqual(hit, { kind: "anchor", i: 0 });
});

test("hitTest: returns null when the click is near nothing", () => {
    assert.strictEqual(hitTest([[0, 0]], null, -1, [100, 100], { hitRadius: 9, handleRadius: 8 }), null);
});
