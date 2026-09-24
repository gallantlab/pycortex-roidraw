/*
 * pycortex-adapter.js — ViewerAdapter implementation for the pycortex WebGL viewer.
 *
 * This file and pycortex-overlay.js (the drawn layer inside the SVG overlay, which this adapter
 * owns and delegates to) are the only code that knows pycortex internals. Every pycortex-specific
 * gotcha lives behind the ViewerAdapter contract:
 *   - mriview.get_position() morph + the flatoff[1] mesh y-offset (vertices render at
 *     pivot.matrixWorld * (get_position + [0,-flatoff[1],0]); omitting it floats overlays off
 *     the inflated surface).
 *   - full pivot-chain updateMatrixWorld(true) (setMix drives ancestor transforms; updating only
 *     pivots.back reads a stale parent).
 *   - svgo.update() rasterizes asynchronously; the surface fires "update" when the texture is
 *     swapped in (repaint then), and surfmix === the mix slider value.
 *   - dat.GUI control panel (gui.__folders) + LandscapeControls (setTarget/setRadius) + viewer.animate.
 * The overlay-layer conventions (viewBox coords, data-ptidx labels) are listed in pycortex-overlay.js.
 */
import { ViewerAdapter } from "./viewer-adapter.js";
import { PycortexOverlay } from "./pycortex-overlay.js";
import { ndcToPixel } from "../core/geom.js";
import { HEMIS } from "../core/hemis.js";
import { TimerSet } from "../core/timer-set.js";

// Tunable pycortex-specific constants (kept here, in the host adapter, where they belong).
const FLAT_THRESHOLD = 0.999;     // surfmix at/above this counts as "fully flat" (drawing-enabled)
const DEFAULT_FILL = 0.70;        // measureFrame: fraction of the viewport the brain should fill
const FRAME_TARGET_SAMPLES = 250; // measureFrame: ~vertices/hemi to KEEP for COM + extent (a target count, NOT a stride — contrast projectVertices' `subsample`)
const MIN_MEASURABLE_FILL = 0.01; // measureFrame: below this on-screen extent, keep the current radius
const ZOOM_SENSITIVITY = 0.001;   // wheel deltaY -> radius factor exp(deltaY * this)
const DEFAULT_FOV_DEG = 35;       // fallback if the camera has no .fov
const DEFAULT_ANIM_SPEED = 0.6;   // transition duration (s) when viewopts.anim_speed is unset
// The host's SVG overlay loads asynchronously after the viewer: anything that needs it (the
// built-in layer defaults here, the controller's layer sync) retries on this one schedule.
const OVERLAY_RETRY_TRIES = 40;
const OVERLAY_RETRY_MS = 250;
const COLLAPSE_SCHEDULE_MS = [400, 1200, 2500, 4500]; // re-collapse the late "data layers" folder
const COLLAPSE_WINDOW_MS = 8000;  // ...and on setData within this startup window only
const DEFAULT_THICKMIX = 0.5;     // thick-surface blend fed to get_position (constant; we don't expose it)

// Vertex count of a THREE BufferAttribute (pycortex's old three.js lacks `.count`).
function attrCount(attr) {
    if (attr.count !== undefined && !isNaN(attr.count)) return attr.count;
    return attr.array.length / attr.itemSize;
}

// Whether `root` is an ancestor of `obj` in the THREE scene graph.
function isDescendant(obj, root) {
    for (let o = obj && obj.parent; o; o = o.parent) if (o === root) return true;
    return false;
}

// viewer.surfs[i] is a SurfDelegate; the real Surface (pivots/picker/hemis/svg) is at .surf.
export function findSurface(viewer) {
    const surfs = viewer && viewer.surfs;
    if (!surfs || !surfs.length) return null;
    for (let i = 0; i < surfs.length; i++) {
        const s = surfs[i];
        if (!s) continue;
        if (s.surf && s.surf.pivots) return s.surf;
        if (s.pivots) return s;
    }
    return null;
}

/*
 * What a located Surface still lacks for the adapter to work: [] once its pivots and both hemis'
 * position + uv geometry are built. Projection + selection iterate BOTH hemis and read each one's
 * position AND uv geometry, so every one is checked here instead of failing silently later.
 * Shared by preflightHost (the attach-time error) and surfaceReady (autoAttach's poll), so the
 * poll never attaches to a surface the constructor would then reject.
 */
export function surfaceProblems(surface) {
    const missing = [];
    if (!surface.pivots) missing.push("surface.pivots (morph transform chain)");
    const h = surface.hemis || {};
    for (const side of HEMIS) {
        const hemi = h[side];
        if (!hemi || !hemi.attributes) { missing.push(`surface.hemis.${side} (hemisphere geometry)`); continue; }
        if (!hemi.attributes.position) missing.push(`surface.hemis.${side}.attributes.position (vertex geometry)`);
        if (!hemi.attributes.uv) missing.push(`surface.hemis.${side}.attributes.uv (flat-UV coords)`);
    }
    return missing;
}

/*
 * Inspect the host for the core pycortex internals the adapter depends on. Returns { ok, missing:[…] }
 * naming each absent capability, so attach() can fail LOUDLY and specifically when pycortex drifts
 * (a renamed get_position, a restructured surface) instead of misbehaving silently. Pure — takes
 * the host pieces explicitly so it is unit-testable without globals or a browser.
 */
export function preflightHost({ THREE, mriview, svgoverlay, viewer } = {}) {
    const missing = [];
    if (!THREE) missing.push("THREE (global three.js)");
    if (!mriview) missing.push("mriview (global)");
    else if (typeof mriview.get_position !== "function") missing.push("mriview.get_position() (vertex morph)");
    const surface = findSurface(viewer);
    if (!surface) missing.push("Surface (viewer.surfs[].surf with .pivots)");
    else missing.push(...surfaceProblems(surface));
    if (!svgoverlay) missing.push("svgoverlay (global, ROI overlay rendering)");
    return { ok: missing.length === 0, missing };
}

// True once the surface's geometry + pivots are built (the same checks the constructor makes).
// The viewer creates `viewer` and decodes the CTM asynchronously, so callers poll this first.
export function surfaceReady(viewer) {
    const s = findSurface(viewer);
    return !!s && surfaceProblems(s).length === 0;
}

export class PycortexAdapter extends ViewerAdapter {
    constructor(viewer, { animSpeedFallback = DEFAULT_ANIM_SPEED } = {}) {
        super();
        this.THREE = globalThis.THREE;
        this.mriview = globalThis.mriview;
        this.svgoverlay = globalThis.svgoverlay;
        this.viewer = viewer;

        // Fail loudly + specifically if the host isn't the pycortex viewer we expect (see preflightHost).
        const pf = preflightHost({ THREE: this.THREE, mriview: this.mriview, svgoverlay: this.svgoverlay, viewer });
        if (!pf.ok) throw new Error("[roidraw] incompatible pycortex viewer — missing: " + pf.missing.join("; "));

        this.surface = findSurface(viewer);
        this.posdata = (this.surface.picker && this.surface.picker.posdata) || this._buildPosdata();

        this._animSpeedFallback = animSpeedFallback;
        this._v = new this.THREE.Vector3();
        this._mixWarned = false;
        this._overlay = new PycortexOverlay(this, { thickmix: DEFAULT_THICKMIX });
        this._timers = new TimerSet();   // every poll/deferred teardown; destroy() cancels them
        this._onSetData = null;          // host listener installed by applyHostDefaults()
    }

    // --- surface identity -------------------------------------------------------------

    surfaceId() {
        const a = this.viewer.active;
        const d = a && a.data && a.data[0];
        return (d && d.subject) || "unknown";
    }

    isFlat() { return this._currentMix() >= FLAT_THRESHOLD; }

    viewportSize() {
        const r = this.canvas().getBoundingClientRect();
        return { width: r.width, height: r.height };
    }

    canvas() {
        const c = this.viewer.canvas;
        if (c && c[0]) return c[0];
        if (c instanceof HTMLCanvasElement) return c;
        return this.viewer.renderer && this.viewer.renderer.domElement;
    }

    /* Geometry-local vertex count of one hemisphere (not part of the contract). */
    vertexCount(h) { return attrCount(this.posdata[h].positions[0]); }

    // --- projection -------------------------------------------------------------------

    // Live unfold mix straight from the viewer (surfmix === slider value); don't trust caches.
    _currentMix() {
        try {
            if (typeof this.viewer.setMix === "function") {
                const m = this.viewer.setMix();
                if (typeof m === "number") return m;
            }
        } catch (e) {
            // hot path (every mix frame) — warn once so a real break is visible without spamming.
            if (!this._mixWarned) { this._mixWarned = true; console.warn("[roidraw] reading surfmix failed; treating as not-flat:", e); }
        }
        return 0;
    }

    _flatOffY() { return (this.surface.flatoff && this.surface.flatoff[1]) || 0; }

    // Refresh the WHOLE pivot chain so each pivots[h].back.matrixWorld reflects the current mix,
    // then return the projection context {cam, surfmix, foy, W, H}. setMix drives ancestor
    // transforms (pivots.front via setPivot, back.rotation.x), so updating only `back` would read
    // a stale parent. A forced update of viewer.root reaches every pivot beneath it; a pivot that
    // is not under root (or a viewer without one) is updated on its own.
    _prepProjection() {
        const cam = this.viewer.camera;
        cam.updateMatrixWorld();
        const root = this.viewer.root;
        const rootUpdated = !!(root && root.updateMatrixWorld);
        if (rootUpdated) root.updateMatrixWorld(true);
        for (const h of HEMIS) {
            const pivot = this.surface.pivots[h].back;
            if (!rootUpdated || !isDescendant(pivot, root)) pivot.updateMatrixWorld(true);
        }
        const r = this.canvas().getBoundingClientRect();
        return { cam, surfmix: this._currentMix(), foy: this._flatOffY(), W: r.width, H: r.height };
    }

    // One hemisphere's projection inputs: posdata, pivot world matrix, vertex count, flat-UV array.
    _hemiFrame(h) {
        const pd = this.posdata[h];
        return {
            pd, mw: this.surface.pivots[h].back.matrixWorld, n: attrCount(pd.positions[0]),
            uv: this.surface.hemis[h].attributes.uv.array,
        };
    }

    // World position of geometry-local vertex `i` at the current mix (incl. the flatoff offset
    // so it lands on the *rendered* mesh, not floating above it). Mutates+returns this._v.
    // Applies the flatoff offset to our OWN vector (never to get_position's returned `pos`, which
    // may be a shared/cached vector inside mriview — mutating it would corrupt host state).
    _worldOf(frame, i, ctx) {
        const gp = this.mriview.get_position(frame.pd, ctx.surfmix, DEFAULT_THICKMIX, i).pos;
        this._v.copy(gp);
        this._v.y -= ctx.foy;
        return this._v.applyMatrix4(frame.mw);
    }

    // Project a world vector (in place) to screen px, or null when it is behind the camera /
    // outside the frustum.
    _toScreen(world, ctx) {
        const p = world.project(ctx.cam);
        return (p.z < -1 || p.z > 1) ? null : ndcToPixel(p, ctx.W, ctx.H);
    }

    projectVertices({ subsample = 1 } = {}) {
        const ctx = this._prepProjection();
        const out = { left: { idx: [], px: [] }, right: { idx: [], px: [] } };
        const step = Math.max(1, subsample | 0);
        for (const h of HEMIS) {
            const f = this._hemiFrame(h);
            const revIdx = this.surface.hemis[h].reverseIndexMap; // geometry-local -> subject
            for (let i = 0; i < f.n; i += step) {
                const px = this._toScreen(this._worldOf(f, i, ctx), ctx);
                if (!px) continue;
                out[h].idx.push(revIdx[i]);
                out[h].px.push(px);
            }
        }
        return out;
    }

    // All vertices' subject index + flat-UV, per hemi. View-INDEPENDENT (no camera), so it's the
    // basis for uv-space ROI membership: a reloaded bezier selects the same vertices regardless of
    // the current pan/zoom/mix. uv is the same shared [0,1]^2 the SVG overlay uses.
    allVertexUV() {
        const out = { left: { idx: [], uv: [] }, right: { idx: [], uv: [] } };
        for (const h of HEMIS) {
            const f = this._hemiFrame(h);
            const revIdx = this.surface.hemis[h].reverseIndexMap;
            for (let i = 0; i < f.n; i++) {
                out[h].idx.push(revIdx[i]);
                out[h].uv.push([f.uv[i * 2], f.uv[i * 2 + 1]]);
            }
        }
        return out;
    }

    // Flat-UV of one subject vertex {h,g}, or null if it has no flat coords (or names no hemi).
    vertexUV(o) {
        const hemi = this.surface.hemis[o.h];
        if (!hemi) return null;
        const gi = hemi.indexMap[o.g]; // subject -> geometry-local
        if (gi === undefined) return null;
        const uv = hemi.attributes.uv.array;
        return [uv[gi * 2], uv[gi * 2 + 1]];
    }

    // Project ONLY the vertices whose flat-UV is within `b` ({minu,maxu,minv,maxv}). Cheap (scans
    // uv with no projection, projects just the in-bounds few) and dense. The edit overlay fits its
    // uv->px homography from these LOCAL correspondences: the flatmap isn't perfectly planar, so a
    // single global homography drifts, but locally (around one ROI) it's near-exact — which is what
    // makes the editable curve trace the baked white outline instead of sitting slightly inside it.
    projectVerticesInUvBounds(b) {
        const ctx = this._prepProjection();
        const out = { left: { uv: [], px: [] }, right: { uv: [], px: [] } };
        for (const h of HEMIS) {
            const f = this._hemiFrame(h);
            for (let i = 0; i < f.n; i++) {
                const u = f.uv[i * 2], v = f.uv[i * 2 + 1];
                if (u < b.minu || u > b.maxu || v < b.minv || v > b.maxv) continue;
                const px = this._toScreen(this._worldOf(f, i, ctx), ctx);
                if (!px) continue;
                out[h].uv.push([u, v]);
                out[h].px.push(px);
            }
        }
        return out;
    }

    // --- view framing primitive -------------------------------------------------------

    // Center of mass (world, over every sampled vertex) + the camera radius that fills
    // `fillTarget` of the viewport (from the in-frustum samples' on-screen extent). fill is the
    // on-screen NDC extent (canvas-size independent); on-screen size ∝ 1/radius.
    measureFrame(fillTarget = DEFAULT_FILL, targetSamples = FRAME_TARGET_SAMPLES) {
        const ctrl = this.viewer.controls;
        if (!ctrl || typeof ctrl.radius !== "number") return null;
        const ctx = this._prepProjection();
        let sx = 0, sy = 0, sz = 0, count = 0;
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (const h of HEMIS) {
            const f = this._hemiFrame(h);
            const step = Math.max(1, Math.floor(f.n / targetSamples));   // targetSamples = COUNT to keep, not a stride
            for (let i = 0; i < f.n; i += step) {
                const w = this._worldOf(f, i, ctx);
                sx += w.x; sy += w.y; sz += w.z; count++;
                const px = this._toScreen(w, ctx);   // projects w in place; its world coords are already summed
                if (!px) continue;
                if (px[0] < minx) minx = px[0];
                if (px[0] > maxx) maxx = px[0];
                if (px[1] < miny) miny = px[1];
                if (px[1] > maxy) maxy = px[1];
            }
        }
        if (!count) return null;
        const out = { com: [sx / count, sy / count, sz / count], radius: ctrl.radius };
        if (minx <= maxx && ctx.W > 0 && ctx.H > 0) {
            const fill = Math.max((maxx - minx) / ctx.W, (maxy - miny) / ctx.H);
            if (fill > MIN_MEASURABLE_FILL) out.radius = ctrl.radius * (fill / fillTarget);
        }
        return out;
    }

    // --- camera / transitions ---------------------------------------------------------

    _animSpeed() {
        const v = globalThis.viewopts && parseFloat(globalThis.viewopts.anim_speed);
        return (v && isFinite(v)) ? v : this._animSpeedFallback;
    }

    setCameraTarget(xyz) { const c = this.viewer.controls; if (c && c.setTarget) c.setTarget(xyz); }
    setCameraRadius(r) { const c = this.viewer.controls; if (c && c.setRadius) c.setRadius(r); }
    cameraRadius() { const c = this.viewer.controls; return c ? c.radius : 0; }
    requestRender() { if (typeof this.viewer.schedule === "function") this.viewer.schedule(); }

    // Forward a click to the viewer's own voxel picker (Shift-inspect while drawing). Dispatching
    // the controls' "pick" event is the exact native click path, minus the mouse state machine.
    inspectAt(x, y) {
        const ctrl = this.viewer.controls;
        if (ctrl && ctrl.dispatchEvent) ctrl.dispatchEvent({ type: "pick", x, y, keep: false });
    }

    // Screen rect of the host control panel, so the UI can sit beside it. null if unavailable.
    controlPanelRect() {
        const el = this.viewer.gui && this.viewer.gui.domElement;
        return el ? el.getBoundingClientRect() : null;
    }

    // Zoom by a mouse-wheel delta (toward the user => zoom out). Adjusts the orbit radius directly,
    // bypassing the controls' mouse-state machine.
    zoom(deltaY) {
        const c = this.viewer.controls;
        if (!c || typeof c.radius !== "number") return;
        const r = c.radius * Math.exp(deltaY * ZOOM_SENSITIVITY);
        if (typeof c.setRadius === "function") c.setRadius(r); else c.radius = r;
        this.requestRender();
    }

    // Pan by a screen-pixel drag delta. This controls version has no setpan, and it rebuilds
    // controls.target every frame from _flat/_foldedtarget — so we move the orbit point through
    // setTarget (which updates those persistent targets; the same lever framing uses). We shift
    // the target along the camera's screen axes, scaled by world-units-per-pixel at the current
    // zoom (so panning is ~1:1 with the cursor); the surface follows the cursor ("grab").
    pan(dx, dy) {
        const c = this.viewer.controls, cam = this.viewer.camera, THREE = this.THREE;
        if (!c || typeof c.setTarget !== "function" || typeof c.radius !== "number" || !cam) return;
        const cur = c.setTarget();              // getter -> [x,y,z]
        if (!Array.isArray(cur)) return;
        cam.updateMatrixWorld();
        const e = cam.matrixWorld.elements;     // column-major; col0 = right, col1 = up (world)
        const right = new THREE.Vector3(e[0], e[1], e[2]).normalize();
        const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
        const vh = this.viewportSize().height || 1;
        const worldPerPx = 2 * c.radius * Math.tan((((cam.fov) || DEFAULT_FOV_DEG) * Math.PI / 180) / 2) / vh;
        right.multiplyScalar(-dx * worldPerPx);
        up.multiplyScalar(dy * worldPerPx);
        c.setTarget([cur[0] + right.x + up.x, cur[1] + right.y + up.y, cur[2] + right.z + up.z]);
        this.requestRender();
    }

    // Smooth state transition using the viewer's own animation (same as its toolbar buttons).
    animateCamera({ target, radius, mix }) {
        const sp = this._animSpeed(), anim = [];
        if (target) anim.push({ state: "camera.target", idx: sp, value: [target[0], target[1], target[2]] });
        if (radius != null) anim.push({ state: "camera.radius", idx: sp, value: radius });
        if (mix != null) anim.push({ state: "mix", idx: sp, value: mix });
        if (!anim.length) return;
        try { this.viewer.animate(anim); }
        catch (e) {                                   // fallback: snap straight to the target
            console.warn("[roidraw] viewer.animate failed; snapping instead:", e);
            if (target) this.setCameraTarget(target);
            if (radius != null) this.setCameraRadius(radius);
            if (mix != null && typeof this.viewer.setMix === "function") this.viewer.setMix(mix);
            this.requestRender();
        }
    }

    flatten() { this.animateCamera({ mix: 1 }); }

    // --- events -----------------------------------------------------------------------

    onMixChange(cb) {
        const surf = this.surface;
        const handler = () => cb();
        surf.addEventListener("mix", handler);
        // svgo.update() repaints asynchronously; the surface fires "update" when the texture is
        // swapped in — repaint then, or a freshly drawn ROI won't appear until the next event.
        const repaint = () => this.requestRender();
        surf.addEventListener("update", repaint);
        return () => { surf.removeEventListener("mix", handler); surf.removeEventListener("update", repaint); };
    }

    // --- overlay layer (occlusion-correct ROI rendering; see pycortex-overlay.js) --------

    setOverlayLayer(name, shapes) { return this._overlay.setLayer(name, shapes); }

    setLayerVisible(name, shapes, labels) { this._overlay.setVisible(name, shapes, labels); }

    exportSulciMarkup(sulci) { return this._overlay.exportSulciMarkup(sulci); }

    // --- host control panel + defaults ------------------------------------------------

    collapseControlPanel(closeRoot = true) {
        const close = (gui, includeSelf) => {
            if (!gui) return;
            const folders = gui.__folders || {};
            for (const k in folders) close(folders[k], true);
            if (includeSelf) { try { gui.close(); } catch (e) { /* a folder without .close(); skip it */ } }
        };
        close(this.viewer.gui, closeRoot);
    }

    setControlPanelVisible(visible) {
        const el = this.viewer.gui && this.viewer.gui.domElement;
        if (el) el.style.display = visible ? "" : "none";
    }

    // pycortex startup niceties: hide the built-in ROI layer (keep sulci), and re-collapse the
    // late "data layers" folder. Every timer and listener started here is tracked so destroy() can
    // undo it: autoAttach destroys a prior drawer before attaching a new one, and an orphaned retry
    // chain would keep poking a dead viewer for seconds afterwards.
    applyHostDefaults() {
        this._timers.poll(() => {
            const svg = this.surface.svg;
            if (!svg || !svg.layers || !(svg.rois || svg.sulci)) return false;
            if (svg.rois) { svg.rois.showhide(false); if (svg.rois.labels) svg.rois.labels.showhide(false); }
            if (svg.sulci) svg.sulci.showhide(true);
            this.requestRender();
            return true;
        }, { tries: OVERLAY_RETRY_TRIES, ms: OVERLAY_RETRY_MS });
        // the datasets folder is built open after data loads (post-attach); re-collapse a few times,
        // and on every setData within the startup window (the listener is removed when it closes).
        COLLAPSE_SCHEDULE_MS.forEach((ms) => this._timers.later(() => this.collapseControlPanel(false), ms));
        if (this.viewer.addEventListener) {
            this._onSetData = () => this.collapseControlPanel(false);
            this.viewer.addEventListener("setData", this._onSetData);
            this._timers.later(() => this._removeSetDataListener(), COLLAPSE_WINDOW_MS);
        }
    }

    _removeSetDataListener() {
        if (this._onSetData && this.viewer.removeEventListener)
            this.viewer.removeEventListener("setData", this._onSetData);
        this._onSetData = null;
    }

    // Release everything applyHostDefaults() started and unbind the control-panel folder. The
    // overlay layer itself is left in place: the controller clears it (setOverlayLayer(name, []))
    // before it tears the adapter down. Safe to call more than once.
    destroy() {
        this._timers.clear();
        this._removeSetDataListener();
        this._overlay.destroy();
    }

    // Rebuild posdata from hemi attributes if the picker's isn't available (mirrors pycortex).
    _buildPosdata() {
        const pd = {};
        for (const h of HEMIS) {
            const a = this.surface.hemis[h].attributes;
            const positions = [a.position], normals = [a.normal];
            let i = 0;
            while (a["mixSurfs" + i]) { positions.push(a["mixSurfs" + i]); normals.push(a["mixNorms" + i]); i++; }
            pd[h] = { positions, normals, map: this.surface.hemis[h].indexMap };
            if (a.wm) { pd[h].wm = a.wm; pd[h].wmnorm = a.wmnorm; }
        }
        return pd;
    }
}
