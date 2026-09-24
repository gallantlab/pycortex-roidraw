/*
 * overlay-geom.js — pure pointer math for the overlays. No DOM, no canvas: just arrays of [x,y] px
 * points, so the click-vs-drag rule, the degenerate-stroke rule, and the grab-an-anchor /
 * grab-a-handle decisions are unit-testable.
 */
import { polygonBounds, sqDist } from "../core/geom.js";

// px; the one click-vs-drag rule for both overlays. A pointer that stays within this distance of
// where it went down is a click (Shift-inspect, select, deselect); past it, the gesture is a drag.
export const CLICK_SLOP = 3;

// Has the pointer moved from `a` to `b` by more than `r` px (Euclidean)?
export function movedPast(a, b, r = CLICK_SLOP) {
    return sqDist(a, b) > r * r;
}

// Is a finished lasso/trace stroke worth turning into a shape? An accidental click with a few px of
// wobble still emits several points, so the stroke's bounding-box diagonal must exceed CLICK_SLOP
// (the stroke really was a drag), and it needs enough points: 2 for an open trace (a line), 3 for a
// closed lasso (to bound an area).
export function isUsableStroke(pts, closed) {
    if (pts.length < (closed ? 3 : 2)) return false;
    const b = polygonBounds(pts);
    return Math.hypot(b.maxx - b.minx, b.maxy - b.miny) > CLICK_SLOP;
}

// Index of the point in `points` closest to `pt` and within `radius`, or -1 if none is in range.
// A null entry (a point that could not be projected on screen) is never hit.
export function nearestWithin(points, pt, radius) {
    let best = -1, bd = radius * radius;
    for (let i = 0; i < points.length; i++) {
        if (!points[i]) continue;
        const d = sqDist(points[i], pt);
        if (d <= bd) { bd = d; best = i; }
    }
    return best;
}

// Hit-test the editable bits at `pt`, nearest layer first: the selected anchor's two tangent handles
// (they sit on top), then any anchor. `handlePx` is { sel, out:[x,y]|null, in:[x,y]|null } for the
// selected anchor `sel`, or null when no anchor is selected. Returns
//   { kind:"handle", i, which:"out"|"in" } | { kind:"anchor", i } | null.
export function hitTest(anchorPx, handlePx, pt, { hitRadius, handleRadius }) {
    if (handlePx) {
        for (const which of ["out", "in"]) {
            const hp = handlePx[which];
            if (hp && sqDist(hp, pt) <= handleRadius * handleRadius) return { kind: "handle", i: handlePx.sel, which };
        }
    }
    const i = nearestWithin(anchorPx, pt, hitRadius);
    return i >= 0 ? { kind: "anchor", i } : null;
}
