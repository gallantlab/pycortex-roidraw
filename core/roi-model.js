/*
 * roi-model.js — the ROI collection + the portable export/import format. Pure (no DOM).
 *
 * An ROI is { id, name, color, left:[subjectIdx], right:[subjectIdx], outline:[{h,g}],
 *             labelVert:{h,g}, bezier }.
 * The serialized form references SUBJECT vertex indices, so it ports to any viewer built on the
 * same surface. `outline`/`labelVert` reconstruct the boundary + label; `bezier` is the editable
 * smooth boundary in flat-UV space (see core/bezier.js) — vertices are DERIVED from it, so the
 * bezier is the source of truth when an ROI is reloaded and re-edited. The bezier descriptor
 * ({anchors, inHandles, outHandles, smooth}) is written/read verbatim, so its explicit tangent
 * handles and per-anchor smooth flags round-trip for free; a `bezier` from an earlier build simply
 * lacks `smooth` and is treated as all-smooth on edit (the format stays vertexset-v2 — additive).
 *
 * `bezier` is null for ROIs (or v1 files) drawn before this feature; the importer back-fills one.
 */

export const FORMAT = "pycortex-roidraw/vertexset-v2";

const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c"];

export class ROISet {
    constructor() {
        this.rois = [];
        this.nextId = 1;
    }

    get length() { return this.rois.length; }

    nextColor() { return PALETTE[(this.nextId - 1) % PALETTE.length]; }

    add({ name, color, left, right, outline = null, labelVert = null, bezier = null }) {
        const roi = {
            id: this.nextId++,
            name: name,
            color: color || this.nextColor(),
            left: left, right: right,
            outline: outline, labelVert: labelVert,
            bezier: bezier,
        };
        this.rois.push(roi);
        return roi;
    }

    remove(id) { this.rois = this.rois.filter((r) => r.id !== id); }

    clear() { this.rois = []; }

    toJSON(surfaceId) {
        return {
            format: FORMAT,
            generated: new Date().toISOString(),
            surface: surfaceId || null,
            note: "Per-hemisphere subject vertex indices + an ordered boundary ring (outline) + an " +
                  "editable flat-UV bezier. Portable to any viewer built on the same surface.",
            rois: this.rois.map((r) => ({
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

    /* Append ROIs from a parsed document. Returns the ROIs added. Throws on an unknown format. */
    loadJSON(doc) {
        if (!doc || !doc.format || doc.format.indexOf("pycortex-roidraw") !== 0)
            throw new Error("unrecognized format: " + (doc && doc.format));
        const added = [];
        for (const r of (doc.rois || [])) {
            const v = r.vertices || {};
            const roi = this.add({
                name: r.name || ("roi" + this.nextId),
                color: r.color,
                left: v.left || [], right: v.right || [],
                outline: r.outline || null,
                labelVert: r.labelVert || null,
                bezier: r.bezier || null,
            });
            // back-fill a label vertex from the ring if the file lacked one
            if (!roi.labelVert && roi.outline && roi.outline.length)
                roi.labelVert = roi.outline[Math.floor(roi.outline.length / 2)];
            added.push(roi);
        }
        return added;
    }
}
