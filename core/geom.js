/*
 * geom.js — pure 2D geometry helpers. No DOM, no THREE, no host: unit-testable under node,
 * reusable by any viewer. All inputs/outputs are plain [x, y] arrays.
 */

/*
 * Even-odd ray-casting point-in-polygon test.
 *   pt   : [x, y]
 *   poly : [[x, y], ...]  (open ring; first/last need not repeat)
 * Returns true iff pt is strictly inside poly.
 */
export function pointInPolygon(pt, poly) {
    const x = pt[0], y = pt[1];
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const crosses = ((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (crosses) inside = !inside;
    }
    return inside;
}

/* Axis-aligned bounds of a polygon, for a cheap reject before the full PIP test. */
export function polygonBounds(poly) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let i = 0; i < poly.length; i++) {
        const px = poly[i][0], py = poly[i][1];
        if (px < minx) minx = px;
        if (px > maxx) maxx = px;
        if (py < miny) miny = py;
        if (py > maxy) maxy = py;
    }
    return { minx, miny, maxx, maxy };
}

export function inBounds(pt, b) {
    return pt[0] >= b.minx && pt[0] <= b.maxx && pt[1] >= b.miny && pt[1] <= b.maxy;
}

/*
 * Normalized device coords (THREE-style: x,y in [-1,1], y up) -> canvas pixels (origin
 * top-left, y down) for a w x h canvas. `ndc` may be {x,y} or [x,y]. Returns [px, py].
 */
export function ndcToPixel(ndc, w, h) {
    const nx = (ndc.x !== undefined) ? ndc.x : ndc[0];
    const ny = (ndc.y !== undefined) ? ndc.y : ndc[1];
    return [(nx * 0.5 + 0.5) * w, (-ny * 0.5 + 0.5) * h];
}

/*
 * Ramer–Douglas–Peucker polyline simplification. Drops points within `epsilon` px of the
 * line between kept neighbors, removing hand tremor while preserving real corners (e.g. the
 * notch of a C-shaped ROI). Endpoints are kept.
 */
export function simplifyRDP(points, epsilon) {
    if (points.length < 3) return points.slice();
    const sqEps = epsilon * epsilon;
    const keep = new Array(points.length);
    keep[0] = keep[points.length - 1] = true;

    const sqSegDist = (p, a, b) => {
        let x = a[0], y = a[1];
        let dx = b[0] - x, dy = b[1] - y;
        if (dx !== 0 || dy !== 0) {
            const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
            if (t > 1) { x = b[0]; y = b[1]; }
            else if (t > 0) { x += dx * t; y += dy * t; }
        }
        dx = p[0] - x; dy = p[1] - y;
        return dx * dx + dy * dy;
    };

    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [first, last] = stack.pop();
        let maxd = 0, idx = -1;
        for (let i = first + 1; i < last; i++) {
            const d = sqSegDist(points[i], points[first], points[last]);
            if (d > maxd) { maxd = d; idx = i; }
        }
        if (maxd > sqEps) { keep[idx] = true; stack.push([first, idx], [idx, last]); }
    }
    const out = [];
    for (let k = 0; k < points.length; k++) if (keep[k]) out.push(points[k]);
    return out;
}

/*
 * Chaikin corner-cutting on a CLOSED ring. Each iteration replaces every vertex with two
 * points at 1/4 and 3/4 along each edge, rounding sharp corners into a smooth curve.
 * Point count doubles per iteration.
 */
export function chaikin(points, iterations = 1) {
    let pts = points;
    for (let it = 0; it < iterations; it++) {
        if (pts.length < 3) break;
        const next = [];
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
            next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
        }
        pts = next;
    }
    return pts;
}

/* Arithmetic mean of [x, y] points -> [cx, cy], or null if empty. */
export function centroid(points) {
    if (!points.length) return null;
    let sx = 0, sy = 0;
    for (let i = 0; i < points.length; i++) { sx += points[i][0]; sy += points[i][1]; }
    return [sx / points.length, sy / points.length];
}
