/*
 * shape-model.js — the shape collection (ROIs + sulci) + the portable export/import format. Pure
 * (no DOM).
 *
 * Every shape has a `kind`: "roi" or "sulcus". An ROI is
 * { id, kind:"roi", name, color, left:[subjectIdx], right:[subjectIdx], outline:[{h,g}],
 *   labelVert:{h,g}, bezier }. A sulcus is display geometry only — pycortex stores no vertex
 * membership for sulci (there is no get_sulci_verts) — so a sulcus OMITS left/right/outline
 * entirely rather than setting them to empty arrays: a reader must not be able to mistake "no
 * membership" for "membership of nothing".
 *
 * The serialized form references SUBJECT vertex indices, so it ports to any viewer built on the
 * same surface. `outline`/`labelVert` reconstruct the boundary + label; `bezier` is the editable
 * smooth boundary in flat-UV space (see core/bezier.js) — vertices are DERIVED from it, so the
 * bezier is the source of truth when an ROI is reloaded and re-edited. The bezier descriptor
 * ({anchors, inHandles, outHandles, smooth}) is written/read verbatim, so its explicit tangent
 * handles and per-anchor smooth flags round-trip for free; a `bezier` from an earlier build simply
 * lacks `smooth` and is treated as all-smooth on edit (the format stays vertexset-v2 — additive).
 *
 * `bezier` is null for ROIs (or v1 files) drawn before this feature; the importer back-fills one.
 *
 * The vertexset-v2 document is an ROI format only: it describes per-hemisphere vertex membership,
 * which a sulcus does not have. toJSON therefore serializes ROIs only, and loadJSON tags every
 * imported entry kind:"roi" (a vertexset document only ever holds ROIs). Sulci are exported
 * separately, as pycortex's own overlays.svg markup — see core/svg-export.js.
 */

export const FORMAT = "pycortex-roidraw/vertexset-v2";

const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c"];

export class ShapeSet {
    constructor() {
        this.shapes = [];
        this.nextId = 1;
    }

    get length() { return this.shapes.length; }

    byKind(kind) { return this.shapes.filter((s) => s.kind === kind); }

    nextColor() { return PALETTE[(this.nextId - 1) % PALETTE.length]; }

    /* An ROI carries membership (left/right/outline); a sulcus carries only its open bezier and a
     * label vertex. Vertex fields are omitted entirely for sulci rather than set to empty arrays,
     * so a downstream reader can't mistake "no membership" for "membership of nothing". */
    add({ kind = "roi", name, color, left = [], right = [], outline = null, labelVert = null, bezier = null }) {
        const shape = { id: this.nextId++, kind, name, color: color || this.nextColor(), labelVert, bezier };
        // An ROI always HAS the membership fields (possibly empty); a sulcus never does. Callers
        // read `roi.left.length` unguarded, so default them rather than let `undefined` through.
        if (kind === "roi") { shape.left = left; shape.right = right; shape.outline = outline; }
        this.shapes.push(shape);
        return shape;
    }

    remove(id) { this.shapes = this.shapes.filter((s) => s.id !== id); }

    clear() { this.shapes = []; }

    /* The vertexset-v2 document is an ROI format: it describes per-hemisphere vertex membership,
     * which a sulcus does not have. Unchanged from v2 on purpose; v1/v2 files keep importing. */
    toJSON(surfaceId) {
        return {
            format: FORMAT,
            generated: new Date().toISOString(),
            surface: surfaceId || null,
            note: "Per-hemisphere subject vertex indices + an ordered boundary ring (outline) + an " +
                  "editable flat-UV bezier. Portable to any viewer built on the same surface.",
            rois: this.byKind("roi").map((r) => ({
                name: r.name,
                color: r.color,
                counts: { left: r.left.length, right: r.right.length },
                vertices: { left: r.left, right: r.right },
                outline: r.outline || null,
                labelVert: r.labelVert || null,
                bezier: r.bezier || null,
            })),
        };
    }

    /* Append ROIs from a parsed document. A vertexset document only ever holds ROIs, so every
     * entry is tagged kind:"roi". Returns the shapes added. Throws on an unknown format.
     * Purely structural, and DEEPLY copied: the model never aliases the caller's parsed JSON, so a
     * later edit (which mutates a shape's bezier in place) can't reach back into it. A missing
     * labelVert is left null — the viewer back-fills it from geometry (see draw-pipeline's
     * backfillLabel), so reloaded ROIs label the same way freshly drawn ones do. */
    loadJSON(doc) {
        if (!doc || !doc.format || !String(doc.format).startsWith("pycortex-roidraw"))
            throw new Error("unrecognized format: " + (doc && doc.format));
        const added = [];
        for (const r of (doc.rois || [])) {
            const v = r.vertices || {};
            added.push(this.add({
                kind: "roi",
                name: r.name || ("roi" + this.nextId),
                color: r.color,
                left: (v.left || []).slice(), right: (v.right || []).slice(),
                outline: copyRing(r.outline),
                labelVert: copyVert(r.labelVert),
                bezier: copyBezier(r.bezier),
            }));
        }
        return added;
    }
}

/* --- deep copies of the three structured fields a vertexset document carries ------------------ */

const copyVert = (o) => (o ? { h: o.h, g: o.g } : null);
const copyRing = (ring) => (Array.isArray(ring) ? ring.map(copyVert) : null);
const copyPts = (pts) => (Array.isArray(pts) ? pts.map((p) => [p[0], p[1]]) : []);

/* Copy a bezier descriptor verbatim (including a `closed` flag or `smooth[]` an older file lacks —
 * cloneBezier back-fills those on the first edit). Returns null for anything that isn't one. */
function copyBezier(bez) {
    if (!bez || !Array.isArray(bez.anchors)) return null;
    const out = {
        anchors: copyPts(bez.anchors),
        inHandles: copyPts(bez.inHandles),
        outHandles: copyPts(bez.outHandles),
    };
    if (bez.closed !== undefined) out.closed = !!bez.closed;
    if (Array.isArray(bez.smooth)) out.smooth = bez.smooth.map(Boolean);
    return out;
}
