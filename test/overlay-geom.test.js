/*
 * overlay-geom.test.js — the pure pointer math behind the overlays (click-vs-drag, degenerate
 * strokes, anchor/handle hit-testing), extracted so it is unit-testable without a canvas or DOM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CLICK_SLOP, movedPast, isUsableStroke, nearestWithin, hitTest } from "../ui/overlay-geom.js";

const R = { hitRadius: 9, handleRadius: 8 };

test("movedPast: within the slop is a click, past it is a drag (Euclidean)", () => {
    assert.equal(movedPast([0, 0], [CLICK_SLOP, 0]), false, "exactly on the slop is still a click");
    assert.equal(movedPast([0, 0], [CLICK_SLOP + 0.1, 0]), true);
    assert.equal(movedPast([0, 0], [2.5, 2.5]), true, "diagonal distance, not per-axis");
    assert.equal(movedPast([10, 10], [11, 11], 1), true, "an explicit radius overrides the default");
});

test("isUsableStroke: a click with a little wobble is rejected for both tools", () => {
    const wobble = [[0, 0], [1, 1], [2, 0], [1, -1]];
    assert.equal(isUsableStroke(wobble, true), false);
    assert.equal(isUsableStroke(wobble, false), false);
});

test("isUsableStroke: a trace needs 2 points, a closed lasso 3", () => {
    const line = [[0, 0], [50, 0]];
    assert.equal(isUsableStroke(line, false), true, "a 2-point line is a valid trace");
    assert.equal(isUsableStroke(line, true), false, "2 points can't bound an area");
    assert.equal(isUsableStroke([[0, 0], [50, 0], [25, 40]], true), true);
    assert.equal(isUsableStroke([[0, 0]], false), false);
});

test("nearestWithin: returns the closest point within the radius", () => {
    const pts = [[0, 0], [10, 0], [3, 4]];
    assert.equal(nearestWithin(pts, [3, 5], 5), 2, "the (3,4) point is closest to (3,5)");
});

test("nearestWithin: returns -1 when nothing is within the radius", () => {
    assert.equal(nearestWithin([[0, 0], [100, 100]], [50, 50], 5), -1);
});

test("nearestWithin: a point exactly on the radius counts (<=)", () => {
    assert.equal(nearestWithin([[5, 0]], [0, 0], 5), 0);
});

test("nearestWithin: a null (unprojectable) point is skipped, never hit", () => {
    assert.equal(nearestWithin([null, [1, 0]], [0, 0], 5), 1);
    assert.equal(nearestWithin([null], [0, 0], 5), -1);
});

test("hitTest: a selected anchor's handle takes priority over the anchor", () => {
    const anchorPx = [[0, 0], [50, 0]];
    const handlePx = { sel: 1, out: [60, 0], in: [40, 0] };   // handles of the selected anchor #1
    assert.deepEqual(hitTest(anchorPx, handlePx, [60, 1], R), { kind: "handle", i: 1, which: "out" });
});

test("hitTest: falls back to the nearest anchor when no handle is hit", () => {
    const hit = hitTest([[0, 0], [50, 0]], { sel: 1, out: [200, 0], in: [-200, 0] }, [49, 1], R);
    assert.deepEqual(hit, { kind: "anchor", i: 1 });
});

test("hitTest: a missing handle (an open curve's endpoint) is skipped", () => {
    const hit = hitTest([[0, 0]], { sel: 0, out: [20, 0], in: null }, [0, 0], R);
    assert.deepEqual(hit, { kind: "anchor", i: 0 });
});

test("hitTest: handles are ignored when no anchor is selected", () => {
    assert.deepEqual(hitTest([[0, 0]], null, [0, 0], R), { kind: "anchor", i: 0 });
});

test("hitTest: returns null when the click is near nothing", () => {
    assert.equal(hitTest([[0, 0]], null, [100, 100], R), null);
});
