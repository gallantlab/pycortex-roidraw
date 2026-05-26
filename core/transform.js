/*
 * transform.js — a 2D projective transform (homography) between the flat-UV space and screen
 * pixels at the CURRENT flat view. Pure (no DOM/THREE/host): unit-testable.
 *
 * Used ONLY by the bezier edit overlay: anchors are stored in view-independent uv, but to draw
 * and drag them we need where they land on screen right now. At full-flat the whole flatmap is
 * one plane, so uv->px is exactly a homography; we fit it from the (uv, px) correspondences the
 * adapter already produces for the in-frustum vertices, and invert it to map drag clicks back.
 *
 * H is a row-major 9-array [h0..h8]:  [u' v' w'] = H * [x y 1];  result = [u'/w', v'/w'].
 */

/* Solve A x = b for an n x n system (Gaussian elimination, partial pivoting). Returns x or null. */
function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat(b[i])); // augmented
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        if (Math.abs(M[piv][col]) < 1e-12) return null; // singular
        const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
        const pv = M[col][col];
        for (let j = col; j <= n; j++) M[col][j] /= pv;
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = M[r][col];
            if (f === 0) continue;
            for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
        }
    }
    return M.map((row) => row[n]);
}

/*
 * True iff the points span two dimensions (not collinear or coincident) — a homography is
 * under-determined otherwise. Uses the covariance eigenvalue ratio, so it catches collinearity
 * along ANY direction, not just axis-aligned.
 */
function spans2D(pts) {
    const n = pts.length;
    if (n < 4) return false;
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx /= n; cy /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
        const dx = pts[i][0] - cx, dy = pts[i][1] - cy;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const mean = (sxx + syy) / 2, half = (sxx - syy) / 2;
    const d = Math.sqrt(half * half + sxy * sxy);
    const l1 = mean + d, l2 = mean - d;          // covariance eigenvalues
    return l1 > 0 && l2 >= l1 * 1e-6;
}

/*
 * Fit the homography mapping src -> dst from >= 4 point correspondences (least squares).
 * src, dst: arrays of [x, y] of equal length. Returns a 9-array H, or null if the fit is
 * under-determined (too few / collinear points) or degenerate (non-finite entries) — callers
 * should keep their last good fit rather than apply a garbage transform.
 */
export function fitHomography(src, dst) {
    const n = Math.min(src.length, dst.length);
    if (n < 4 || !spans2D(src)) return null;
    // Unknowns h0..h7 (h8 fixed to 1). Two equations per point:
    //   h0 x + h1 y + h2          - h6 x u - h7 y u = u
    //            h3 x + h4 y + h5 - h6 x v - h7 y v = v
    const ATA = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const ATb = new Array(8).fill(0);
    const row = new Array(8);
    const accum = (r, rhs) => {
        for (let i = 0; i < 8; i++) {
            ATb[i] += r[i] * rhs;
            for (let j = 0; j < 8; j++) ATA[i][j] += r[i] * r[j];
        }
    };
    for (let k = 0; k < n; k++) {
        const x = src[k][0], y = src[k][1], u = dst[k][0], v = dst[k][1];
        row[0] = x; row[1] = y; row[2] = 1; row[3] = 0; row[4] = 0; row[5] = 0; row[6] = -x * u; row[7] = -y * u;
        accum(row, u);
        row[0] = 0; row[1] = 0; row[2] = 0; row[3] = x; row[4] = y; row[5] = 1; row[6] = -x * v; row[7] = -y * v;
        accum(row, v);
    }
    const h = solve(ATA, ATb);
    if (!h) return null;
    const H = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    for (let i = 0; i < 9; i++) if (!isFinite(H[i])) return null;   // ill-conditioned -> reject
    return H;
}

/* Apply a homography to a point [x, y] -> [u, v]. */
export function applyHomography(H, pt) {
    const x = pt[0], y = pt[1];
    let w = H[6] * x + H[7] * y + H[8];
    // guard the projective divide: a point on/near the vanishing line gives Infinity/NaN, which
    // must never reach a stored anchor. Clamp a tiny or non-finite w to a tiny magnitude instead.
    if (!isFinite(w) || Math.abs(w) < 1e-12) w = w < 0 ? -1e-12 : 1e-12;
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/* Invert a 3x3 homography. Returns a 9-array, or null if singular. */
export function invertHomography(H) {
    const a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7], i = H[8];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    const id = 1 / det;
    return [
        A * id, (c * h - b * i) * id, (b * f - c * e) * id,
        B * id, (a * i - c * g) * id, (c * d - a * f) * id,
        C * id, (b * g - a * h) * id, (a * e - b * d) * id,
    ];
}
