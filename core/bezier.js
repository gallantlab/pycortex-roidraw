/*
 * bezier.js — fit a smooth, EDITABLE closed cubic bezier to a hand-drawn ROI ring, and sample
 * it back to a polyline. Pure (no DOM, no THREE, no host): unit-testable, reusable.
 *
 * All points are plain [x, y] in the surface's flat-UV space ([0,1]^2 — the view-independent,
 * portable space the SVG overlay already uses). Storing the boundary as a bezier in this space
 * is what lets a reloaded ROI be re-rendered AND re-edited identically to a freshly drawn one.
 *
 * Smoothing model: anchors are the simplified ring vertices; each anchor's tangent handles are
 * the uniform Catmull-Rom tangent (next - prev)/6, mirrored in/out. Dragging an anchor and
 * recomputing keeps the curve smooth without the user touching handles ("drag knots only").
 */
import { simplifyRDP, centroid } from "./geom.js";

const DEFAULT_EPSILON = 0.004; // RDP tolerance in uv units (~0.4% of the flatmap) — drops tremor

/* Catmull-Rom -> cubic-bezier tangent handles for a CLOSED ring of anchors. Returns
 * { inHandles, outHandles } parallel to `anchors`; out[i]/in[i] are mirrored about anchor i. */
export function catmullRomHandles(anchors) {
    const n = anchors.length;
    const inHandles = new Array(n), outHandles = new Array(n);
    for (let i = 0; i < n; i++) {
        const prev = anchors[(i - 1 + n) % n], next = anchors[(i + 1) % n], a = anchors[i];
        const tx = (next[0] - prev[0]) / 6, ty = (next[1] - prev[1]) / 6;
        outHandles[i] = [a[0] + tx, a[1] + ty];
        inHandles[i] = [a[0] - tx, a[1] - ty];
    }
    return { inHandles, outHandles };
}

/* Build a bezier descriptor from anchors alone (handles auto-derived). */
export function bezierFromAnchors(anchors) {
    const a = anchors.map((p) => [p[0], p[1]]);
    const { inHandles, outHandles } = catmullRomHandles(a);
    return { closed: true, anchors: a, inHandles, outHandles };
}

/*
 * Rotate a closed ring so it starts at its farthest-from-centroid point. simplifyRDP is an OPEN
 * polyline algorithm: it pins the first and last points and never tests the edge that wraps from
 * last back to first. On a closed ring that seam is wherever the lasso happened to start, so a real
 * corner sitting near it can be dropped and the fit becomes start-dependent. Anchoring the seam at
 * a stable extreme point (a near-guaranteed real corner) makes the fit deterministic.
 */
function rotateToExtreme(pts) {
    const c = centroid(pts);
    if (!c) return pts;
    let bi = 0, bd = -1;
    for (let i = 0; i < pts.length; i++) {
        const dx = pts[i][0] - c[0], dy = pts[i][1] - c[1], d = dx * dx + dy * dy;
        if (d > bd) { bd = d; bi = i; }
    }
    return bi === 0 ? pts : pts.slice(bi).concat(pts.slice(0, bi));
}

/*
 * Fit an editable closed bezier to an ordered ring of points (e.g. the outline ring mapped to uv).
 * ring : [[u,v], ...] (>= 3). epsilon: RDP tolerance in uv units.
 * Returns { closed:true, anchors:[[u,v]], inHandles:[[u,v]], outHandles:[[u,v]] } or null.
 */
export function fitClosedBezier(ring, { epsilon = DEFAULT_EPSILON } = {}) {
    if (!ring || ring.length < 3) return null;
    let pts = ring.slice();
    // drop a duplicated closing point so the ring has no zero-length edge. Guard with > 3 so a
    // genuine 3-point ring is never reduced below the 3 anchors a closed bezier needs.
    const f = pts[0], l = pts[pts.length - 1];
    if (pts.length > 3 && f[0] === l[0] && f[1] === l[1]) pts.pop();

    pts = rotateToExtreme(pts);                       // make the RDP seam a stable corner (see above)
    let anchors = simplifyRDP(pts, epsilon);
    if (anchors.length < 3) anchors = pts;            // RDP over-simplified a tiny ROI
    // simplifyRDP keeps both endpoints; on a closed ring that can duplicate the seam — dedupe
    if (anchors.length > 3) {
        const a0 = anchors[0], aN = anchors[anchors.length - 1];
        if (a0[0] === aN[0] && a0[1] === aN[1]) anchors.pop();
    }
    if (anchors.length < 3) return null;
    return bezierFromAnchors(anchors);
}

function cubicAt(p0, c1, c2, p3, t) {
    const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
            a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]];
}

/*
 * Sample a closed bezier to a polyline. samplesPerSeg points per segment (the segment's start
 * anchor, then interior samples; the next anchor is the next segment's start). Returns a closed
 * ring of [x,y] (first point not repeated at the end) suitable for point-in-polygon.
 */
export function evalClosedBezier(bez, samplesPerSeg = 12) {
    if (!bez || !bez.anchors || bez.anchors.length < 3) return [];
    const { anchors, inHandles, outHandles } = bez;
    const n = anchors.length, out = [];
    const steps = Math.max(1, samplesPerSeg | 0);
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const p0 = anchors[i], c1 = outHandles[i], c2 = inHandles[j], p3 = anchors[j];
        for (let s = 0; s < steps; s++) out.push(cubicAt(p0, c1, c2, p3, s / steps));
    }
    return out;
}
