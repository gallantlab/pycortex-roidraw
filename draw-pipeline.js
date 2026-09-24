/*
 * draw-pipeline.js — the shape-derivation pipeline, using only a ViewerAdapter + the pure core.
 *   ROI:    lasso (or an edited bezier) -> vertex membership + outline ring + label + bezier.
 *   Sulcus: traced stroke -> px->uv via a homography -> open bezier + a live-overlay label vertex.
 * No DOM, no UI, no prompt — that stays in the controller — so this whole "does the geometry do
 * what we think" path is testable headless against a synthetic-surface adapter.
 *
 * The bezier is the source of truth: when a lasso yields a fittable curve, membership is RE-DERIVED
 * from the curve (in view-independent flat-UV) so the stored vertices match the editable outline.
 */
import { selectInPolygon } from "./core/selection.js";
import { buildOutline, pickLabelVertex } from "./core/outline.js";
import { fitClosedBezier, evalClosedBezier, fitOpenBezier, evalOpenBezier } from "./core/bezier.js";
import { fitHomography, applyHomography, invertHomography } from "./core/transform.js";
import { nearestIndex, sqDist } from "./core/geom.js";
import { HEMIS } from "./core/hemis.js";
import { uvPxCorrespondences } from "./adapter/viewer-adapter.js";

export const BEZIER_SAMPLES = 16;  // samples/segment when rasterizing a bezier to a uv polygon for selection
export const TRACE_SAMPLES = 24;   // samples/segment when locating a curve's parametric midpoint
// RDP tolerance (uv units) for the outline ring built in uv space. It simplifies the densely
// sampled, already-smooth bezier polygon only to choose which boundary vertices the ring snaps to,
// so it sits a little under bezier.js's anchor-picking UV_RDP_EPSILON (0.004) to hug the curve.
const OUTLINE_EPS_UV = 0.003;

// Map an outline ring [{h,g}] to flat-UV points [[u,v],...], dropping vertices with no uv.
function ringToUv(adapter, ring) {
    if (!ring) return null;
    const uv = [];
    for (const o of ring) { const p = adapter.vertexUV(o); if (p) uv.push(p); }
    return uv;
}

/* Fit a closed bezier to a vertex ring mapped into flat-UV, or null when fewer than 3 of its
 * vertices have uv. The one rule for "ring -> bezier", shared by the lasso path and the import
 * back-fill of an ROI that has an outline but no bezier (so it edits like a freshly drawn one). */
export function backfillBezier(adapter, ring) {
    const ringUv = ringToUv(adapter, ring);
    return ringUv && ringUv.length >= 3 ? fitClosedBezier(ringUv) : null;
}

/* The vertex of `verts` ([{h,g}...]) nearest their flat-UV centroid, or null if none has uv. */
function labelFromVertices(adapter, verts) {
    const sel = { left: [], right: [], px: { left: [], right: [] } };
    for (const o of verts) {
        const uv = adapter.vertexUV(o);
        if (uv) { sel[o.h].push(o.g); sel.px[o.h].push(uv); }   // feed uv where pickLabelVertex expects px
    }
    return pickLabelVertex(sel);
}

/* A label vertex from an outline ring alone: the RING vertex nearest the ring's centroid —
 * necessarily a boundary vertex. The last resort for an ROI with neither members nor a bezier.
 * Returns {h,g} or null. */
export function backfillLabel(adapter, ring) {
    return ring ? labelFromVertices(adapter, ring) : null;
}

/*
 * Complete ROIs just imported from a file, in place: fit a bezier for any that has an outline but
 * no bezier, then fill a missing labelVert with the rule freshly drawn ROIs use — the MEMBER nearest
 * the centroid. The members come from the file when it lists them (cheap), else from the bezier
 * (a full uv selection); an ROI with neither falls back to its outline ring (backfillLabel).
 * Non-ROI shapes are skipped. Returns how many beziers were fitted.
 */
export function backfillImported(adapter, rois) {
    let fitted = 0;
    for (const roi of rois) {
        if (roi.kind && roi.kind !== "roi") continue;
        if (!roi.bezier && roi.outline) {
            const bez = backfillBezier(adapter, roi.outline);
            if (bez) { roi.bezier = bez; fitted++; }
        }
        if (!roi.labelVert) {
            const members = [
                ...(roi.left || []).map((g) => ({ h: "left", g })),
                ...(roi.right || []).map((g) => ({ h: "right", g })),
            ];
            let lv = members.length ? labelFromVertices(adapter, members) : null;
            if (!lv && roi.bezier) { const d = roiFromBezier(adapter, roi.bezier); lv = d && d.labelVert; }
            lv = lv || backfillLabel(adapter, roi.outline);
            if (lv) roi.labelVert = lv;
        }
    }
    return fitted;
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
    const fitted = backfillBezier(adapter, lassoRing);
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

/*
 * Nearest surface vertex to a flat-UV point. Brute force over every vertex: this runs once per
 * drawn curve, not per frame. It is the roidraw analogue of pycortex's SVGOverlay.set_coords,
 * which builds a cKDTree over the flat vertex coords purely to place a LABEL (`data-ptidx`).
 * Returns {h,g} or null on an empty surface.
 */
export function nearestVertexTo(adapter, uv) {
    const all = adapter.allVertexUV();
    let best = null, bd = Infinity;
    for (const h of HEMIS) {
        const p = all[h];
        const k = p ? nearestIndex(p.uv, uv) : -1;
        if (k < 0) continue;
        const d = sqDist(p.uv[k], uv);
        if (d < bd) { bd = d; best = { h, g: p.idx[k] }; }
    }
    return best;
}

/* The label vertex for an OPEN curve: the surface vertex nearest the curve's midpoint sample.
 * Shared by the initial trace and by every subsequent edit, so a reshaped sulcus relabels the
 * same way a freshly traced one does. Returns {h,g} or null.
 *
 * FOR THE LIVE IN-VIEWER OVERLAY ONLY. The WebGL viewer places a label by vertex index
 * (`data-ptidx`); the exported overlays.svg must NOT carry one, because pycortex computes sulcus
 * label positions from the path geometry itself at load time. See core/svg-export.js.
 *
 * Assumes `bezier` is open: it samples with evalOpenBezier, which on a CLOSED ring would silently
 * skip the wrap segment and pick a subtly wrong midpoint. Pass an ROI's bezier to roiFromBezier
 * (centroid-nearest) instead. */
export function labelForCurve(adapter, bezier) {
    const poly = evalOpenBezier(bezier, TRACE_SAMPLES);
    const mid = poly[poly.length >> 1];
    return mid ? nearestVertexTo(adapter, mid) : null;
}

/*
 * A traced stroke -> an editable OPEN bezier, plus a label vertex.
 *
 * A sulcus stores NO vertex membership — pycortex stores none either (there is no
 * get_sulci_verts; sulci are display geometry). The curve is the datum, so there is no
 * re-derivation step and no way for stored vertices to disagree with the editable curve.
 *
 * The stroke arrives in screen px and must be stored in view-independent flat-uv. At full flat the
 * flatmap is one plane, so uv->px is exactly a homography; we fit it from the (uv, px)
 * correspondences the adapter already produces and invert it. PRECONDITION: the surface is flat
 * (drawing is flat-only — see DrawModeMachine). Returns null on a degenerate stroke or a
 * homography that won't fit (a collinear/degenerate view).
 */
export function curveFromTrace(adapter, pts) {
    if (!pts || pts.length < 2) return null;
    const c = uvPxCorrespondences(adapter);            // the whole flatmap (a global fit)
    if (c.src.length < 4) return null;
    const H = fitHomography(c.src, c.dst);
    if (!H) return null;
    const Hinv = invertHomography(H);
    if (!Hinv) return null;

    // drop stroke points with no uv image (on the vanishing line: applyHomography returns null).
    // fitOpenBezier dedupes and rejects a stroke that collapses to fewer than 2 distinct points.
    const uvPts = pts.map((p) => applyHomography(Hinv, p)).filter(Boolean);
    const bezier = fitOpenBezier(uvPts);
    if (!bezier) return null;

    return { bezier, labelVert: labelForCurve(adapter, bezier) };
}
