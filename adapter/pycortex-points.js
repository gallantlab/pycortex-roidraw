/*
 * pycortex-points.js — drawn POINTS on a pycortex surface: picking a vertex under the cursor and
 * rendering one marker per point. Owned by PycortexAdapter, which delegates its point methods here.
 *
 * Points do not go through the SVG overlay (a surface without a flatmap has none), so they work at
 * any unfold mix and on any subject. Conventions this file relies on:
 *   - surface.picker.get_vertex_index(renderer, camera, x, y) -> {vertex, hemi} | -1 is pycortex's
 *     side-effect-free pick (the click-pick path also draws its crosshair and logs). `vertex` has
 *     picker.revIndex applied: it is the index in the CTM file's vertex order, which for pycortex's
 *     default mg2 compression is NOT the subject's order (see core/shape-model.js); x/y are
 *     canvas-relative px. The SVG overlay's label sprites live in the same scene the picker renders
 *     into its pick buffers, so pycortex hides them around every pick (Viewer.svgOff/svgOn,
 *     Surface.pick) — pick() does the same, or a click near a label decodes the label's position.
 *   - picker.markers[h] is a THREE.Group inside pivots[h].back, already offset by -flatoff[1]: an
 *     object placed there at mriview.get_position(...).pos sits on the rendered mesh at every mix.
 *     The picker hides these groups while it renders its pick buffers, so markers never block a pick.
 *   - hemis[h].indexMap maps that CTM index to the geometry-local index get_position takes
 *     (hemis[h].reverseIndexMap is its inverse — what picker.revIndex applies).
 *   - The surface fires "mix" on every morph frame; markers are re-placed then.
 */
import { isHemi } from "../core/hemis.js";
import { safeColor } from "./pycortex-overlay.js";

// Marker colors go through three.js r69's Color.setStyle, which parses #rgb / #rrggbb only (an
// alpha digit pair leaves the color white). Keep the opaque part of a safeColor hex.
const opaqueHex = (c) => { const h = safeColor(c); return h.length === 5 || h.length === 9 ? h.slice(0, h.length - (h.length === 5 ? 1 : 2)) : h; };

const DEFAULT_RADIUS = 1.5;       // marker sphere radius, in surface units (mm on a fiducial surface)
const NORMAL_LIFT = 0.5;          // lift the marker along the vertex normal so it isn't half-buried
const SPHERE_SEGMENTS = 12;

export class PycortexPoints {
    /* `adapter` is the PycortexAdapter these points belong to (surface, posdata, mix, renderer). */
    constructor(adapter, { thickmix, radius = DEFAULT_RADIUS } = {}) {
        this._a = adapter;
        this._thickmix = thickmix;
        this._radius = radius;
        this._markers = [];          // [{ mesh, h, local }]
        this._geom = null;           // one shared sphere geometry
        this._onMix = () => this._place();
        this._a.surface.addEventListener("mix", this._onMix);
    }

    _picker() { return this._a.surface.picker; }

    // The thick-surface blend the host renders with (so markers sit where the picker picks), else ours.
    _thick() {
        const p = this._picker();
        const u = p && p.uniforms && p.uniforms.thickmix;
        return (u && typeof u.value === "number") ? u.value : this._thickmix;
    }

    /* Whether pick() can answer yet: the picker, its pick buffers (sized on the first resize) and its
     * per-hemisphere kd-trees (built by a worker after load) all exist. Before that, every pick
     * would come back empty and read as a click on the background. */
    canPick() {
        const p = this._picker(), v = this._a.viewer;
        return !!(p && typeof p.get_vertex_index === "function" && p.x && p.lkdt && p.rkdt && v.renderer && v.camera);
    }

    /* The vertex under canvas px (x, y): { h, g, xyz } or null (background / picker not ready).
     * `xyz` is the vertex's BASE-surface position (posdata positions[0]) — the anatomical surface as
     * stored in the viewer, independent of the current unfold mix. */
    pick(x, y) {
        const p = this._picker(), v = this._a.viewer;
        if (!p || typeof p.get_vertex_index !== "function" || !v.renderer || !v.camera) return null;
        const labels = this._a.surface.svg && this._a.surface.svg.labels;
        const shown = labels ? [labels.left.visible, labels.right.visible] : null;
        if (labels) { labels.left.visible = false; labels.right.visible = false; }
        let r;
        try { r = p.get_vertex_index(v.renderer, v.camera, Math.round(x), Math.round(y)); }
        finally { if (labels) { labels.left.visible = shown[0]; labels.right.visible = shown[1]; } }
        if (!r || r === -1 || !isHemi(r.hemi) || !Number.isInteger(r.vertex)) return null;
        return { h: r.hemi, g: r.vertex, xyz: this._basePosition(r.hemi, r.vertex) };
    }

    // Geometry-local index of (CTM-order) vertex g, or null when the viewer's mesh doesn't have it.
    _local(h, g) {
        const hemi = this._a.surface.hemis[h];
        const m = hemi && hemi.indexMap;
        const i = m ? m[g] : undefined;
        return Number.isInteger(i) ? i : null;
    }

    /* Base-surface position of vertex {h, g} in this mesh, or null when the mesh doesn't have it. */
    position(h, g) { return isHemi(h) ? this._basePosition(h, g) : null; }

    _basePosition(h, g) {
        const i = this._local(h, g);
        const pd = this._a.posdata[h];
        if (i === null || !pd) return null;
        const a = pd.positions[0].array;
        return [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
    }

    /* Replace the rendered markers with `points` ([{vert:{h,g}, color}]). Returns false while the
     * picker isn't built yet (the caller retries), else the number of points whose vertex isn't in
     * this mesh (not drawn; 0 when every point was placed). */
    setPoints(points) {
        const p = this._picker();
        if (!p || !p.markers) {
            // Nothing to draw needs no picker: a viewer without one must not hold up an ROI-only sync.
            if (points.length) return false;
            this._markers = [];
            return 0;
        }
        this._clear();
        const THREE = this._a.THREE;
        if (!this._geom && points.length) this._geom = new THREE.SphereGeometry(this._radius, SPHERE_SEGMENTS, SPHERE_SEGMENTS);
        let skipped = 0;
        for (const pt of points) {
            const h = pt.vert && pt.vert.h;
            const local = isHemi(h) ? this._local(h, pt.vert.g) : null;
            if (local === null) { skipped++; continue; }
            const mesh = new THREE.Mesh(this._geom, new THREE.MeshBasicMaterial({ color: opaqueHex(pt.color) }));
            mesh.name = "roidraw-point";
            p.markers[h].add(mesh);
            this._markers.push({ mesh, h, local });
        }
        this._place();
        return skipped;
    }

    // Put every marker on the rendered mesh at the current mix.
    _place() {
        if (!this._markers.length) return;
        const mix = this._a.currentMix(), thick = this._thick();
        for (const m of this._markers) {
            const vp = this._a.mriview.get_position(this._a.posdata[m.h], mix, thick, m.local);
            m.mesh.position.copy(vp.pos);
            if (vp.norm) m.mesh.position.add(vp.norm.clone().normalize().multiplyScalar(NORMAL_LIFT));
        }
        this._a.requestRender();
    }

    _clear() {
        const p = this._picker();
        for (const m of this._markers) {
            if (p && p.markers && p.markers[m.h]) p.markers[m.h].remove(m.mesh);
            if (m.mesh.material && m.mesh.material.dispose) m.mesh.material.dispose();
        }
        this._markers = [];
    }

    /* Remove every marker and the mix listener. Safe to call more than once. */
    destroy() {
        this._clear();
        if (this._geom && this._geom.dispose) this._geom.dispose();
        this._geom = null;
        if (this._onMix) this._a.surface.removeEventListener("mix", this._onMix);
        this._onMix = null;
        this._a.requestRender();
    }
}
