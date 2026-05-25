/*
 * selection.js — turn a lasso polygon + projected vertices into a selected vertex set.
 * Pure: the adapter does the (host-specific) projection and hands us screen-space points.
 */
import { polygonBounds, inBounds, pointInPolygon } from "./geom.js";

/*
 * projected: { left:  { idx: [subjectIdx...], px: [[x,y]...] },   // in-frustum vertices only
 *              right: { idx: [...],            px: [...] } }
 * lasso:     [[x,y], ...] in the same screen-pixel space as px.
 *
 * Returns { left:[idx...], right:[idx...], px:{left:[[x,y]...], right:[...]}, total }.
 * `px` is kept aligned with the selected indices so the outline builder can snap to them.
 */
export function selectInPolygon(projected, lasso) {
    const bounds = polygonBounds(lasso);
    const out = { left: [], right: [], px: { left: [], right: [] }, total: 0 };
    for (const h of ["left", "right"]) {
        const p = projected[h];
        if (!p) continue;
        const idx = p.idx, px = p.px;
        for (let k = 0; k < px.length; k++) {
            const pt = px[k];
            if (!inBounds(pt, bounds)) continue;       // cheap reject
            if (pointInPolygon(pt, lasso)) {
                out[h].push(idx[k]);
                out.px[h].push(pt);
                out.total++;
            }
        }
    }
    return out;
}
