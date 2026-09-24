import test from "node:test";
import assert from "node:assert";
import {
    pointInPolygon, ndcToPixel, polygonBounds, inBounds, simplifyRDP, chaikin, centroid,
    sqDist, nearestIndex, dedupeConsecutive, dedupeRing,
} from "../core/geom.js";

const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("pointInPolygon: interior inside, exterior outside", () => {
    assert.strictEqual(pointInPolygon([5, 5], SQUARE), true);
    assert.strictEqual(pointInPolygon([15, 5], SQUARE), false);
    assert.strictEqual(pointInPolygon([-1, 5], SQUARE), false);
});

test("pointInPolygon: concave (U/lasso) notch reads as outside", () => {
    const U = [[0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6]];
    assert.strictEqual(pointInPolygon([1, 5], U), true);
    assert.strictEqual(pointInPolygon([5, 5], U), true);
    assert.strictEqual(pointInPolygon([3, 5], U), false);
});

test("ndcToPixel: center + corners with y-flip; accepts array form", () => {
    assert.deepStrictEqual(ndcToPixel({ x: 0, y: 0 }, 800, 600), [400, 300]);
    assert.deepStrictEqual(ndcToPixel({ x: -1, y: 1 }, 800, 600), [0, 0]);
    assert.deepStrictEqual(ndcToPixel({ x: 1, y: -1 }, 800, 600), [800, 600]);
    assert.deepStrictEqual(ndcToPixel([0, 0], 100, 100), [50, 50]);
});

test("polygonBounds + inBounds", () => {
    const b = polygonBounds(SQUARE);
    assert.deepStrictEqual(b, { minx: 0, miny: 0, maxx: 10, maxy: 10 });
    assert.strictEqual(inBounds([5, 5], b), true);
    assert.strictEqual(inBounds([11, 5], b), false);
});

test("simplifyRDP: collinear-ish collapse; real corner kept", () => {
    assert.deepStrictEqual(simplifyRDP([[0, 0], [10, 1], [20, 0], [30, 1], [40, 0]], 3), [[0, 0], [40, 0]]);
    const bend = simplifyRDP([[0, 0], [10, 0], [10, 10]], 3);
    assert.ok(bend.some((p) => p[0] === 10 && p[1] === 0));
});

test("chaikin: doubles points/iteration, stays within bbox", () => {
    const one = chaikin(SQUARE, 1);
    assert.strictEqual(one.length, 8);
    for (const p of one) assert.ok(p[0] >= 0 && p[0] <= 10 && p[1] >= 0 && p[1] <= 10);
    assert.strictEqual(chaikin(SQUARE, 2).length, 16);
});

test("centroid: mean; null when empty", () => {
    assert.deepStrictEqual(centroid(SQUARE), [5, 5]);
    assert.strictEqual(centroid([]), null);
});

test("sqDist / nearestIndex: nearest point, first on a tie, -1 when empty", () => {
    assert.strictEqual(sqDist([0, 0], [3, 4]), 25);
    const pts = [[0, 0], [5, 5], [1, 1], [9, 0]];
    assert.strictEqual(nearestIndex(pts, [1.2, 0.9]), 2);
    assert.strictEqual(nearestIndex(pts, [8, 1]), 3);
    assert.strictEqual(nearestIndex([[1, 0], [-1, 0]], [0, 0]), 0, "a tie keeps the first");
    assert.strictEqual(nearestIndex([], [0, 0]), -1);
});

test("dedupeConsecutive / dedupeRing: drop repeats; the ring form also drops a closing repeat", () => {
    const pts = [[0, 0], [0, 0], [1, 0], [1, 0], [1, 1], [0, 0]];
    assert.deepStrictEqual(dedupeConsecutive(pts), [[0, 0], [1, 0], [1, 1], [0, 0]]);
    assert.deepStrictEqual(dedupeRing(pts), [[0, 0], [1, 0], [1, 1]]);
    assert.deepStrictEqual(dedupeRing([[2, 2], [2, 2]]), [[2, 2]]);
    assert.deepStrictEqual(dedupeRing([]), []);
    // a custom equality (outline rings are {h, g} vertex refs, not points)
    const same = (a, b) => a.h === b.h && a.g === b.g;
    const ring = [{ h: "left", g: 1 }, { h: "left", g: 1 }, { h: "right", g: 1 }, { h: "left", g: 1 }];
    assert.deepStrictEqual(dedupeRing(ring, same), [{ h: "left", g: 1 }, { h: "right", g: 1 }]);
    assert.notStrictEqual(dedupeConsecutive(pts), pts, "a new array, not the input");
});
