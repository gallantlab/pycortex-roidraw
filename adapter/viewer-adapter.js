/*
 * viewer-adapter.js — the CONTRACT between the host viewer and the ROI-drawing code.
 *
 * This is the porting boundary: the pure `core/` and the `ui/` talk only to a ViewerAdapter,
 * never to a specific viewer's internals. To run ROI drawing on a different WebGL surface
 * viewer, implement this interface (see pycortex-adapter.js for the reference implementation).
 *
 * It is a documented duck-typed interface, not a base class — implementers provide their own
 * object with these methods. The methods below `throw` so an incomplete adapter fails loudly.
 *
 * Coordinate conventions:
 *   - "screen px": CSS pixels relative to the surface canvas's top-left (what the lasso uses).
 *   - "subject index" (g): the surface's canonical per-hemisphere vertex index. Selections and
 *     exports are in subject indices so they port across viewers on the same surface.
 *   - "uv": the vertex's flat-overlay texture coordinate in [0,1] (for SVG-overlay path coords).
 */

export class ViewerAdapter {
    /* --- surface identity ------------------------------------------------------------- */

    /** @returns {string} an id for the surface (e.g. "fsaverage"), stamped into exports. */
    surfaceId() { throw new Error("ViewerAdapter.surfaceId not implemented"); }

    /** @returns {boolean} whether the surface is fully flattened (drawing is flat-only). */
    isFlat() { throw new Error("ViewerAdapter.isFlat not implemented"); }

    /** @returns {{width:number, height:number}} the surface canvas size in CSS px. */
    viewportSize() { throw new Error("ViewerAdapter.viewportSize not implemented"); }

    /** @returns {HTMLCanvasElement} the surface's WebGL canvas (for positioning the overlay). */
    canvas() { throw new Error("ViewerAdapter.canvas not implemented"); }

    /* --- projection (host-specific: morph + camera) ----------------------------------- */

    /**
     * Project the surface's vertices to screen px at the CURRENT view, dropping anything
     * behind the camera. Used for selection and view-framing.
     * @param {{subsample?:number}} [opts] keep ~1 of every `subsample` vertices (framing only).
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
     * like built-in ROIs). `rois` carries, per ROI, the boundary ring + label vertex (and, when
     * present, an editable flat-UV `bezier` the adapter renders as a smooth cubic path); the
     * adapter converts vertices/bezier→uv→layer geometry.
     * @param {string} name
     * @param {Array<{name, outline:[{h,g}], labelVert:{h,g}, bezier?}>} rois
     */
    setOverlayLayer(_name, _rois) { throw new Error("ViewerAdapter.setOverlayLayer not implemented"); }

    /** Show/hide the outlines and labels of a previously-created layer. */
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

    /** Forward a click to the host's own picker (Shift-inspect while drawing). */
    inspectAt(_x, _y) {}

    /** Zoom the surface by a mouse-wheel delta (lets the user draw fine detail). */
    zoom(_deltaY) {}

    /** Pan the surface by a screen-pixel drag delta (reposition while drawing). */
    pan(_dx, _dy) {}

    /** @returns {DOMRect|null} the host control panel's screen rect, for placing UI beside it. */
    controlPanelRect() { return null; }

    /** Collapse the host's own control panel on startup. */
    collapseControlPanel() {}

    /** Show/hide the host's control panel when switching Display/Draw modes. */
    setControlPanelVisible(_visible) {}
}
