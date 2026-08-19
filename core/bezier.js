/*
 * bezier.js — fit a smooth, EDITABLE cubic bezier to a hand-drawn stroke — CLOSED for an ROI ring,
 * OPEN for a sulcus trace — sample it back to a polyline, and edit it. Pure (no DOM, no THREE, no
 * host): unit-testable, reusable.
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

// RDP tolerance in UV units (~0.4% of the flatmap) — drops tremor. Note: outline.js has its own
// PIXEL_RDP_EPSILON in *pixel* units (~1000× this); the two live in different coordinate spaces.
const UV_RDP_EPSILON = 0.004;

/* True unless explicitly opened. A bezier from an older file has no `closed` key, so a missing
 * flag means closed. An ABSENT bezier is not a closed one — it has no shape at all — so callers
 * that dispatch on this (evalBezier, nearestOnBezier) still see the "nothing to do" branch. */
export function isClosed(bez) { return !!bez && bez.closed !== false; }

/* Number of cubic segments: a closed ring wraps (n), an open curve does not (n-1). */
export function segCount(bez) {
    const n = (bez && bez.anchors) ? bez.anchors.length : 0;
    return isClosed(bez) ? n : Math.max(0, n - 1);
}

/* The fewest anchors a bezier needs to be a curve at all: a closed ring must bound an area (3);
 * an open curve is a line between 2. THE one definition — the samplers, the nearest-point search,
 * deleteAnchor's floor, the edit overlay and the adapter's SVG path writer all read it here. */
export function minAnchors(bez) { return isClosed(bez) ? 3 : 2; }

/* True when `bez` has enough anchors to be sampled/rendered as its kind. */
export function hasCurve(bez) {
    return !!(bez && bez.anchors) && bez.anchors.length >= minAnchors(bez);
}

/* The four control points of segment i (anchor i -> anchor i+1):
 * [start anchor, its out-handle, the next anchor's in-handle, the next anchor]. A closed ring
 * wraps from the last anchor back to the first; an open curve has no such segment. `closed`
 * defaults to the bezier's own flag — pass it explicitly to sample a ring AS IF open (or vice
 * versa). Every walk over a bezier's segments goes through here, so the wrap rule lives once. */
export function segControls(bez, i, closed = isClosed(bez)) {
    const { anchors, inHandles, outHandles } = bez;
    const j = closed ? (i + 1) % anchors.length : i + 1;
    return [anchors[i], outHandles[i], inHandles[j], anchors[j]];
}

/* Catmull-Rom -> cubic-bezier tangent handles. Returns { inHandles, outHandles } parallel to
 * `anchors`. For a CLOSED ring every anchor's handles are mirrored about it, using the wrapped
 * neighbours. For an OPEN curve the endpoints have no neighbour on one side: they get a one-sided
 * tangent (a third of the terminal segment), and their unused handle sits on the anchor itself. */
export function catmullRomHandles(anchors, closed = true) {
    const n = anchors.length;
    const inHandles = new Array(n), outHandles = new Array(n);
    for (let i = 0; i < n; i++) {
        const a = anchors[i];
        if (!closed && n >= 2 && i === 0) {
            const b = anchors[1];
            outHandles[0] = [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3];
            inHandles[0] = [a[0], a[1]];                       // unused
            continue;
        }
        if (!closed && n >= 2 && i === n - 1) {
            const b = anchors[n - 2];
            inHandles[i] = [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3];
            outHandles[i] = [a[0], a[1]];                      // unused
            continue;
        }
        const prev = anchors[(i - 1 + n) % n], next = anchors[(i + 1) % n];
        const tx = (next[0] - prev[0]) / 6, ty = (next[1] - prev[1]) / 6;
        outHandles[i] = [a[0] + tx, a[1] + ty];
        inHandles[i] = [a[0] - tx, a[1] - ty];
    }
    return { inHandles, outHandles };
}

/* Build a bezier descriptor from anchors alone (handles auto-derived). Every anchor of a closed
 * ring is smooth; an open curve's ENDPOINTS are corners (no symmetric tangent exists there). */
export function bezierFromAnchors(anchors, closed = true) {
    const a = anchors.map((p) => [p[0], p[1]]);
    const { inHandles, outHandles } = catmullRomHandles(a, closed);
    const smooth = a.map((_, i) => closed || (i !== 0 && i !== a.length - 1));
    return { closed, anchors: a, inHandles, outHandles, smooth };
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
export function fitClosedBezier(ring, { epsilon = UV_RDP_EPSILON } = {}) {
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

/* Drop consecutive duplicate points (a slow drag emits repeats at the same pixel). */
function dedupe(pts) {
    const out = [];
    for (const p of pts) {
        const q = out[out.length - 1];
        if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push([p[0], p[1]]);
    }
    return out;
}

/*
 * Fit an editable OPEN bezier to a traced polyline (e.g. a sulcus stroke mapped to uv).
 * polyline : [[u,v], ...] (>= 2 distinct points). epsilon: RDP tolerance in uv units.
 *
 * No rotateToExtreme here: that exists only because RDP pins its endpoints while a closed ring's
 * seam is arbitrary. On an open polyline pinning the endpoints is exactly what we want — the
 * traced start and end of the sulcus are real, meaningful points.
 */
export function fitOpenBezier(polyline, { epsilon = UV_RDP_EPSILON } = {}) {
    if (!polyline || polyline.length < 2) return null;
    const pts = dedupe(polyline);
    if (pts.length < 2) return null;
    let anchors = simplifyRDP(pts, epsilon);
    if (anchors.length < 2) anchors = pts;          // RDP can't drop an endpoint, but be defensive
    return bezierFromAnchors(anchors, false);
}

function cubicAt(p0, c1, c2, p3, t) {
    const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
            a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]];
}

/*
 * Sample a bezier to a polyline, treating it as closed or open per `closed`. samplesPerSeg points
 * per segment (the segment's start anchor, then interior samples). A closed ring returns a ring of
 * [x,y] with the first point NOT repeated at the end (suitable for point-in-polygon); an open curve
 * appends its final anchor, which is not the start of any segment. [] if there are too few anchors
 * for that kind. This is the single sampler behind evalClosedBezier / evalOpenBezier / evalBezier.
 */
function sampleBezier(bez, closed, samplesPerSeg) {
    if (!bez || !bez.anchors || bez.anchors.length < (closed ? 3 : 2)) return [];
    const n = bez.anchors.length, out = [];
    const steps = Math.max(1, samplesPerSeg | 0);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
        const [p0, c1, c2, p3] = segControls(bez, i, closed);
        for (let s = 0; s < steps; s++) out.push(cubicAt(p0, c1, c2, p3, s / steps));
    }
    if (!closed) out.push([bez.anchors[n - 1][0], bez.anchors[n - 1][1]]);
    return out;
}

/* Sample a bezier AS a closed ring (its own `closed` flag is ignored — see labelForCurve's caveat
 * in draw-pipeline.js for why the explicit forms exist). */
export function evalClosedBezier(bez, samplesPerSeg = 12) { return sampleBezier(bez, true, samplesPerSeg); }

/* Sample a bezier AS an open curve: n-1 segments, no wrap, final anchor appended. */
export function evalOpenBezier(bez, samplesPerSeg = 12) { return sampleBezier(bez, false, samplesPerSeg); }

/* Sample any bezier, dispatching on its `closed` flag. */
export function evalBezier(bez, samplesPerSeg = 12) { return sampleBezier(bez, isClosed(bez), samplesPerSeg); }

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
        // one smooth flag per anchor: truncate an over-long array, pad a too-short one with `true`
        // (a missing flag must default to smooth, not leak `undefined` which reads as a corner).
        smooth: Array.from({ length: n }, (_, i) => (bez.smooth && i < bez.smooth.length) ? bez.smooth[i] : true),
    };
}

/* Is `i` a live anchor index? The edit overlay carries a drag/hover target across pointer events,
 * so an anchor list that shrinks under it (Delete pressed mid-drag) leaves a stale index behind.
 * Writing through one used to append past the end of the handle arrays, silently desynchronizing
 * their lengths from `anchors`.
 *
 * ALL FIVE edit ops below share one contract: an out-of-range index is a no-op that returns an
 * unchanged copy. Nothing throws, nothing half-applies. (They used to disagree — two refused, two
 * threw a TypeError, one silently corrupted the smooth[] array — which meant the caller's guard
 * had to know which op it was calling.) */
const inRange = (bez, i) => Number.isInteger(i) && i >= 0 && i < bez.anchors.length;

/* Is `seg` a live segment index? A closed ring has n segments (the last wraps); an open curve has
 * n-1 — asking for its nonexistent wrap segment must not reach into anchors[n]. */
const segInRange = (bez, seg) => Number.isInteger(seg) && seg >= 0 && seg < segCount(bez);

/* Move anchor i to `pos`, carrying its two handles by the same delta (the local shape is rigid —
 * standard vector-editor behavior, so a smooth anchor stays smooth when you slide it).
 * An out-of-range i returns the bezier unchanged. */
export function moveAnchor(bez, i, pos) {
    const b = cloneBezier(bez);
    if (!inRange(b, i)) return b;
    const d = sub(pos, b.anchors[i]);
    b.anchors[i] = [pos[0], pos[1]];
    b.outHandles[i] = add(b.outHandles[i], d);
    b.inHandles[i] = add(b.inHandles[i], d);
    return b;
}

/* Move one tangent handle of anchor i. which = "out" | "in". If the anchor is smooth, the opposite
 * handle is mirrored about the anchor (kept collinear + equal length) so the curve stays smooth;
 * a corner anchor moves the handle independently. An out-of-range i returns the bezier unchanged. */
export function moveHandle(bez, i, which, pos) {
    const b = cloneBezier(bez);
    if (!inRange(b, i)) return b;
    const a = b.anchors[i];
    const here = which === "in" ? b.inHandles : b.outHandles;
    const other = which === "in" ? b.outHandles : b.inHandles;
    here[i] = [pos[0], pos[1]];
    if (b.smooth[i]) other[i] = [2 * a[0] - pos[0], 2 * a[1] - pos[1]];   // mirror
    return b;
}

/* Set anchor i smooth or corner. An OPEN curve's endpoints have no prev/next pair to build a
 * symmetric tangent from, so they are permanently corners: forcing them smooth is a no-op.
 * An out-of-range i returns the bezier unchanged. */
export function setAnchorSmooth(bez, i, smooth) {
    const b = cloneBezier(bez);
    if (!inRange(b, i)) return b;
    const n = b.anchors.length;
    const endpoint = !isClosed(b) && (i === 0 || i === n - 1);
    b.smooth[i] = endpoint ? false : !!smooth;
    if (endpoint || !smooth) return b;
    const a = b.anchors[i], prev = b.anchors[(i - 1 + n) % n], next = b.anchors[(i + 1) % n];
    let dir = sub(next, prev);
    let dl = len(dir);
    if (dl < 1e-9) { dir = sub(b.outHandles[i], a); dl = len(dir); }
    if (dl < 1e-9) { dir = [1, 0]; dl = 1; }
    dir = [dir[0] / dl, dir[1] / dl];
    let r = (len(sub(b.outHandles[i], a)) + len(sub(b.inHandles[i], a))) / 2;
    if (r < 1e-9) r = dl / 6;
    b.outHandles[i] = [a[0] + dir[0] * r, a[1] + dir[1] * r];
    b.inHandles[i] = [a[0] - dir[0] * r, a[1] - dir[1] * r];
    return b;
}

/* Insert an anchor on segment `seg` at parameter t in (0,1), splitting the cubic with de Casteljau
 * so the curve shape is UNCHANGED. `seg` is in [0, n-1] on a closed ring and [0, n-2] on an open
 * curve (which has no wrap segment); out of range returns the bezier unchanged. */
export function splitSegment(bez, seg, t) {
    const b = cloneBezier(bez);
    if (!segInRange(b, seg)) return b;
    const j = isClosed(b) ? (seg + 1) % b.anchors.length : seg + 1;
    const [p0, p1, p2, p3] = segControls(b, seg);
    const ab = lerp(p0, p1, t), bc = lerp(p1, p2, t), cd = lerp(p2, p3, t);
    const abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t);
    const mid = lerp(abc, bcd, t);
    b.outHandles[seg] = ab;
    b.inHandles[j] = cd;
    b.anchors.splice(seg + 1, 0, mid);
    b.inHandles.splice(seg + 1, 0, abc);
    b.outHandles.splice(seg + 1, 0, bcd);
    b.smooth.splice(seg + 1, 0, true);
    return b;
}

/* An open curve's endpoints (index 0 and n-1) are always corners with their unused handle
 * collapsed onto the anchor (see the module header). Deleting an anchor can promote a former
 * INTERIOR anchor to an endpoint, carrying over a stale `smooth: true` and a live, off-anchor
 * handle on the side that just became unused — re-pin both endpoints to restore the invariant.
 * The still-live handle on the other side (the one-sided tangent into the curve) is untouched. */
function normalizeOpenEndpoints(b) {
    const n = b.anchors.length;
    b.smooth[0] = false;
    b.inHandles[0] = [b.anchors[0][0], b.anchors[0][1]];
    b.smooth[n - 1] = false;
    b.outHandles[n - 1] = [b.anchors[n - 1][0], b.anchors[n - 1][1]];
    return b;
}

/* Remove anchor i. A closed bezier needs 3 anchors; an open one needs only 2. Returns the input
 * unchanged at the floor, or when i is out of range. Neighboring handles are left as-is, so the
 * curve reconnects through them. On an open curve, removing anchor 0 or n-1 can promote a former
 * interior anchor to an endpoint; normalizeOpenEndpoints re-pins both endpoints so the
 * corner/degenerate-handle invariant holds. */
export function deleteAnchor(bez, i) {
    if (bez.anchors.length <= minAnchors(bez)) return bez;
    const b = cloneBezier(bez);
    if (!inRange(b, i)) return b;
    b.anchors.splice(i, 1);
    b.inHandles.splice(i, 1);
    b.outHandles.splice(i, 1);
    b.smooth.splice(i, 1);
    return isClosed(b) ? b : normalizeOpenEndpoints(b);
}

/*
 * Nearest point on a bezier to `pt`, by sampling each segment, treating the curve as closed or open
 * per `closed`. Returns { seg, t, point:[x,y], dist } (dist is Euclidean in the same space as pt),
 * or null if there are too few anchors. Used to add a point where the curve was clicked. An open
 * curve has no wrap segment, so a point "inside the elbow" of an L is correctly reported far.
 */
function nearestOnCurve(bez, closed, pt, samplesPerSeg) {
    if (!bez || !bez.anchors || bez.anchors.length < (closed ? 3 : 2)) return null;
    const n = bez.anchors.length, steps = Math.max(2, samplesPerSeg | 0);
    const segs = closed ? n : n - 1;
    let best = null;
    for (let i = 0; i < segs; i++) {
        const [p0, c1, c2, p3] = segControls(bez, i, closed);
        for (let s = 0; s <= steps; s++) {
            const t = s / steps, q = cubicAt(p0, c1, c2, p3, t);
            const dx = q[0] - pt[0], dy = q[1] - pt[1], d = dx * dx + dy * dy;
            if (!best || d < best.d2) best = { seg: i, t, point: q, d2: d };
        }
    }
    return best ? { seg: best.seg, t: best.t, point: best.point, dist: Math.sqrt(best.d2) } : null;
}

export function nearestOnClosedBezier(bez, pt, samplesPerSeg = 24) { return nearestOnCurve(bez, true, pt, samplesPerSeg); }

export function nearestOnOpenBezier(bez, pt, samplesPerSeg = 24) { return nearestOnCurve(bez, false, pt, samplesPerSeg); }

/* Nearest point on any bezier, dispatching on its `closed` flag. */
export function nearestOnBezier(bez, pt, samplesPerSeg = 24) {
    return nearestOnCurve(bez, isClosed(bez), pt, samplesPerSeg);
}
