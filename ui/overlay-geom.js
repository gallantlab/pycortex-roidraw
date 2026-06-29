/*
 * overlay-geom.js — pure hit-testing math for the bezier edit overlay. No DOM, no canvas: just
 * arrays of [x,y] px points, so the grab-an-anchor / grab-a-handle decisions are unit-testable.
 */

// Index of the point in `points` closest to `pt` and within `radius`, or -1 if none is in range.
export function nearestWithin(points, pt, radius) {
    let best = -1, bd = radius * radius;
    for (let i = 0; i < points.length; i++) {
        const dx = points[i][0] - pt[0], dy = points[i][1] - pt[1], d = dx * dx + dy * dy;
        if (d <= bd) { bd = d; best = i; }
    }
    return best;
}

// Hit-test the editable bits at `pt`, nearest layer first: the selected anchor's two tangent handles
// (they sit on top), then any anchor. `handlePx` is { out:[x,y]|null, in:[x,y]|null } for the
// selected anchor (or null when none is selected). Returns
//   { kind:"handle", i, which:"out"|"in" } | { kind:"anchor", i } | null.
export function hitTest(anchorPx, handlePx, sel, pt, { hitRadius, handleRadius }) {
    if (sel >= 0 && handlePx) {
        for (const which of ["out", "in"]) {
            const hp = handlePx[which];
            if (hp) {
                const dx = hp[0] - pt[0], dy = hp[1] - pt[1];
                if (dx * dx + dy * dy <= handleRadius * handleRadius) return { kind: "handle", i: sel, which };
            }
        }
    }
    const i = nearestWithin(anchorPx, pt, hitRadius);
    return i >= 0 ? { kind: "anchor", i } : null;
}
