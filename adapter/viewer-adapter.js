/*
 * viewer-adapter.js — the CONTRACT between the host viewer and the ROI-drawing code.
 *
 * This is the porting boundary: the pure `core/` and the `ui/` talk only to a ViewerAdapter,
 * never to a specific viewer's internals. To run ROI drawing on a different WebGL surface
 * viewer, implement this interface (see pycortex-adapter.js for the reference implementation).
 *
 * It is a documented interface. The class is a convenience base (both PycortexAdapter and the test
 * fake `extends` it, and `REQUIRED` below drives a conformance test), but any object with these
 * methods works — the required methods `throw` here so an incomplete adapter fails loudly.
 *
 * Coordinate conventions:
 *   - "screen px": CSS pixels relative to the surface canvas's top-left (what the lasso uses).
 *   - "vertex index" (g): the per-hemisphere vertex index as the host numbers its mesh. Selections
 *     and exports are in these indices. For pycortex this is the CTM file's order, which equals the
 *     subject's order only for a "raw" CTM: the default mg2 compression reorders vertices, and the
 *     map back is pycortex's cortex.utils.get_ctmmap. Exports port exactly to viewers built from the
 *     same CTM cache.
 *   - "uv": the vertex's flat-overlay texture coordinate in [0,1] (for SVG-overlay path coords).
 */
import { HEMIS } from "../core/hemis.js";

export class ViewerAdapter {
    /* --- surface identity ------------------------------------------------------------- */

    /** @returns {string} an id for the surface (e.g. "fsaverage"), stamped into exports. */
    surfaceId() { throw new Error("ViewerAdapter.surfaceId not implemented"); }

    /** @returns {boolean} whether the surface is fully flattened (ROI/sulcus drawing is flat-only). */
    isFlat() { throw new Error("ViewerAdapter.isFlat not implemented"); }

    /** @returns {{width:number, height:number}} the surface canvas size in CSS px. */
    viewportSize() { throw new Error("ViewerAdapter.viewportSize not implemented"); }

    /** @returns {HTMLCanvasElement} the surface's WebGL canvas (for positioning the overlay). */
    canvas() { throw new Error("ViewerAdapter.canvas not implemented"); }

    /* --- projection (host-specific: morph + camera) ----------------------------------- */

    /**
     * Project the surface's vertices to screen px at the CURRENT view, dropping anything
     * behind the camera. Used for lasso selection (the host's own view framing is internal).
     * @param {{subsample?:number}} [opts] keep ~1 of every `subsample` vertices (a stride; selection passes 1).
     * @returns {{left:{idx:number[], px:[number,number][]}, right:{...}}}  in-frustum verts.
     */
    projectVertices(_opts) { throw new Error("ViewerAdapter.projectVertices not implemented"); }

    /**
     * Every vertex's subject index + flat-UV, per hemi. View-INDEPENDENT (no camera): the basis
     * for uv-space ROI membership, so a reloaded bezier selects the same vertices at any view.
     * @returns {{left:{idx:number[], uv:[number,number][]}, right:{...}}}
     */
    allVertexUV() { throw new Error("ViewerAdapter.allVertexUV not implemented"); }

    /** @returns {[number,number]|null} flat-UV ([0,1]) of one subject vertex {h,g}, or null. */
    vertexUV(_o) { throw new Error("ViewerAdapter.vertexUV not implemented"); }

    /**
     * Project ONLY the vertices whose flat-UV falls within `bounds`, reporting each one's uv AND
     * current-view px. The bezier edit overlay fits a LOCAL uv<->px homography from these (one
     * global homography drifts where the flatmap isn't perfectly planar; locally it's near-exact).
     * @param {{minu:number,maxu:number,minv:number,maxv:number}} bounds
     * @returns {{left:{uv:[number,number][], px:[number,number][]}, right:{...}}}
     */
    projectVerticesInUvBounds(_bounds) { throw new Error("ViewerAdapter.projectVerticesInUvBounds not implemented"); }

    /* --- overlay layer (the occlusion-correct ROI rendering) -------------------------- */

    /**
     * Create/replace a named overlay layer rendered INTO the surface (so it occludes and morphs
     * like built-in ROIs). `shapes` carries, per shape, its `kind` ("roi" | "sulcus" — points are
     * never passed here; they are markers, see setPointMarkers), a label
     * vertex, a display color, and an editable flat-UV `bezier` the adapter renders as a cubic
     * path — closed for an ROI, open (no `Z`) for a sulcus. ROIs may also carry a boundary ring
     * (`outline`) used as a fallback for files predating the bezier.
     * @param {string} name
     * @param {Array<{kind, name, color?, outline?:[{h,g}], labelVert:{h,g}, bezier?}>} shapes
     * @returns {boolean} false if the host's overlay machinery isn't ready yet (the caller retries);
     *   true once the layer is in place. Never silently drop shapes — they'd be listed but undrawn.
     */
    setOverlayLayer(_name, _shapes) { throw new Error("ViewerAdapter.setOverlayLayer not implemented"); }

    /**
     * Show/hide the outlines (`shapes`) and/or labels of the layer; undefined leaves one as is.
     * The controller draws a single layer, and an adapter may keep just one: PycortexAdapter
     * replaces its one drawn layer on every setOverlayLayer and ignores `name` here.
     */
    setLayerVisible(_name, _shapes, _labels) { throw new Error("ViewerAdapter.setLayerVisible not implemented"); }

    /* --- camera / transitions --------------------------------------------------------- */

    /** Smoothly flatten the surface (mix -> 1). */
    flatten() { throw new Error("ViewerAdapter.flatten not implemented"); }

    /** Aim the camera at a world point [x,y,z] (keeps the center of mass framed). */
    setCameraTarget(_xyz) { throw new Error("ViewerAdapter.setCameraTarget not implemented"); }

    /** Set the camera orbit radius (zoom). */
    setCameraRadius(_r) { throw new Error("ViewerAdapter.setCameraRadius not implemented"); }

    /** @returns {number} current camera orbit radius. */
    cameraRadius() { throw new Error("ViewerAdapter.cameraRadius not implemented"); }

    /** Request a render (viewers render on demand). */
    requestRender() { throw new Error("ViewerAdapter.requestRender not implemented"); }

    /* --- events ----------------------------------------------------------------------- */

    /** Subscribe to surface morph changes; cb() runs on every mix frame. @returns {function} unsubscribe */
    onMixChange(_cb) { throw new Error("ViewerAdapter.onMixChange not implemented"); }

    /* --- optional niceties (sensible defaults; override if the host supports them) ----- */

    /** @returns {boolean} whether the surface has a flatmap (ROI/sulcus drawing needs one). */
    hasFlat() { return true; }

    /** @returns {boolean} whether pickVertex can answer yet (false while the host is still loading). */
    canPick() { return false; }

    /**
     * The vertex under canvas px (x, y), at the CURRENT view and unfold mix — for placing a point.
     * @returns {{h:string, g:number, xyz:[number,number,number]|null}|null} null over background
     *   or when the host can't pick. `g` is a vertex index (see the coordinate conventions); `xyz`
     *   is the vertex's base (anatomical) surface position.
     */
    pickVertex(_x, _y) { return null; }

    /** @returns {[number,number,number]|null} base-surface position of vertex {h,g}, or null if this
     *   mesh has no such vertex. Lets an import check a point file against THIS viewer's mesh. */
    vertexPosition(_o) { return null; }

    /**
     * Render one marker per point ([{vert:{h,g}, color}]), replacing the previous set. Markers
     * follow the surface morph. @returns {false|number} false while the host isn't ready (caller
     * retries); otherwise how many points could NOT be drawn (their vertex isn't in this mesh), so
     * the caller can say so rather than list points that never appear.
     */
    setPointMarkers(_points) { return 0; }

    /** Forward a click to the host's own picker (Shift-inspect while drawing). */
    inspectAt(_x, _y) {}

    /** Zoom the surface by a mouse-wheel delta (lets the user draw fine detail). */
    zoom(_deltaY) {}

    /** Pan the surface by a screen-pixel drag delta (reposition while drawing). */
    pan(_dx, _dy) {}

    /** @returns {DOMRect|null} the host control panel's screen rect, for placing UI beside it. */
    controlPanelRect() { return null; }

    /** Collapse the host's own control panel; `closeRoot` also closes its top level. */
    collapseControlPanel(_closeRoot = true) {}

    /** Show/hide the host's control panel when switching Display/Draw modes. */
    setControlPanelVisible(_visible) {}

    /** Apply host-specific startup defaults (e.g. hide built-in layers). Called once on attach. */
    applyHostDefaults() {}

    /**
     * Where the whole surface sits in view: its center of mass (world) and the camera radius at
     * which it fills the viewport. The controller frames the view with it.
     * @returns {{com:[number,number,number], radius:number}|null} null when it can't be measured.
     */
    measureFrame() { return null; }

    /**
     * Move the camera (and optionally the unfold mix) to a new state, smoothly if the host can.
     * This default snaps target and radius and ignores `mix` (use flatten() to reach flat).
     * @param {{target?:[number,number,number], radius?:number, mix?:number}} state
     */
    animateCamera({ target, radius } = {}) {
        if (target) this.setCameraTarget(target);
        if (radius != null) this.setCameraRadius(radius);
        this.requestRender();
    }

    /**
     * Drawn sulci as SVG markup in the host's overlay coordinate space, for "Export sulci".
     * @returns {string|null} null when the host can't name that coordinate space (not loaded, or
     *   not supported); "" when it can but no sulcus yielded a path.
     */
    exportSulciMarkup(_sulci) { return null; }

    /** Release any host listeners/timers the adapter installed. Called by ROIDrawer.destroy(). */
    destroy() {}
}

// The methods an implementation MUST provide (every one above that throws). The "optional niceties"
// — hasFlat/canPick/pickVertex/vertexPosition/setPointMarkers/inspectAt/zoom/pan/controlPanelRect/collapseControlPanel/setControlPanelVisible/
// applyHostDefaults/measureFrame/animateCamera/exportSulciMarkup/destroy — have working defaults.
// Declared explicitly (not inferred from the source text) so the conformance test has a stable
// contract to check against. Keep in sync when adding a required method.
ViewerAdapter.REQUIRED = [
    "surfaceId", "isFlat", "viewportSize", "canvas",
    "projectVertices", "allVertexUV", "vertexUV", "projectVerticesInUvBounds",
    "setOverlayLayer", "setLayerVisible", "flatten",
    "setCameraTarget", "setCameraRadius", "cameraRadius", "requestRender", "onMixChange",
];

/* Everything: the bounds that select the whole flatmap for projectVerticesInUvBounds. */
export const ALL_UV_BOUNDS = Object.freeze({ minu: -Infinity, maxu: Infinity, minv: -Infinity, maxv: Infinity });

/*
 * uv->px correspondences for a homography fit, from the adapter's projectVerticesInUvBounds
 * flattened across both hemispheres into parallel `src` (uv) / `dst` (px) arrays. The edit overlay
 * (LOCAL bounds around the shape) and the sulcus trace pipeline (the whole flatmap) both fit the
 * same kind of transform from the same kind of data — this is the one place that data is shaped.
 * `bounds` defaults to the whole flatmap.
 */
export function uvPxCorrespondences(adapter, bounds = ALL_UV_BOUNDS) {
    const proj = adapter.projectVerticesInUvBounds(bounds);
    const src = [], dst = [];
    for (const h of HEMIS) {
        const p = proj[h];
        if (!p) continue;
        for (let i = 0; i < p.uv.length; i++) { src.push(p.uv[i]); dst.push(p.px[i]); }
    }
    return { src, dst };
}
