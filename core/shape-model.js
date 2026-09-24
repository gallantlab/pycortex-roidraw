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
 * ({closed, anchors, inHandles, outHandles, smooth}) is written/read verbatim, so its explicit
 * tangent handles and per-anchor smooth flags round-trip. A reader must accept a bezier without
 * `closed` or `smooth` (cloneBezier supplies the defaults) and an ROI with no bezier at all (a v1
 * file, or a v2 entry that never had one); the viewer back-fills the latter from its outline.
 *
 * The vertexset-v2 document is an ROI format only: it describes per-hemisphere vertex membership,
 * which a sulcus does not have. toJSON therefore serializes ROIs only, and loadJSON tags every
 * imported entry kind:"roi". Sulci are exported separately, as pycortex's own overlays.svg markup
 * — see core/svg-export.js.
 */

export const FORMAT = "pycortex-roidraw/vertexset-v2";

const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c"];

export class ShapeSet {
    constructor() {
        this.shapes = [];
        this.nextId = 1;
    }

    /* The shape with this id, or undefined. */
    get(id) { return this.shapes.find((s) => s.id === id); }

    byKind(kind) { return this.shapes.filter((s) => s.kind === kind); }

    nextColor() { return PALETTE[(this.nextId - 1) % PALETTE.length]; }

    /* The name offered for a new shape of `kind` when the user (or an imported file) gives none:
     * "roi3" for the third ROI, "sulcus1" for the first sulcus — numbered per kind, so sulci don't
     * skip the ROI numbering. The number starts at count+1 and steps past any name already in use
     * (after deleting sulcus1 of two, the next is "sulcus3", not a second "sulcus2" — svg-export
     * would merge two same-named sulci). One rule for the prompt default and the import fallback. */
    defaultName(kind) {
        const taken = new Set(this.shapes.map((s) => s.name));
        let k = this.byKind(kind).length + 1;
        while (taken.has(kind + k)) k++;
        return kind + k;
    }

    /* An ROI carries membership (left/right/outline); a sulcus carries only its open bezier and a
     * label vertex (see the module header for why its vertex fields are absent, not empty). */
    add({ kind = "roi", name, color, left = [], right = [], outline = null, labelVert = null, bezier = null }) {
        const shape = { id: this.nextId++, kind, name, color: color || this.nextColor(), labelVert, bezier };
        // callers read `roi.left.length` unguarded, so an ROI's fields default to empty
        if (kind === "roi") { shape.left = left; shape.right = right; shape.outline = outline; }
        this.shapes.push(shape);
        return shape;
    }

    remove(id) { this.shapes = this.shapes.filter((s) => s.id !== id); }

    clear() { this.shapes = []; }

    /* Serialize the ROIs as a vertexset-v2 document (sulci are not part of it — see the header). */
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

    /* Append ROIs from a parsed vertexset document (v1 or v2), each tagged kind:"roi". Returns the
     * shapes added. Throws on an unknown format.
     * Purely structural, and DEEPLY copied: the model never aliases the caller's parsed JSON, so a
     * later edit (which mutates a shape's bezier in place) can't reach back into it. A missing
     * labelVert or bezier is left null — the viewer back-fills both from geometry (see
     * draw-pipeline's backfillImported). */
    loadJSON(doc) {
        if (!doc || !doc.format || !String(doc.format).startsWith("pycortex-roidraw"))
            throw new Error("unrecognized format: " + (doc && doc.format));
        const added = [];
        for (const r of (doc.rois || [])) {
            const v = r.vertices || {};
            added.push(this.add({
                kind: "roi",
                name: r.name || this.defaultName("roi"),
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
const copyPts = (pts) => pts.map((p) => [p[0], p[1]]);

/* Copy a bezier descriptor verbatim; a missing `closed` flag or `smooth[]` stays missing
 * (cloneBezier supplies the defaults on the first edit). Returns null for anything that isn't a
 * usable bezier — including one whose handle arrays are missing or don't pair one-to-one with its
 * anchors, which would crash the sampler — so the importer re-fits the curve from the outline. */
function copyBezier(bez) {
    if (!bez || !Array.isArray(bez.anchors) || !Array.isArray(bez.inHandles) || !Array.isArray(bez.outHandles)) return null;
    const n = bez.anchors.length;
    if (bez.inHandles.length !== n || bez.outHandles.length !== n) return null;
    const out = {
        anchors: copyPts(bez.anchors),
        inHandles: copyPts(bez.inHandles),
        outHandles: copyPts(bez.outHandles),
    };
    if (bez.closed !== undefined) out.closed = !!bez.closed;
    if (Array.isArray(bez.smooth)) out.smooth = bez.smooth.map(Boolean);
    return out;
}
