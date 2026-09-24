/*
 * pycortex-overlay.js — the drawn-shape layer inside pycortex's SVG overlay (surface.svg), owned
 * by PycortexAdapter, which delegates its overlay-layer methods here.
 *
 * pycortex rasterizes its overlays.svg into a surface texture, so a <g class="display_layer">
 * appended there renders INTO the surface: it occludes and morphs exactly like the built-in ROIs.
 * Conventions this file relies on:
 *   - Paths live in the overlay's *viewBox* coordinate system (init sets viewBox to the original
 *     svg size; setHeight later overwrites width/height to the render size).
 *   - Labels are pycortex's own svgoverlay.Labels sprites, placed by `data-ptidx`: left =
 *     subjectIdx, right = leftVertexCount + subjectIdx.
 *   - svgo.update() re-rasterizes asynchronously (the adapter repaints on the surface's "update").
 *   - A layer is registered as svgo.layers[name] (and svgo[name]) with a showhide(state) method,
 *     like the built-in rois/sulci layers.
 *
 * The adapter draws ONE layer at a time: the controller bakes every shape into a single named
 * layer, and replacing it tears the previous one down (whatever its name was).
 */
import { shapeSvgPath, bezierSvgPath } from "../core/svg-path.js";
import { exportSulciSvg, SULCI_STROKE_WIDTH, SULCI_STROKE_OPACITY } from "../core/svg-export.js";

const SVGNS = "http://www.w3.org/2000/svg";

const FALLBACK_TEX_W = 1024;      // label-sprite scale fallback when the surface reports no size
const FALLBACK_TEX_H = 768;
const OUTLINE_STROKE_PX = 3;      // ROI colored-outline stroke width, in overlay viewBox px
const OUTLINE_HALO_PX = 2;        // extra width of the white halo drawn under the colored stroke
const OUTLINE_HALO_OPACITY = 0.9; // ...and its stroke-opacity
const OUTLINE_FALLBACK_COLOR = "#ffffff"; // stroke when an ROI has no (valid) color
const LABEL_FONT_PT = 14;         // ROI label font size, in pt
// Label style, matching pycortex's own overlay labels (the #dropshadow filter is defined there).
const LABEL_STYLE = "font-family:Helvetica, sans-serif;font-size:" + LABEL_FONT_PT + "pt;font-weight:bold;" +
    "font-style:italic;fill:white;fill-opacity:1;text-anchor:middle;filter:url(#dropshadow)";
// The live overlay strokes a sulcus exactly as the exported markup does. Both read the same two
// constants (from pycortex's defaults.cfg [sulci_paths]) so they cannot drift apart.
const CURVE_STROKE_PX = SULCI_STROKE_WIDTH;
const CURVE_STROKE_OPACITY = SULCI_STROKE_OPACITY;
const DRAWN_FOLDER = "drawn ROIs";  // control-panel folder under Surface > overlays (holds sulci too)

/*
 * A CSS hex color (#rgb / #rgba / #rrggbb / #rrggbbaa) or the fallback. ROI colors are our own
 * palette, but an imported file could carry anything, and the value goes into an SVG style
 * attribute — restrict it to a hex literal so it can't smuggle in extra style declarations.
 */
export function safeColor(c) {
    return (typeof c === "string" && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) ? c : OUTLINE_FALLBACK_COLOR;
}

/*
 * The "drawn ROIs" control-panel folder. Its visibility toggle is bound through a record keyed by
 * the host's overlay object rather than to one PycortexOverlay, so the folder is added once per
 * viewer: a re-attach rebinds it to the live overlay instead of adding a duplicate wired to a
 * destroyed one. `unbindDrawnFolder` detaches a destroyed overlay (the toggle then does nothing).
 */
const drawnFolders = new WeakMap();   // svgo -> { overlay, name }

export function bindDrawnFolder(svgo, overlay, name) {
    const bound = drawnFolders.get(svgo);
    if (bound) { bound.overlay = overlay; bound.name = name; return; }
    if (!svgo.ui) return;
    const b = { overlay, name };
    try {
        svgo.ui.addFolder(DRAWN_FOLDER, true).add({
            visible: { action: [{
                get f() { return !!b.overlay && !b.overlay.layerHidden; },
                set f(v) { if (b.overlay) b.overlay.setVisible(b.name, v, undefined); },
            }, "f"] },
        });
        drawnFolders.set(svgo, b);
    } catch (e) { console.warn("[roidraw] control-panel folder add failed:", e); }
}

/* Point an existing folder at `overlay`; a no-op when no drawer has added the folder yet. */
function rebindDrawnFolder(svgo, overlay, name) {
    if (drawnFolders.has(svgo)) bindDrawnFolder(svgo, overlay, name);
}

export function unbindDrawnFolder(svgo, overlay) {
    const b = svgo && drawnFolders.get(svgo);
    if (b && b.overlay === overlay) b.overlay = null;
}

// Stand-in for svgoverlay.Labels when building the real sprites fails (outlines still draw).
const labelsStub = () => ({ meshes: { left: { visible: false }, right: { visible: false } }, setMix() {}, showhide() {} });

export class PycortexOverlay {
    /* `adapter` is the PycortexAdapter this layer belongs to (surface, posdata, mix, vertex uv). */
    constructor(adapter, { thickmix }) {
        this._a = adapter;
        this._thickmix = thickmix;
        this._drawn = null;          // { name, layerEl, labels, entry } for the current layer
        this.layerHidden = false;
        this._labelsHidden = false;
    }

    _svgo() { return this._a.surface.svg; }

    /* The overlay's drawing dimensions. Paths live in the viewBox coordinate system, NOT the
     * (later-overwritten) width/height. Rendering and export must agree on this or the exported
     * markup would not line up with what the user drew. */
    _dims(svgo) {
        const vb = (svgo.svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(parseFloat);
        return {
            W: (vb.length === 4 && vb[2]) ? vb[2] : svgo.width,
            H: (vb.length === 4 && vb[3]) ? vb[3] : svgo.height,
        };
    }

    /* Replace the drawn layer with `shapes` under `name`. false while the overlay is still loading. */
    setLayer(name, shapes) {
        const svgo = this._svgo();
        if (!svgo || !svgo.svg || !svgo.posdata || !svgo.depth) return false; // overlay not loaded yet
        // A folder a previous drawer added is taken over now, not only once this one draws a shape,
        // so after a re-attach the toggle never sits bound to the destroyed overlay.
        rebindDrawnFolder(svgo, this, name);
        this._removeDrawnLayer(svgo);
        if (!shapes.length) { svgo.update(); return true; }

        const { layerEl, labelsEl } = this._buildLayerElement(svgo, name, shapes);
        svgo.svg.appendChild(layerEl);
        const labels = this._attachLabels(svgo, labelsEl);
        this._registerLayer(svgo, name, layerEl, labels);
        svgo.update(); // re-rasterize -> new surface texture (includes the outlines)
        return true;
    }

    // Tear down the current layer, its label sprites, and its registration (under the name it was
    // registered with, which need not be the name of the layer replacing it).
    _removeDrawnLayer(svgo) {
        const drawn = this._drawn;
        if (!drawn) return;
        try {
            if (drawn.labels) {
                svgo.labels.left.remove(drawn.labels.meshes.left);
                svgo.labels.right.remove(drawn.labels.meshes.right);
            }
            if (drawn.layerEl && drawn.layerEl.parentNode) drawn.layerEl.parentNode.removeChild(drawn.layerEl);
        } catch (e) {
            // Best effort: a partially-removed layer still gets replaced, so keep going — but say
            // so, since a leaked label sprite would otherwise be an invisible mystery.
            console.warn("[roidraw] tearing down the previous overlay layer failed:", e);
        }
        delete svgo.layers[drawn.name];
        delete svgo[drawn.name];
        this._drawn = null;
    }

    // <g.display_layer> > (shapes group with haloed outline paths) + (labels group with texts)
    _buildLayerElement(svgo, name, shapes) {
        const doc = svgo.svg.ownerDocument;
        const { W, H } = this._dims(svgo);
        const vertexUV = (o) => this._a.vertexUV(o);
        const layerEl = doc.createElementNS(SVGNS, "g");
        layerEl.setAttribute("id", name);
        layerEl.setAttribute("class", "display_layer");
        layerEl.setAttribute("style", "display:" + (this.layerHidden ? "none" : "inline"));
        const shapesEl = doc.createElementNS(SVGNS, "g");
        shapesEl.setAttribute("id", name + "_shapes");
        const labelsEl = doc.createElementNS(SVGNS, "g");
        labelsEl.setAttribute("id", name + "_labels");
        layerEl.appendChild(shapesEl);
        layerEl.appendChild(labelsEl);

        for (const shape of shapes) {
            const d = shapeSvgPath(shape, W, H, vertexUV);
            if (d) {
                const sulcus = shape.kind === "sulcus";
                const w = sulcus ? CURVE_STROKE_PX : OUTLINE_STROKE_PX;
                const op = sulcus ? CURVE_STROKE_OPACITY : 1;
                // White halo under a colored stroke: the halo keeps the outline legible on any
                // background (colored data or white anatomy), while the color carries the shape
                // identity the panel swatch shows. Same path `d`, drawn wider + white underneath.
                // The halo is a live-overlay rendering choice only; exported markup has none.
                const halo = doc.createElementNS(SVGNS, "path");
                halo.setAttribute("d", d);
                halo.setAttribute("style", "fill:none;stroke:#ffffff;stroke-width:" + (w + OUTLINE_HALO_PX) +
                    ";stroke-opacity:" + OUTLINE_HALO_OPACITY);
                shapesEl.appendChild(halo);
                const path = doc.createElementNS(SVGNS, "path");
                path.setAttribute("d", d);
                path.setAttribute("style", "fill:none;stroke:" + safeColor(shape.color) + ";stroke-width:" + w + ";stroke-opacity:" + op);
                shapesEl.appendChild(path);
            }
            const ptidx = this._labelPtidx(shape.labelVert);
            if (ptidx != null) {
                const t = doc.createElementNS(SVGNS, "text");
                t.setAttribute("data-ptidx", String(ptidx));
                t.setAttribute("style", LABEL_STYLE);
                t.appendChild(doc.createTextNode(shape.name)); // createTextNode => no injection
                labelsEl.appendChild(t);
            }
        }
        return { layerEl, labelsEl };
    }

    // Occlusion-aware label sprites, reusing pycortex's own Labels. Returns null (outlines still
    // drawn) if the sprites can't be built.
    _attachLabels(svgo, labelsEl) {
        try {
            const labels = new this._a.svgoverlay.Labels(labelsEl, svgo.posdata, !!this._labelsHidden);
            labels.shader.uniforms.depth.value = svgo.depth;
            const vp = this._a.viewportSize();
            const w = this._a.surface.width || vp.width || FALLBACK_TEX_W;
            const h = this._a.surface.height || vp.height || FALLBACK_TEX_H;
            labels.shader.uniforms.scale.value.set(1 / w, 1 / h);
            labels.setMix({ mix: this._a._currentMix(), thickmix: this._thickmix });
            svgo.labels.left.add(labels.meshes.left);
            svgo.labels.right.add(labels.meshes.right);
            return labels;
        } catch (e) {
            console.warn("[roidraw] ROI labels failed (outlines still drawn):", e);
            return null;
        }
    }

    // Register the layer the way pycortex's own layers are (svgo.layers[name] + svgo[name]), and
    // bind the control-panel folder. The layer's showhide goes through setVisible, so a toggle from
    // the host keeps our hidden state and the rasterized texture in step.
    _registerLayer(svgo, name, layerEl, labels) {
        const overlay = this;
        const entry = {
            name, layer: layerEl, labels: labels || labelsStub(),
            get _hidden() { return overlay.layerHidden; },   // pycortex layers carry _hidden
            showhide(state) {
                if (state === undefined) return !overlay.layerHidden;
                overlay.setVisible(name, state, undefined);
            },
        };
        svgo.layers[name] = svgo[name] = entry;
        this._drawn = { name, layerEl, labels, entry };
        bindDrawnFolder(svgo, this, name);
    }

    /*
     * The WebGL viewer's label convention: a flat vertex index, right-hemisphere indices offset by
     * the left hemisphere's vertex count. BROWSER-ONLY. `svgoverlay.js`'s Labels reads `data-ptidx`
     * off a <text> to place it; the Python side does the reverse (`SVGOverlay.set_coords` computes
     * `data-ptidx` from the label's x/y). So this value must never be written into exported markup
     * — see core/svg-export.js. It is used solely for the live, in-viewer overlay layer.
     */
    _labelPtidx(lv) {
        if (!lv) return null;
        return lv.h === "left" ? lv.g : this._a.vertexCount("left") + lv.g;
    }

    /*
     * Show/hide the drawn layer's outlines (`shapes`) and/or labels; undefined leaves one as is.
     * There is one drawn layer, so `name` only documents the caller's intent. Re-rasterizes only
     * when the outline state actually changes, so a host that calls showhide from its own update
     * can't loop through svgo.update().
     */
    setVisible(_name, shapes, labels) {
        if (shapes !== undefined && !shapes !== this.layerHidden) {
            this.layerHidden = !shapes;
            const drawn = this._drawn;
            if (drawn) {
                if (drawn.layerEl) drawn.layerEl.style.display = shapes ? "inline" : "none";
            }
            const svgo = this._svgo();
            if (svgo) svgo.update();
        }
        if (labels !== undefined) {
            this._labelsHidden = !labels;
            if (this._drawn && this._drawn.labels) this._drawn.labels.showhide(labels);
        }
    }

    /*
     * Serialize drawn sulci as a standalone SVG whose `sulci` layer drops straight into a
     * subject's overlays.svg. The `d` strings come from the SAME uv->viewBox mapping the live
     * overlay uses, which is pycortex's own overlay coordinate space.
     *
     * Returns null when the SVG overlay hasn't loaded (so we don't know the coordinate space),
     * and "" when it has loaded but no sulcus yielded a path. The caller must tell those apart:
     * they are different failures with different fixes.
     */
    exportSulciMarkup(sulci) {
        const svgo = this._svgo();
        if (!svgo || !svgo.svg) return null;
        const { W, H } = this._dims(svgo);
        return exportSulciSvg(sulci, {
            pathFor: (bez) => (bez ? bezierSvgPath(bez, W, H) : null),
            width: W, height: H,
        });
    }

    /* Detach from the control-panel folder. The layer itself is cleared by the controller. */
    destroy() { unbindDrawnFolder(this._svgo(), this); }
}
