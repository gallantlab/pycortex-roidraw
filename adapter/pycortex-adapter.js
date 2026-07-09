/*
 * pycortex-adapter.js — ViewerAdapter implementation for the pycortex WebGL viewer.
 *
 * THE ONLY FILE THAT KNOWS PYCORTEX INTERNALS. Everything pycortex-specific and every hard-won
 * gotcha lives here, behind the ViewerAdapter contract:
 *   - mriview.get_position() morph + the flatoff[1] mesh y-offset (vertices render at
 *     pivot.matrixWorld * (get_position + [0,-flatoff[1],0]); omitting it floats overlays off
 *     the inflated surface).
 *   - full pivot-chain updateMatrixWorld(true) (setMix drives ancestor transforms; updating only
 *     pivots.back reads a stale parent).
 *   - SVG overlay paths in the *viewBox* coordinate system (init sets viewBox to the original svg
 *     size; setHeight later overwrites width/height to the render size).
 *   - Labels data-ptidx convention: left = subjectIdx, right = leftVertexCount + subjectIdx.
 *   - svgo.update() rasterizes asynchronously; the surface fires "update" when the texture is
 *     swapped in (repaint then), and surfmix === the mix slider value.
 *   - dat.GUI control panel (gui.__folders) + LandscapeControls (setTarget/setRadius) + viewer.animate.
 */
import { ViewerAdapter } from "./viewer-adapter.js";
import { chaikin } from "../core/geom.js";
import { isClosed } from "../core/bezier.js";
import { exportSulciSvg } from "../core/svg-export.js";

const SVGNS = "http://www.w3.org/2000/svg";
const HEMIS = ["left", "right"];

// Tunable pycortex-specific constants (kept here, in the host adapter, where they belong).
const FLAT_THRESHOLD = 0.999;     // surfmix at/above this counts as "fully flat" (drawing-enabled)
const DEFAULT_FILL = 0.70;        // measureFrame: fraction of the viewport the brain should fill
const FRAME_TARGET_SAMPLES = 250; // measureFrame: ~vertices/hemi to KEEP for COM + extent (a target count, NOT a stride — contrast projectVertices' `subsample`)
const ZOOM_SENSITIVITY = 0.001;   // wheel deltaY -> radius factor exp(deltaY * this)
const DEFAULT_FOV_DEG = 35;       // fallback if the camera has no .fov
const OVERLAY_RETRY_MAX = 40;     // applyHostDefaults: tries waiting for the async SVG overlay
const OVERLAY_RETRY_MS = 250;     // ...interval between those tries
const COLLAPSE_SCHEDULE_MS = [400, 1200, 2500, 4500]; // re-collapse the late "data layers" folder
const COLLAPSE_WINDOW_MS = 8000;  // ...and on setData within this startup window only
const DEFAULT_THICKMIX = 0.5;     // thick-surface blend fed to get_position (constant; we don't expose it)
const FALLBACK_TEX_W = 1024;      // overlay viewBox width fallback when the surface reports no size
const FALLBACK_TEX_H = 768;       // overlay viewBox height fallback
const OUTLINE_STROKE_PX = 3;      // ROI colored-outline stroke width, in overlay viewBox px
const OUTLINE_HALO_PX = 2;        // extra width of the white halo drawn under the colored stroke
const OUTLINE_FALLBACK_COLOR = "#ffffff"; // stroke when an ROI has no (valid) color
const LABEL_FONT_PT = 14;         // ROI label font size, in pt
const CURVE_STROKE_PX = 6;        // sulcus stroke width, from pycortex defaults.cfg [sulci_paths]
const CURVE_STROKE_OPACITY = 0.6; // ...and its stroke-opacity

// A CSS hex color (#rgb / #rrggbb / #rrggbbaa) or the fallback. ROI colors are our own palette, but an
// imported file could carry anything, and the value goes into an SVG style attribute — restrict it to
// a hex literal so it can't smuggle in extra style declarations.
function safeColor(c) {
    return (typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : OUTLINE_FALLBACK_COLOR;
}

// Vertex count of a THREE BufferAttribute (pycortex's old three.js lacks `.count`).
function attrCount(attr) {
    if (attr.count !== undefined && !isNaN(attr.count)) return attr.count;
    return attr.array.length / attr.itemSize;
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
    else {
        if (!surface.pivots) missing.push("surface.pivots (morph transform chain)");
        // Projection + selection iterate BOTH hemis and read each one's position AND uv geometry
        // (allVertexUV/vertexUV/projectVerticesInUvBounds dereference attributes.uv.array). Check
        // every one so the uv path fails loudly here instead of silently `continue`-ing later.
        const h = surface.hemis || {};
        for (const side of ["left", "right"]) {
            const hemi = h[side];
            if (!hemi || !hemi.attributes) { missing.push(`surface.hemis.${side} (hemisphere geometry)`); continue; }
            if (!hemi.attributes.position) missing.push(`surface.hemis.${side}.attributes.position (vertex geometry)`);
            if (!hemi.attributes.uv) missing.push(`surface.hemis.${side}.attributes.uv (flat-UV coords)`);
        }
    }
    if (!svgoverlay) missing.push("svgoverlay (global, ROI overlay rendering)");
    return { ok: missing.length === 0, missing };
}

// True once the surface's geometry + pivots are built (projection + arming work). The viewer
// creates `viewer` and decodes the CTM asynchronously, so callers poll this before attaching.
export function surfaceReady(viewer) {
    const s = findSurface(viewer);
    return !!(s && s.pivots && s.hemis && s.hemis.left &&
              s.hemis.left.attributes && s.hemis.left.attributes.position);
}

export class PycortexAdapter extends ViewerAdapter {
    constructor(viewer, { layerName = "drawnrois", animSpeedFallback = 0.6 } = {}) {
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

        this._layerName = layerName;
        this._animSpeedFallback = animSpeedFallback;
        this._v = new this.THREE.Vector3();
        this._thickmix = DEFAULT_THICKMIX;
        this._drawn = null;          // { layerEl, labels } for the current overlay layer
        this._layerHidden = false;
        this._labelsHidden = false;
        this._uiFolderAdded = false;
    }

    // --- surface identity -------------------------------------------------------------

    surfaceId() {
        try {
            const d = this.viewer.active && this.viewer.active.data && this.viewer.active.data[0];
            if (d && d.subject) return d.subject;
        } catch (e) { console.debug("[roidraw] surfaceId lookup failed, using 'unknown':", e); }
        return "unknown";
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

    // Refresh the WHOLE pivot chain so back.matrixWorld reflects the current mix, then return
    // {cam, surfmix, foy, W, H}. setMix drives ancestor transforms (pivots.front via setPivot,
    // back.rotation.x), so updating only `back` would read a stale parent.
    _prepProjection() {
        const cam = this.viewer.camera;
        cam.updateMatrixWorld();
        if (this.viewer.root && this.viewer.root.updateMatrixWorld) this.viewer.root.updateMatrixWorld(true);
        const r = this.canvas().getBoundingClientRect();
        return { cam, surfmix: this._currentMix(), foy: this._flatOffY(), W: r.width, H: r.height };
    }

    // World position of geometry-local vertex `i` at the current mix (incl. the flatoff offset
    // so it lands on the *rendered* mesh, not floating above it). Mutates+returns this._v.
    // Applies the flatoff offset to our OWN vector (never to get_position's returned `pos`, which
    // may be a shared/cached vector inside mriview — mutating it would corrupt host state).
    _worldOf(pd, mw, i, surfmix, foy) {
        const gp = this.mriview.get_position(pd, surfmix, this._thickmix, i).pos;
        this._v.copy(gp);
        this._v.y -= foy;
        return this._v.applyMatrix4(mw);
    }

    projectVertices({ subsample = 1 } = {}) {
        const { cam, surfmix, foy, W, H } = this._prepProjection();
        const out = { left: { idx: [], px: [] }, right: { idx: [], px: [] } };
        for (const h of HEMIS) {
            const pivot = this.surface.pivots[h].back;
            pivot.updateMatrixWorld(true);
            const mw = pivot.matrixWorld;
            const pd = this.posdata[h];
            const revIdx = this.surface.hemis[h].reverseIndexMap; // geometry-local -> subject
            const n = attrCount(pd.positions[0]);
            const step = Math.max(1, subsample | 0);
            for (let i = 0; i < n; i += step) {
                const v = this._worldOf(pd, mw, i, surfmix, foy).project(cam);
                if (v.z < -1 || v.z > 1) continue; // behind camera / outside frustum
                out[h].idx.push(revIdx[i]);
                out[h].px.push(this._ndc(v, W, H));
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
            const hemi = this.surface.hemis[h];
            const uvarr = hemi.attributes.uv && hemi.attributes.uv.array;
            if (!uvarr) continue;
            const revIdx = hemi.reverseIndexMap;
            const n = attrCount(this.posdata[h].positions[0]);
            for (let i = 0; i < n; i++) {
                out[h].idx.push(revIdx[i]);
                out[h].uv.push([uvarr[i * 2], uvarr[i * 2 + 1]]);
            }
        }
        return out;
    }

    // Flat-UV of one subject vertex {h,g}, or null if it has no flat coords.
    vertexUV(o) {
        const hemi = this.surface.hemis[o.h];
        if (!hemi || !hemi.attributes.uv) return null;
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
        const { cam, surfmix, foy, W, H } = this._prepProjection();
        const out = { left: { uv: [], px: [] }, right: { uv: [], px: [] } };
        for (const h of HEMIS) {
            const pivot = this.surface.pivots[h].back;
            pivot.updateMatrixWorld(true);
            const mw = pivot.matrixWorld;
            const pd = this.posdata[h];
            const uvarr = this.surface.hemis[h].attributes.uv && this.surface.hemis[h].attributes.uv.array;
            if (!uvarr) continue;
            const n = attrCount(pd.positions[0]);
            for (let i = 0; i < n; i++) {
                const u = uvarr[i * 2], v = uvarr[i * 2 + 1];
                if (u < b.minu || u > b.maxu || v < b.minv || v > b.maxv) continue;
                const p = this._worldOf(pd, mw, i, surfmix, foy).project(cam);
                if (p.z < -1 || p.z > 1) continue;
                out[h].uv.push([u, v]);
                out[h].px.push(this._ndc(p, W, H));
            }
        }
        return out;
    }

    _ndc(v, W, H) { return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H]; }

    // --- view framing primitive -------------------------------------------------------

    // Center of mass (world) + the camera radius that fills `fillTarget` of the viewport.
    // fill is the on-screen NDC extent (canvas-size independent); on-screen size ∝ 1/radius.
    // (host-only — used by the controller's framing; not part of the portable ViewerAdapter contract.)
    measureFrame(fillTarget = DEFAULT_FILL, targetSamples = FRAME_TARGET_SAMPLES) {
        const ctrl = this.viewer.controls;
        if (!ctrl || typeof ctrl.radius !== "number") return null;
        const { cam, surfmix, foy, W, H } = this._prepProjection();
        let sx = 0, sy = 0, sz = 0, count = 0;
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, seen = false;
        for (const h of HEMIS) {
            const pivot = this.surface.pivots[h].back;
            pivot.updateMatrixWorld(true);
            const mw = pivot.matrixWorld, pd = this.posdata[h], n = attrCount(pd.positions[0]);
            const step = Math.max(1, Math.floor(n / targetSamples));   // targetSamples = COUNT to keep, not a stride
            for (let i = 0; i < n; i += step) {
                const w = this._worldOf(pd, mw, i, surfmix, foy);
                sx += w.x; sy += w.y; sz += w.z; count++;
                const nd = w.clone().project(cam);
                if (nd.z < -1 || nd.z > 1) continue;
                const px = this._ndc(nd, W, H);
                if (px[0] < minx) minx = px[0];
                if (px[0] > maxx) maxx = px[0];
                if (px[1] < miny) miny = px[1];
                if (px[1] > maxy) maxy = px[1];
                seen = true;
            }
        }
        if (!count) return null;
        const out = { com: [sx / count, sy / count, sz / count], radius: ctrl.radius };
        if (seen && W > 0 && H > 0) {
            const fill = Math.max((maxx - minx) / W, (maxy - miny) / H);
            if (fill > 0.01) out.radius = ctrl.radius * (fill / fillTarget);
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
    // (host-only — used by the controller's framing/flatten; not part of the portable contract.)
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

    // --- overlay layer (occlusion-correct ROI rendering) ------------------------------

    setOverlayLayer(name, shapes) {
        const svgo = this.surface.svg;
        if (!svgo || !svgo.svg || !svgo.posdata || !svgo.depth) return false; // overlay not loaded yet
        const doc = svgo.svg.ownerDocument;
        // Paths live in the viewBox coordinate system, NOT the (later-overwritten) width/height.
        const vb = (svgo.svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(parseFloat);
        const W = (vb.length === 4 && vb[2]) ? vb[2] : svgo.width;
        const H = (vb.length === 4 && vb[3]) ? vb[3] : svgo.height;

        // tear down the previous layer + its label sprites
        if (this._drawn) {
            try {
                if (this._drawn.labels) {
                    svgo.labels.left.remove(this._drawn.labels.meshes.left);
                    svgo.labels.right.remove(this._drawn.labels.meshes.right);
                }
                if (this._drawn.layerEl && this._drawn.layerEl.parentNode)
                    this._drawn.layerEl.parentNode.removeChild(this._drawn.layerEl);
            } catch (e) { /* best effort */ }
            delete svgo.layers[name];
            delete svgo[name];
            this._drawn = null;
        }
        if (!shapes.length) { svgo.update(); return true; }

        // <g.display_layer> > (shapes group with white-outline paths) + (labels group with texts)
        const layerEl = doc.createElementNS(SVGNS, "g");
        layerEl.setAttribute("id", name);
        layerEl.setAttribute("class", "display_layer");
        layerEl.setAttribute("style", "display:" + (this._layerHidden ? "none" : "inline"));
        const shapesEl = doc.createElementNS(SVGNS, "g");
        shapesEl.setAttribute("id", name + "_shapes");
        const labelsEl = doc.createElementNS(SVGNS, "g");
        labelsEl.setAttribute("id", name + "_labels");
        layerEl.appendChild(shapesEl);
        layerEl.appendChild(labelsEl);

        for (const shape of shapes) {
            const d = this._shapeSvgPath(shape, W, H);
            if (d) {
                const sulcus = shape.kind === "sulcus";
                const w = sulcus ? CURVE_STROKE_PX : OUTLINE_STROKE_PX;
                const op = sulcus ? CURVE_STROKE_OPACITY : 1;
                // White halo under a colored stroke: the halo keeps the outline legible on any
                // background (colored data or white anatomy), while the color carries the shape
                // identity the panel swatch shows. Same path `d`, drawn wider + white underneath.
                // This halo is a roidraw rendering choice for the LIVE overlay only, and is NOT
                // part of the exported markup.
                const halo = doc.createElementNS(SVGNS, "path");
                halo.setAttribute("d", d);
                halo.setAttribute("style", "fill:none;stroke:#ffffff;stroke-width:" + (w + OUTLINE_HALO_PX) + ";stroke-opacity:0.9");
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
                t.setAttribute("style", "font-family:Helvetica, sans-serif;font-size:" + LABEL_FONT_PT + "pt;font-weight:bold;" +
                    "font-style:italic;fill:white;fill-opacity:1;text-anchor:middle;filter:url(#dropshadow)");
                t.appendChild(doc.createTextNode(shape.name)); // createTextNode => no injection
                labelsEl.appendChild(t);
            }
        }
        svgo.svg.appendChild(layerEl);

        // occlusion-aware label sprites, reusing pycortex's own Labels; degrade gracefully
        let labels = null;
        try {
            labels = new this.svgoverlay.Labels(labelsEl, svgo.posdata, !!this._labelsHidden);
            labels.shader.uniforms.depth.value = svgo.depth;
            const w = this.surface.width || this.viewportSize().width || FALLBACK_TEX_W;
            const h = this.surface.height || this.viewportSize().height || FALLBACK_TEX_H;
            labels.shader.uniforms.scale.value.set(1 / w, 1 / h);
            labels.setMix({ mix: this._currentMix(), thickmix: this._thickmix });
            svgo.labels.left.add(labels.meshes.left);
            svgo.labels.right.add(labels.meshes.right);
        } catch (e) {
            console.warn("[roidraw] ROI labels failed (outlines still drawn):", e);
            labels = null;
        }

        const stub = { meshes: { left: { visible: false }, right: { visible: false } }, setMix() {}, showhide() {} };
        svgo.layers[name] = svgo[name] = {
            name, layer: layerEl, labels: labels || stub, _hidden: !!this._layerHidden,
            showhide(state) { if (state === undefined) return !this._hidden; this._hidden = !state; layerEl.style.display = state ? "inline" : "none"; },
        };
        this._drawn = { layerEl, labels };
        this._ensureUIFolder(name);
        svgo.update(); // re-rasterize -> new surface texture (includes the outlines)
        return true;
    }

    // A shape's outline as an SVG path in overlay (flat-uv) coords. A bezier is emitted as a
    // native cubic path. Only ROIs have the legacy vertex-ring fallback (v1 files); a sulcus is
    // always bezier-backed, since it is created from a fitted open curve.
    _shapeSvgPath(shape, W, H) {
        if (shape.bezier && shape.bezier.anchors && shape.bezier.anchors.length >= 2)
            return this._bezierSvgPath(shape.bezier, W, H);
        if (shape.kind === "sulcus") return null;
        if (!shape.outline || shape.outline.length < 3) return null;
        const pts = [];
        for (const o of shape.outline) {
            const uv = this.vertexUV(o);
            if (uv) pts.push([uv[0] * W, (1 - uv[1]) * H]);
        }
        if (pts.length < 3) return null;
        const c = chaikin(pts, 2);
        let d = "M" + c[0][0].toFixed(2) + "," + c[0][1].toFixed(2);
        for (let i = 1; i < c.length; i++) d += "L" + c[i][0].toFixed(2) + "," + c[i][1].toFixed(2);
        return d + "Z";
    }

    // Cubic-bezier path from {anchors,inHandles,outHandles} in flat-uv -> viewBox px. This IS
    // pycortex's overlay coordinate space, so the `d` we emit here is directly usable in an
    // overlays.svg. A CLOSED bezier wraps back to anchor 0 and ends with `Z`; an OPEN one (a
    // sulcus) has n-1 segments and MUST NOT close — the missing `Z` is exactly what distinguishes
    // a sulcus from an ROI on disk.
    _bezierSvgPath(bez, W, H) {
        const { anchors, inHandles, outHandles } = bez;
        const n = anchors.length;
        const closed = isClosed(bez);
        if (n < (closed ? 3 : 2)) return null;
        const P = (uv) => (uv[0] * W).toFixed(2) + "," + ((1 - uv[1]) * H).toFixed(2);
        let d = "M" + P(anchors[0]);
        const segs = closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
            const j = closed ? (i + 1) % n : i + 1;
            d += "C" + P(outHandles[i]) + " " + P(inHandles[j]) + " " + P(anchors[j]);
        }
        return closed ? d + "Z" : d;
    }

    /*
     * Serialize drawn sulci as a pycortex overlays.svg fragment. The `d` strings come from the
     * SAME uv->viewBox mapping the live overlay uses, which is pycortex's own overlay coordinate
     * space — so the output drops straight into a subject's overlays.svg. Returns "" if the
     * overlay isn't loaded yet or there are no sulci.
     */
    exportSulciMarkup(sulci) {
        const svgo = this.surface.svg;
        if (!svgo || !svgo.svg) return "";
        const vb = (svgo.svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(parseFloat);
        const W = (vb.length === 4 && vb[2]) ? vb[2] : svgo.width;
        const H = (vb.length === 4 && vb[3]) ? vb[3] : svgo.height;
        return exportSulciSvg(sulci, {
            pathFor: (bez) => (bez ? this._bezierSvgPath(bez, W, H) : null),
            ptidxFor: (lv) => this._labelPtidx(lv),
        });
    }

    _labelPtidx(lv) {
        if (!lv) return null;
        const leftlen = attrCount(this.posdata.left.positions[0]);
        return lv.h === "left" ? lv.g : leftlen + lv.g;
    }

    setLayerVisible(name, shapes, labels) {
        if (shapes !== undefined) {
            this._layerHidden = !shapes;
            if (this._drawn && this._drawn.layerEl) this._drawn.layerEl.style.display = shapes ? "inline" : "none";
            if (this.surface.svg) this.surface.svg.update();
        }
        if (labels !== undefined) {
            this._labelsHidden = !labels;
            if (this._drawn && this._drawn.labels) this._drawn.labels.showhide(labels);
        }
    }

    // Register a "drawn ROIs" folder under Surface > overlays, once (mirrors built-in rois/sulci).
    _ensureUIFolder(name) {
        if (this._uiFolderAdded) return;
        const svgo = this.surface.svg, self = this;
        if (!svgo || !svgo.ui) return;
        try {
            svgo.ui.addFolder("drawn ROIs", true).add({
                visible: { action: [{ get f() { return !self._layerHidden; }, set f(v) { self.setLayerVisible(name, v, undefined); } }, "f"] },
            });
            this._uiFolderAdded = true;
        } catch (e) { console.warn("[roidraw] control-panel folder add failed:", e); }
    }

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

    // pycortex-specific startup niceties (not part of the portable contract):
    // hide the built-in ROI layer (keep sulci), and re-collapse the late "data layers" folder.
    applyHostDefaults() {
        const trySetOverlays = (tries) => {
            const svg = this.surface && this.surface.svg;
            if (!svg || !svg.layers || !(svg.rois || svg.sulci)) {
                if (tries > OVERLAY_RETRY_MAX) return;
                setTimeout(() => trySetOverlays(tries + 1), OVERLAY_RETRY_MS);
                return;
            }
            if (svg.rois) { svg.rois.showhide(false); if (svg.rois.labels) svg.rois.labels.showhide(false); }
            if (svg.sulci) svg.sulci.showhide(true);
            this.requestRender();
        };
        trySetOverlays(0);
        // the datasets folder is built open after data loads (post-attach); re-collapse a few times
        COLLAPSE_SCHEDULE_MS.forEach((ms) => setTimeout(() => this.collapseControlPanel(false), ms));
        const t0 = Date.now();
        if (this.viewer.addEventListener)
            this.viewer.addEventListener("setData", () => { if (Date.now() - t0 < COLLAPSE_WINDOW_MS) this.collapseControlPanel(false); });
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
