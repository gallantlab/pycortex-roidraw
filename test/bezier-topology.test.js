/*
 * The segment topology of a bezier — how many segments, which anchors each joins, how few anchors
 * are allowed — is read by each sampler, the nearest-point search, deleteAnchor, the edit overlay
 * and the SVG path writer (core/svg-path.js). These tests pin that they all read ONE definition
 * (segCount / segControls / nextIndex / minAnchors / hasCurve in core/bezier.js) and agree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    bezierFromAnchors, segCount, segControls, nextIndex, minAnchors, hasCurve, isClosed,
    evalBezier, evalClosedBezier, evalOpenBezier, nearestOnBezier, deleteAnchor,
} from "../core/bezier.js";
import { bezierSvgPath } from "../core/svg-path.js";

const SQ = [[0, 0], [1, 0], [1, 1], [0, 1]];
const closed = bezierFromAnchors(SQ, true);
const open = bezierFromAnchors(SQ, false);

test("minAnchors / hasCurve: 3 for a closed ring, 2 for an open curve", () => {
    assert.equal(minAnchors(closed), 3);
    assert.equal(minAnchors(open), 2);
    assert.equal(minAnchors({ anchors: [] }), 3);      // a missing `closed` flag means closed
    assert.equal(minAnchors(closed, false), 2);        // the explicit argument overrides the flag
    assert.equal(minAnchors(open, true), 3);
    assert.equal(hasCurve(bezierFromAnchors([[0, 0], [1, 1]], true)), false);
    assert.equal(hasCurve(bezierFromAnchors([[0, 0], [1, 1]], false)), true);
    assert.equal(hasCurve(null), false);
    assert.equal(hasCurve({ anchors: null }), false);
});

test("segControls: the wrap segment exists only on a closed ring; it joins anchor n-1 to anchor 0", () => {
    assert.equal(segCount(closed), 4);
    assert.equal(segCount(open), 3);
    assert.equal(segCount(closed, false), 3);          // count a ring AS IF open
    assert.equal(segCount(open, true), 4);
    assert.equal(nextIndex(closed, 3), 0);             // wraps
    assert.equal(nextIndex(open, 2), 3);
    assert.equal(nextIndex(closed, 3, false), 4);      // AS IF open: no wrap
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

test("nearestOnBezier walks segCount segments: the wrap segment only on a closed ring", () => {
    // a point on the ring's wrap segment (anchor 3 -> anchor 0) is ON the closed curve and reported
    // there; the open curve has no such segment, so the same point is far from it
    const byWrap = [0, 0.5];
    const hitClosed = nearestOnBezier(closed, byWrap), hitOpen = nearestOnBezier(open, byWrap);
    assert.equal(hitClosed.seg, 3);
    assert.ok(hitClosed.dist < 0.2);                    // the smooth ring bulges ~0.125 past the edge
    assert.ok(hitOpen.seg < segCount(open));
    assert.ok(hitOpen.dist > hitClosed.dist);
    // below the floor for its kind: no curve to search
    assert.equal(nearestOnBezier(bezierFromAnchors(SQ.slice(0, 2), true), byWrap), null);
    assert.ok(nearestOnBezier(bezierFromAnchors(SQ.slice(0, 2), false), byWrap));
});

test("deleteAnchor floors at minAnchors for each kind", () => {
    const tri = bezierFromAnchors(SQ.slice(0, 3), true);
    assert.deepEqual(deleteAnchor(tri, 0), tri);                     // 3 is the closed floor
    assert.notEqual(deleteAnchor(tri, 0), tri);                      // ...and the refusal is a copy
    const line = bezierFromAnchors(SQ.slice(0, 2), false);
    assert.deepEqual(deleteAnchor(line, 0), line);                   // 2 is the open floor
    assert.notEqual(deleteAnchor(line, 0), line);
    assert.equal(deleteAnchor(bezierFromAnchors(SQ.slice(0, 3), false), 0).anchors.length, 2);
});

test("the SVG path writer walks the same segments: one C per segment, Z only when closed", () => {
    const path = (bez) => bezierSvgPath(bez, 100, 100);
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
