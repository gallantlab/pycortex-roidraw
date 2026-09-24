import test from "node:test";
import assert from "node:assert";
import { fitHomography, applyHomography, invertHomography } from "../core/transform.js";

// A known homography to generate correspondences from.
const Htrue = [2, 0.3, 5, -0.4, 1.5, -2, 0.0006, -0.0009, 1];
const pts = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.2], [0.3, 0.8], [0.9, 0.4]];

function close(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

test("fitHomography: recovers a known projective map from correspondences", () => {
    const dst = pts.map((p) => applyHomography(Htrue, p));
    const H = fitHomography(pts, dst);
    assert.ok(H, "fit returned null");
    for (const p of pts) {
        const got = applyHomography(H, p), want = applyHomography(Htrue, p);
        assert.ok(close(got[0], want[0]) && close(got[1], want[1]), `mismatch at ${p}: ${got} vs ${want}`);
    }
});

test("fitHomography: needs >= 4 points", () => {
    assert.strictEqual(fitHomography([[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 0], [1, 1]]), null);
});

test("fitHomography: rejects collinear correspondences (under-determined)", () => {
    const collinear = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]];           // all on a line
    assert.strictEqual(fitHomography(collinear, collinear.map((p) => applyHomography(Htrue, p))), null);
    // coincident points are degenerate too
    const coincident = [[1, 1], [1, 1], [1, 1], [1, 1]];
    assert.strictEqual(fitHomography(coincident, coincident), null);
});

test("fitHomography: a near-singular fit yields only finite entries or null (never NaN)", () => {
    const H = fitHomography(pts, pts.map((p) => applyHomography(Htrue, p)));
    assert.ok(H);
    for (const v of H) assert.ok(isFinite(v));
});

test("fitHomography: least-squares fit tolerates noisy correspondences", () => {
    const dst = pts.map((p, i) => {
        const t = applyHomography(Htrue, p);
        return [t[0] + (i % 2 ? 0.001 : -0.001), t[1] + (i % 3 ? -0.001 : 0.001)];
    });
    const H = fitHomography(pts, dst);
    assert.ok(H);
    const got = applyHomography(H, [0.5, 0.5]), want = applyHomography(Htrue, [0.5, 0.5]);
    assert.ok(close(got[0], want[0], 0.05) && close(got[1], want[1], 0.05));
});

test("invertHomography: H then H^-1 round-trips a point", () => {
    const Hinv = invertHomography(Htrue);
    assert.ok(Hinv);
    for (const p of pts) {
        const back = applyHomography(Hinv, applyHomography(Htrue, p));
        assert.ok(close(back[0], p[0]) && close(back[1], p[1]), `round-trip failed at ${p}: ${back}`);
    }
});

test("invertHomography: singular matrix returns null", () => {
    assert.strictEqual(invertHomography([1, 1, 1, 2, 2, 2, 3, 3, 3]), null);
});

test("applyHomography: a point on the vanishing line has no image (null, never NaN/Infinity)", () => {
    // H with the vanishing line h6*x + h7*y + 1 = 0; choose a point exactly on it.
    const H = [1, 0, 0, 0, 1, 0, 1, 0, 1];   // w = x + 1  -> zero at x = -1
    assert.strictEqual(applyHomography(H, [-1, 0.5]), null);
    assert.strictEqual(applyHomography(H, [-1 + 1e-14, 0.5]), null);   // |w| below the epsilon
    assert.strictEqual(applyHomography(H, [NaN, 0.5]), null);          // non-finite divisor
    const off = applyHomography(H, [1, 0.5]);                          // w = 2: an ordinary point
    assert.deepStrictEqual(off, [0.5, 0.25]);
});

test("fitHomography: null when src and dst differ in length (the pairing is ambiguous)", () => {
    const src = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]];
    assert.strictEqual(fitHomography(src, src.slice(0, 4)), null);
    assert.strictEqual(fitHomography(src.slice(0, 4), src), null);
    assert.ok(fitHomography(src, src), "sanity: equal lengths still fit");
});
