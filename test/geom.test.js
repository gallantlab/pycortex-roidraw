import test from "node:test";
import assert from "node:assert";
import { pointInPolygon, ndcToPixel, polygonBounds, inBounds, simplifyRDP, chaikin, centroid } from "../core/geom.js";

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
