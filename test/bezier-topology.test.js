/*
 * The segment topology of a bezier — how many segments, which anchors each joins, how few anchors
 * are allowed — used to be re-stated in each sampler, the nearest-point search, deleteAnchor, the
 * edit overlay and the adapter's SVG path writer. These tests pin that they all read ONE
 * definition (segCount / segControls / minAnchors / hasCurve in core/bezier.js) and agree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    bezierFromAnchors, segCount, segControls, minAnchors, hasCurve, isClosed,
    evalBezier, evalClosedBezier, evalOpenBezier, nearestOnBezier, nearestOnClosedBezier,
    nearestOnOpenBezier, deleteAnchor,
} from "../core/bezier.js";
import { PycortexAdapter } from "../adapter/pycortex-adapter.js";

const SQ = [[0, 0], [1, 0], [1, 1], [0, 1]];
const closed = bezierFromAnchors(SQ, true);
const open = bezierFromAnchors(SQ, false);

test("minAnchors / hasCurve: 3 for a closed ring, 2 for an open curve", () => {
    assert.equal(minAnchors(closed), 3);
    assert.equal(minAnchors(open), 2);
    assert.equal(minAnchors({ anchors: [] }), 3);      // a missing `closed` flag means closed
    assert.equal(hasCurve(bezierFromAnchors([[0, 0], [1, 1]], true)), false);
    assert.equal(hasCurve(bezierFromAnchors([[0, 0], [1, 1]], false)), true);
    assert.equal(hasCurve(null), false);
    assert.equal(hasCurve({ anchors: null }), false);
});

test("segControls: the wrap segment exists only on a closed ring; it joins anchor n-1 to anchor 0", () => {
    assert.equal(segCount(closed), 4);
    assert.equal(segCount(open), 3);
    const [p0, c1, c2, p3] = segControls(closed, 3);
    assert.deepEqual(p0, closed.anchors[3]);
    assert.deepEqual(c1, closed.outHandles[3]);
    assert.deepEqual(c2, closed.inHandles[0]);
    assert.deepEqual(p3, closed.anchors[0]);
    // the explicit `closed` argument overrides the flag (how evalOpenBezier samples a ring)
    const [, , , p3open] = segControls(closed, 2, false);
    assert.deepEqual(p3open, closed.anchors[3]);
});

test("evalBezier dispatches to the same sampler the explicit forms use", () => {
    assert.deepEqual(evalBezier(closed, 5), evalClosedBezier(closed, 5));
    assert.deepEqual(evalBezier(open, 5), evalOpenBezier(open, 5));
    assert.equal(evalClosedBezier(closed, 5).length, 4 * 5);        // n segments, no repeat
    assert.equal(evalOpenBezier(open, 5).length, 3 * 5 + 1);        // n-1 segments + final anchor
    assert.deepEqual(evalOpenBezier(open, 5).at(-1), open.anchors[3]);
});

test("nearestOnBezier dispatches to the same search the explicit forms use", () => {
    const pt = [0.5, -0.2];
    assert.deepEqual(nearestOnBezier(closed, pt), nearestOnClosedBezier(closed, pt));
    assert.deepEqual(nearestOnBezier(open, pt), nearestOnOpenBezier(open, pt));
    // a point by the missing wrap segment of the OPEN curve is far; on the ring it is near
    const byWrap = [0, 0.5];
    assert.ok(nearestOnOpenBezier(open, byWrap).dist > nearestOnClosedBezier(closed, byWrap).dist);
});

test("deleteAnchor floors at minAnchors for each kind", () => {
    const tri = bezierFromAnchors(SQ.slice(0, 3), true);
    assert.equal(deleteAnchor(tri, 0), tri);                         // 3 is the closed floor
    const line = bezierFromAnchors(SQ.slice(0, 2), false);
    assert.equal(deleteAnchor(line, 0), line);                       // 2 is the open floor
    assert.equal(deleteAnchor(bezierFromAnchors(SQ.slice(0, 3), false), 0).anchors.length, 2);
});

test("the adapter's SVG path walks the same segments: one C per segment, Z only when closed", () => {
    // _bezierSvgPath reads only its arguments + core/bezier.js, so it runs without a viewer.
    const path = (bez) => PycortexAdapter.prototype._bezierSvgPath.call({}, bez, 100, 100);
    const dc = path(closed), dopen = path(open);
    assert.equal((dc.match(/C/g) || []).length, segCount(closed));
    assert.equal((dopen.match(/C/g) || []).length, segCount(open));
    assert.ok(dc.endsWith("Z") && isClosed(closed));
    assert.ok(!dopen.endsWith("Z") && !isClosed(open));
    // the path starts at anchor 0 in viewBox px (u*W, (1-v)*H)
    assert.ok(dc.startsWith("M0.00,100.00"));
    // below the floor for its kind: no path at all (the caller falls back / skips)
    assert.equal(path(bezierFromAnchors(SQ.slice(0, 2), true)), null);
    assert.equal(path(bezierFromAnchors(SQ.slice(0, 2), false)) !== null, true);
});
