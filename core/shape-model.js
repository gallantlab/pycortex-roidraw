/*
 * shape-model.js — the shape collection (ROIs + sulci + points) + the portable export/import
 * formats. Pure (no DOM).
 *
 * Every shape has a `kind`: "roi", "sulcus" or "point". An ROI is
 * { id, kind:"roi", name, color, left:[subjectIdx], right:[subjectIdx], outline:[{h,g}],
 *   labelVert:{h,g}, bezier }. A sulcus is display geometry only — pycortex stores no vertex
 * membership for sulci (there is no get_sulci_verts) — so a sulcus OMITS left/right/outline
 * entirely rather than setting them to empty arrays: a reader must not be able to mistake "no
 * membership" for "membership of nothing". A point is { id, kind:"point", name, color, vert:{h,g},
 * xyz } — one vertex of the viewer's mesh, plus that vertex's base-surface position. It has no
 * bezier and no membership either.
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
 *
 * Points have their own document, points-v1 (toPointsJSON / loadJSON). A point's `g` is the vertex
 * index in the VIEWER's mesh order, which is not the subject's order: pycortex's mg2 CTM compression
 * reorders vertices, and the map back (pycortex's cortex.utils.get_ctmmap) needs the pycortex
 * database, which a static viewer doesn't ship. So the document names it `viewerVertex`, and
 * carries `xyz`, the vertex's base-surface position — a reader resolves the subject vertex from
 * either. It re-imports exactly into any viewer built from the same CTM cache (the controller checks
 * xyz against the mesh on import). loadJSON reads both documents.
 */

import { isHemi } from "./hemis.js";

export const FORMAT = "pycortex-roidraw/vertexset-v2";
export const POINTS_FORMAT = "pycortex-roidraw/points-v1";

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
     * label vertex (see the module header for why its vertex fields are absent, not empty); a point
     * carries its one vertex (`vert`) and that vertex's position (`xyz`, or null). */
    add({ kind = "roi", name, color, left = [], right = [], outline = null, labelVert = null, bezier = null,
          vert = null, xyz = null }) {
        if (kind === "point") {
            const shape = { id: this.nextId++, kind, name, color: color || this.nextColor(),
                vert: copyVert(vert), xyz: copyXyz(xyz), bezier: null };
            this.shapes.push(shape);
            return shape;
        }
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

    /* Serialize the points as a points-v1 document: `hemi` + `viewerVertex` (viewer mesh order — see
     * the header) and `xyz`, the vertex's base-surface position (null if unknown). */
    toPointsJSON(surfaceId) {
        return {
            format: POINTS_FORMAT,
            generated: new Date().toISOString(),
            surface: surfaceId || null,
            note: "One vertex per point. viewerVertex is the per-hemisphere index in the viewer's CTM " +
                  "mesh order (pycortex mg2 reorders vertices); map it with cortex.utils.get_ctmmap" +
                  "(subject, method='mg2', level=9): subject vertex = ctm2fs_<hemi>[viewerVertex]. " +
                  "xyz is the vertex's base-surface position in the subject's surface coordinates.",
            points: this.byKind("point").map((p) => ({
                name: p.name,
                color: p.color,
                hemi: p.vert.h,
                viewerVertex: p.vert.g,
                xyz: p.xyz || null,
            })),
        };
    }

    /* Append the shapes of a parsed document: ROIs from a vertexset (v1 or v2), or points from a
     * points-v1 document. Returns the shapes added. Throws on an unknown format. */
    loadJSON(doc) {
        if (doc && doc.format === POINTS_FORMAT) return this._loadPoints(doc);
        return this._loadRois(doc);
    }

    /* Points: each needs a hemi ("left"/"right") and a non-negative integer viewerVertex; an entry
     * without one is skipped rather than guessed at. */
    _loadPoints(doc) {
        const added = [];
        for (const p of (doc.points || [])) {
            if (!p || !isHemi(p.hemi) || !Number.isInteger(p.viewerVertex) || p.viewerVertex < 0) continue;
            added.push(this.add({
                kind: "point",
                name: p.name || this.defaultName("point"),
                color: p.color,
                vert: { h: p.hemi, g: p.viewerVertex },
                xyz: p.xyz,
            }));
        }
        return added;
    }

    /* Append ROIs from a parsed vertexset document (v1 or v2), each tagged kind:"roi". Returns the
     * shapes added. Throws on an unknown format.
     * Purely structural, and DEEPLY copied: the model never aliases the caller's parsed JSON, so a
     * later edit (which mutates a shape's bezier in place) can't reach back into it. A missing
     * labelVert or bezier is left null — the viewer back-fills both from geometry (see
     * draw-pipeline's backfillImported). */
    _loadRois(doc) {
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

/* --- deep copies of the structured fields the documents carry --------------------------------- */

const copyVert = (o) => (o ? { h: o.h, g: o.g } : null);
const copyRing = (ring) => (Array.isArray(ring) ? ring.map(copyVert) : null);
const copyPts = (pts) => pts.map((p) => [p[0], p[1]]);
const copyXyz = (p) => (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : null);

/* "left vertex 94268 (-32.4, 33.6, 34.0)": the one description of a point's location, for the panel
 * and the controller's messages. */
export function describePoint(vert, xyz) {
    return vert.h + " vertex " + vert.g + (xyz ? " (" + xyz.map((c) => c.toFixed(1)).join(", ") + ")" : "");
}

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
