/*
 * outline.js — turn the hand-drawn lasso into an ordered ring of real surface vertices that
 * traces it, plus pick a representative vertex for the label. Pure.
 *
 * Storing the boundary as VERTICES (not screen/flat coords) is what lets the outline follow
 * pan/zoom and the flat<->3D morph: the adapter reprojects these vertices each frame.
 */
import { simplifyRDP } from "./geom.js";

// RDP tolerance — removes hand tremor, keeps concave corners. In the SAME units as `lasso`/`sel.px`:
// the default suits a screen-pixel lasso; a uv-space caller ([0,1]) MUST pass a uv-scale epsilon.
const DEFAULT_EPSILON = 4;

/*
 * lasso : [[x,y], ...]
 * sel   : { left:[idx], right:[idx], px:{left:[[x,y]], right:[[x,y]]} } from selectInPolygon
 * Returns an ordered ring [{ h:"left"|"right", g:subjectIdx }, ...] (>= 3) or null.
 */
export function buildOutline(lasso, sel, { epsilon = DEFAULT_EPSILON } = {}) {
    let simp = simplifyRDP(lasso, epsilon);
    if (simp.length < 3) simp = lasso;

    const cand = [];
    for (const h of ["left", "right"]) {
        const ids = sel[h], pxs = sel.px[h];
        for (let k = 0; k < ids.length; k++) cand.push({ h, g: ids[k], x: pxs[k][0], y: pxs[k][1] });
    }
    if (!cand.length) return null;

    const ring = [];
    let prev = null;
    for (let i = 0; i < simp.length; i++) {
        const lx = simp[i][0], ly = simp[i][1];
        let best = null, bd = Infinity;
        for (let j = 0; j < cand.length; j++) {
            const dx = cand[j].x - lx, dy = cand[j].y - ly, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = cand[j]; }
        }
        if (best && (!prev || prev.h !== best.h || prev.g !== best.g)) {
            ring.push({ h: best.h, g: best.g });
            prev = best;
        }
    }
    // drop a duplicated closing vertex if the ring wrapped back to its start
    if (ring.length > 2 && ring[0].h === ring[ring.length - 1].h && ring[0].g === ring[ring.length - 1].g) ring.pop();
    return ring.length >= 3 ? ring : null;
}

/* Representative vertex for an ROI's label: the selected vertex nearest the selection centroid. */
export function pickLabelVertex(sel) {
    let cx = 0, cy = 0, n = 0;
    for (const h of ["left", "right"]) for (const p of sel.px[h]) { cx += p[0]; cy += p[1]; n++; }
    if (!n) return null;
    cx /= n; cy /= n;
    let best = null, bd = Infinity;
    for (const h of ["left", "right"]) {
        const ids = sel[h], pxs = sel.px[h];
        for (let k = 0; k < ids.length; k++) {
            const dx = pxs[k][0] - cx, dy = pxs[k][1] - cy, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = { h, g: ids[k] }; }
        }
    }
    return best;
}
