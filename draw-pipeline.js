/*
 * draw-pipeline.js — the ROI-derivation pipeline: turn a lasso (or an edited bezier) into the
 * stored ROI geometry, using only a ViewerAdapter + the pure core. No DOM, no UI, no prompt — that
 * stays in the controller — so this whole "does the geometry do what we think" path is testable
 * headless against a synthetic-surface adapter.
 *
 * The bezier is the source of truth: when a lasso yields a fittable curve, membership is RE-DERIVED
 * from the curve (in view-independent flat-UV) so the stored vertices match the editable outline.
 */
import { selectInPolygon } from "./core/selection.js";
import { buildOutline, pickLabelVertex } from "./core/outline.js";
import { fitClosedBezier, evalClosedBezier } from "./core/bezier.js";

const BEZIER_SAMPLES = 16;    // samples/segment when rasterizing a bezier to a uv polygon for selection
const OUTLINE_EPS_UV = 0.003; // RDP tolerance (uv units) for the outline ring built in uv space

// Map an outline ring [{h,g}] to flat-UV points [[u,v],...], dropping vertices with no uv.
function ringToUv(adapter, ring) {
    if (!ring) return null;
    const uv = [];
    for (const o of ring) { const p = adapter.vertexUV(o); if (p) uv.push(p); }
    return uv;
}

// Back-fill an editable bezier for a v1 ROI (one saved before the bezier feature) from its stored
// outline ring, so imported shapes edit just like freshly drawn ones. Returns a bezier or null.
export function backfillBezier(adapter, ring) {
    const ringUv = ringToUv(adapter, ring);
    return ringUv && ringUv.length >= 3 ? fitClosedBezier(ringUv) : null;
}

// Pick a label vertex for an imported ROI whose file lacked one, using the SAME rule as freshly
// drawn ROIs (pickLabelVertex: the boundary vertex nearest the centroid, computed in flat-UV).
// Returns {h,g} or null. So reloaded and fresh ROIs label identically.
export function backfillLabel(adapter, ring) {
    if (!ring) return null;
    const sel = { left: [], right: [], px: { left: [], right: [] } };
    for (const o of ring) {
        const uv = adapter.vertexUV(o);
        if (uv) { sel[o.h].push(o.g); sel.px[o.h].push(uv); }   // feed uv where pickLabelVertex expects px
    }
    return pickLabelVertex(sel);
}

/*
 * Derive ROI membership + outline + label from a bezier, entirely in flat-UV (view-independent, so a
 * reloaded ROI selects the same vertices). selectInPolygon/buildOutline are coordinate-space
 * agnostic, so we feed them uv where they'd normally get screen px.
 * Returns { left, right, outline, labelVert, total } or null if the curve can't be rasterized.
 */
export function roiFromBezier(adapter, bezier) {
    const poly = evalClosedBezier(bezier, BEZIER_SAMPLES);
    if (poly.length < 3) return null;
    const all = adapter.allVertexUV();
    const projectedUv = { left: { idx: all.left.idx, px: all.left.uv }, right: { idx: all.right.idx, px: all.right.uv } };
    const sel = selectInPolygon(projectedUv, poly);
    const outline = buildOutline(poly, sel, { epsilon: OUTLINE_EPS_UV });   // uv tolerance, not px
    return { left: sel.left, right: sel.right, outline, labelVert: pickLabelVertex(sel), total: sel.total };
}

/*
 * Full lasso → derived ROI geometry. Selects the lassoed vertices at the current view, fits an
 * editable bezier to the resulting ring (in flat-UV), then re-derives membership FROM the bezier so
 * the stored vertices match the editable curve. Falls back to the raw lasso selection when no curve
 * can be fit. Returns { left, right, outline, labelVert, bezier, total }; total === 0 means nothing
 * was enclosed (the caller should abort the add).
 */
export function deriveRoiFromLasso(adapter, pts) {
    const projected = adapter.projectVertices({ subsample: 1 });
    const sel0 = selectInPolygon(projected, pts);
    if (!sel0.total) return { left: [], right: [], outline: null, labelVert: null, bezier: null, total: 0 };

    const lassoRing = buildOutline(pts, sel0);                       // px-space ring of the stroke
    const ringUv = ringToUv(adapter, lassoRing);
    const fitted = ringUv && ringUv.length >= 3 ? fitClosedBezier(ringUv) : null;
    // Prefer bezier-derived membership so the stored vertices match the editable curve. But only keep
    // the bezier if it actually encloses something: a curve that re-derives to zero vertices (a very
    // thin/tiny ROI the smoothing shrank past every vertex) would leave the bezier — the source of
    // truth for the drawn outline and future edits — disagreeing with the fallback lasso vertices. In
    // that case drop it, so the ROI stays a consistent (non-editable) vertex set.
    const derived = fitted ? roiFromBezier(adapter, fitted) : null;
    if (derived && derived.total)
        return { left: derived.left, right: derived.right, outline: derived.outline, labelVert: derived.labelVert, bezier: fitted, total: derived.total };
    return {
        left: sel0.left, right: sel0.right, outline: lassoRing,
        labelVert: pickLabelVertex(sel0), bezier: null, total: sel0.total,
    };
}
