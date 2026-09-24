/*
 * outline.js — turn the hand-drawn lasso into an ordered ring of real surface vertices that
 * traces it, plus pick a representative vertex for the label. Pure.
 *
 * Storing the boundary as VERTICES (not screen/flat coords) is what lets the outline follow
 * pan/zoom and the flat<->3D morph: the adapter reprojects these vertices each frame.
 */
import { simplifyRDP, centroid, nearestIndex, dedupeRing } from "./geom.js";
import { HEMIS } from "./hemis.js";

// RDP tolerance in PIXEL units — removes hand tremor, keeps concave corners. In the SAME units as
// `lasso`/`sel.px`: the default suits a screen-pixel lasso; a uv-space caller ([0,1]) MUST pass a
// uv-scale epsilon (cf. bezier.js's UV_RDP_EPSILON, ~1000× smaller — a different coordinate space).
const PIXEL_RDP_EPSILON = 4;

/*
 * lasso : [[x,y], ...]
 * sel   : { left:[idx], right:[idx], px:{left:[[x,y]], right:[[x,y]]} } from selectInPolygon
 * Returns an ordered ring [{ h:"left"|"right", g:subjectIdx }, ...] (>= 3) or null.
 */
export function buildOutline(lasso, sel, { epsilon = PIXEL_RDP_EPSILON } = {}) {
    let simp = simplifyRDP(lasso, epsilon);
    if (simp.length < 3) simp = lasso;

    const candPts = [], candRefs = [];
    for (const h of HEMIS) {
        const ids = sel[h], pxs = sel.px[h];
        for (let k = 0; k < ids.length; k++) { candPts.push(pxs[k]); candRefs.push({ h, g: ids[k] }); }
    }
    if (!candPts.length) return null;

    // snap each simplified lasso point to its nearest selected vertex, then collapse repeats (and a
    // ring that wrapped back to its start) so the ring never visits one vertex twice in a row
    const snapped = simp.map((p) => candRefs[nearestIndex(candPts, p)]);
    const ring = dedupeRing(snapped, (a, b) => a.h === b.h && a.g === b.g).map((o) => ({ h: o.h, g: o.g }));
    return ring.length >= 3 ? ring : null;
}

/* Representative vertex for an ROI's label: the selected vertex nearest the selection centroid,
 * in whatever space `sel.px` is in. Returns {h,g} or null for an empty selection. */
export function pickLabelVertex(sel) {
    const pts = [], refs = [];
    for (const h of HEMIS) {
        const ids = sel[h], pxs = sel.px[h];
        for (let k = 0; k < ids.length; k++) { pts.push(pxs[k]); refs.push({ h, g: ids[k] }); }
    }
    const c = centroid(pts);
    return c ? refs[nearestIndex(pts, c)] : null;
}
