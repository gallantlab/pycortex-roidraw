/*
 * svg-path.js — a drawn shape's outline as an SVG path `d` string in overlay viewBox px.
 *
 * Flat-UV ([0,1]^2, v up) maps to viewBox px as (u*W, (1-v)*H): the overlay's own coordinate
 * system, so a `d` built here drops straight into a subject's overlays.svg. Pure — no DOM, no
 * host — so the live overlay and the sulci export share exactly one path writer.
 */
import { chaikin } from "./geom.js";
import { isClosed, segCount, segControls, hasCurve } from "./bezier.js";

export const RING_SMOOTH_ITERATIONS = 2;   // Chaikin passes that round a v1 vertex-ring outline

/* One flat-UV point in viewBox px. */
export function uvToViewBox(uv, W, H) { return [uv[0] * W, (1 - uv[1]) * H]; }

/* A viewBox px point as "x,y" (2 decimals). */
function fmtPx(p) { return p[0].toFixed(2) + "," + p[1].toFixed(2); }

/* One flat-UV point as "x,y" in viewBox px. */
function fmt(uv, W, H) { return fmtPx(uvToViewBox(uv, W, H)); }

/*
 * Cubic-bezier path from {anchors,inHandles,outHandles} in flat-UV. A CLOSED bezier wraps back to
 * anchor 0 and ends with `Z`; an OPEN one (a sulcus) has n-1 segments and does not close — the
 * missing `Z` is exactly what distinguishes a sulcus from an ROI on disk. segControls/segCount own
 * the wrap rule, the same walk the samplers use, so the baked path is the curve the editor shows.
 * Returns null when the bezier has too few anchors to be a curve of its kind.
 */
export function bezierSvgPath(bez, W, H) {
    if (!hasCurve(bez)) return null;
    let d = "M" + fmt(bez.anchors[0], W, H);
    for (let i = 0, segs = segCount(bez); i < segs; i++) {
        const [, c1, c2, p3] = segControls(bez, i);
        d += "C" + fmt(c1, W, H) + " " + fmt(c2, W, H) + " " + fmt(p3, W, H);
    }
    return isClosed(bez) ? d + "Z" : d;
}

/* A closed polyline through flat-UV points, Chaikin-smoothed in viewBox px; null for fewer than 3. */
export function ringSvgPath(uvs, W, H) {
    if (!uvs || uvs.length < 3) return null;
    const c = chaikin(uvs.map((uv) => uvToViewBox(uv, W, H)), RING_SMOOTH_ITERATIONS);
    let d = "M" + fmtPx(c[0]);
    for (let i = 1; i < c.length; i++) d += "L" + fmtPx(c[i]);
    return d + "Z";
}

/*
 * A shape's outline path. A bezier is emitted as a native cubic path. Only an ROI has the legacy
 * vertex-ring fallback (v1 files); a sulcus is always bezier-backed. Falls THROUGH to the ring
 * when the bezier can't be emitted: an imported file could carry a malformed bezier, and an ROI
 * that still has a good `outline` renders from that instead of vanishing.
 * `vertexUV({h,g})` maps a ring vertex to flat-UV, or null when it has none.
 */
export function shapeSvgPath(shape, W, H, vertexUV) {
    if (shape.bezier && shape.bezier.anchors) {
        const d = bezierSvgPath(shape.bezier, W, H);
        if (d) return d;
    }
    if (shape.kind === "sulcus") return null;
    if (!shape.outline || shape.outline.length < 3) return null;
    const uvs = [];
    for (const o of shape.outline) { const uv = vertexUV(o); if (uv) uvs.push(uv); }
    return ringSvgPath(uvs, W, H);
}
