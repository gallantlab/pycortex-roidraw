/*
 * bezier.js — fit a smooth, EDITABLE closed cubic bezier to a hand-drawn ROI ring, and sample
 * it back to a polyline. Pure (no DOM, no THREE, no host): unit-testable, reusable.
 *
 * All points are plain [x, y] in the surface's flat-UV space ([0,1]^2 — the view-independent,
 * portable space the SVG overlay already uses). Storing the boundary as a bezier in this space
 * is what lets a reloaded ROI be re-rendered AND re-edited identically to a freshly drawn one.
 *
 * Smoothing model: anchors are the simplified ring vertices; each anchor's tangent handles are
 * the uniform Catmull-Rom tangent (next - prev)/6, mirrored in/out. A freshly fit curve is fully
 * smooth, but the handles are EXPLICIT and editable (see the edit overlay): they are the source of
 * truth, not re-derived from the anchors. A parallel `smooth[]` flag marks each anchor smooth
 * (handles kept symmetric about the anchor) or a corner/cusp (handles move independently).
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

/* Build a bezier descriptor from anchors alone (handles auto-derived, every anchor smooth). */
export function bezierFromAnchors(anchors) {
    const a = anchors.map((p) => [p[0], p[1]]);
    const { inHandles, outHandles } = catmullRomHandles(a);
    return { closed: true, anchors: a, inHandles, outHandles, smooth: a.map(() => true) };
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

/* ---------------------------------------------------------------------------------------------
 * Editing operations. All take a bezier descriptor and return a NEW one (no mutation), so the
 * edit overlay can keep a clean working copy and the host can swap it in on commit. They preserve
 * the {closed, anchors, inHandles, outHandles, smooth} shape; `smooth[i]` defaults to true.
 * ------------------------------------------------------------------------------------------- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const len = (v) => Math.hypot(v[0], v[1]);

/* Deep copy, back-filling a missing `smooth` array (older files) as all-smooth. */
export function cloneBezier(bez) {
    const n = bez.anchors.length;
    return {
        closed: bez.closed !== false,
        anchors: bez.anchors.map((p) => [p[0], p[1]]),
        inHandles: bez.inHandles.map((p) => [p[0], p[1]]),
        outHandles: bez.outHandles.map((p) => [p[0], p[1]]),
        smooth: bez.smooth ? bez.smooth.slice(0, n) : bez.anchors.map(() => true),
    };
}

/* Move anchor i to `pos`, carrying its two handles by the same delta (the local shape is rigid —
 * standard vector-editor behavior, so a smooth anchor stays smooth when you slide it). */
export function moveAnchor(bez, i, pos) {
    const b = cloneBezier(bez);
    const d = sub(pos, b.anchors[i]);
    b.anchors[i] = [pos[0], pos[1]];
    b.outHandles[i] = add(b.outHandles[i], d);
    b.inHandles[i] = add(b.inHandles[i], d);
    return b;
}

/* Move one tangent handle of anchor i. which = "out" | "in". If the anchor is smooth, the opposite
 * handle is mirrored about the anchor (kept collinear + equal length) so the curve stays smooth;
 * a corner anchor moves the handle independently. */
export function moveHandle(bez, i, which, pos) {
    const b = cloneBezier(bez);
    const a = b.anchors[i];
    const here = which === "in" ? b.inHandles : b.outHandles;
    const other = which === "in" ? b.outHandles : b.inHandles;
    here[i] = [pos[0], pos[1]];
    if (b.smooth[i]) other[i] = [2 * a[0] - pos[0], 2 * a[1] - pos[1]];   // mirror
    return b;
}

/* Set anchor i smooth or corner. Turning it smooth re-derives both handles symmetric about the
 * anchor: aligned to the local tangent (neighbor direction), with the current average handle length
 * preserved so the curve keeps its tightness. Turning it to a corner leaves the handles as-is
 * (they simply become independently draggable). */
export function setAnchorSmooth(bez, i, smooth) {
    const b = cloneBezier(bez);
    b.smooth[i] = !!smooth;
    if (!smooth) return b;
    const n = b.anchors.length;
    const a = b.anchors[i], prev = b.anchors[(i - 1 + n) % n], next = b.anchors[(i + 1) % n];
    let dir = sub(next, prev);
    let dl = len(dir);
    if (dl < 1e-9) { dir = sub(b.outHandles[i], a); dl = len(dir); }   // fall back to current out dir
    if (dl < 1e-9) { dir = [1, 0]; dl = 1; }
    dir = [dir[0] / dl, dir[1] / dl];
    let r = (len(sub(b.outHandles[i], a)) + len(sub(b.inHandles[i], a))) / 2;
    if (r < 1e-9) r = dl / 6;                                          // both handles collapsed
    b.outHandles[i] = [a[0] + dir[0] * r, a[1] + dir[1] * r];
    b.inHandles[i] = [a[0] - dir[0] * r, a[1] - dir[1] * r];
    return b;
}

/* Insert an anchor on segment `seg` (anchor seg -> anchor seg+1) at parameter t in (0,1), splitting
 * the cubic with de Casteljau so the curve shape is UNCHANGED. The new anchor is smooth (the split
 * point is naturally C1). Returns a new bezier with one more anchor. */
export function splitSegment(bez, seg, t) {
    const b = cloneBezier(bez);
    const n = b.anchors.length;
    const j = (seg + 1) % n;
    const p0 = b.anchors[seg], p1 = b.outHandles[seg], p2 = b.inHandles[j], p3 = b.anchors[j];
    const ab = lerp(p0, p1, t), bc = lerp(p1, p2, t), cd = lerp(p2, p3, t);
    const abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t);
    const mid = lerp(abc, bcd, t);                       // the new on-curve anchor
    b.outHandles[seg] = ab;                              // left sub-cubic: p0, ab, abc, mid
    b.inHandles[j] = cd;                                 // right sub-cubic: mid, bcd, cd, p3
    b.anchors.splice(seg + 1, 0, mid);
    b.inHandles.splice(seg + 1, 0, abc);
    b.outHandles.splice(seg + 1, 0, bcd);
    b.smooth.splice(seg + 1, 0, true);
    return b;
}

/* Remove anchor i. Refuses (returns the input unchanged) below 3 anchors — a closed bezier needs 3.
 * Neighboring handles are left as they were, so the curve reconnects prev -> next through them. */
export function deleteAnchor(bez, i) {
    if (bez.anchors.length <= 3) return bez;
    const b = cloneBezier(bez);
    b.anchors.splice(i, 1);
    b.inHandles.splice(i, 1);
    b.outHandles.splice(i, 1);
    b.smooth.splice(i, 1);
    return b;
}

/* Nearest point on the closed bezier to `pt`, by sampling each segment. Returns
 * { seg, t, point:[x,y], dist } (dist is Euclidean in the same space as pt), or null. Used to add a
 * point where the curve was clicked. */
export function nearestOnClosedBezier(bez, pt, samplesPerSeg = 24) {
    if (!bez || !bez.anchors || bez.anchors.length < 3) return null;
    const { anchors, inHandles, outHandles } = bez;
    const n = anchors.length, steps = Math.max(2, samplesPerSeg | 0);
    let best = null;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const p0 = anchors[i], c1 = outHandles[i], c2 = inHandles[j], p3 = anchors[j];
        for (let s = 0; s <= steps; s++) {
            const t = s / steps, q = cubicAt(p0, c1, c2, p3, t);
            const dx = q[0] - pt[0], dy = q[1] - pt[1], d = dx * dx + dy * dy;
            if (!best || d < best.d2) best = { seg: i, t, point: q, d2: d };
        }
    }
    return best ? { seg: best.seg, t: best.t, point: best.point, dist: Math.sqrt(best.d2) } : null;
}
