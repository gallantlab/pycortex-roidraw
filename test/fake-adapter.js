/*
 * fake-adapter.js — a synthetic-surface ViewerAdapter for headless tests. No THREE, no DOM, no
 * pycortex: just a known G×G grid of left-hemi vertices whose flat-UV and current-view px are
 * analytically known, so a test can compute exactly which vertices a lasso/curve should enclose.
 *
 * Left vertex (i,j) for i,j in 0..G-1:  subject index g = i*G + j,  uv = [i/(G-1), j/(G-1)],
 * and current-view px = uv * SCALE. The right hemi is one far-away vertex (must never be selected
 * by a left-side gesture). Implementing the full ViewerAdapter also makes this a conformance check:
 * if the contract grows a method, the fake fails loudly until updated.
 */
import { ViewerAdapter } from "../adapter/viewer-adapter.js";

const SCALE = 1000;

export class FakeSurfaceAdapter extends ViewerAdapter {
    constructor({ grid = 11, flat = true } = {}) {
        super();
        this.G = grid;
        this._flat = flat;
        this._radius = 100;
        this._mixCbs = [];
        this.calls = { flatten: 0, setOverlayLayer: 0 };  // spy counters for wiring tests
        const idx = [], uv = [], px = [];
        for (let i = 0; i < grid; i++) {
            for (let j = 0; j < grid; j++) {
                idx.push(i * grid + j);
                const u = i / (grid - 1), v = j / (grid - 1);
                uv.push([u, v]);
                px.push([u * SCALE, v * SCALE]);
            }
        }
        this._left = { idx, uv, px };
        this._right = { idx: [99999], uv: [[5, 5]], px: [[5 * SCALE, 5 * SCALE]] };
    }

    // Resolve a {h,g} back to its grid (i,j) so vertexUV is exact.
    _uvOf(h, g) {
        if (h === "left") { const i = Math.floor(g / this.G), j = g % this.G; return [i / (this.G - 1), j / (this.G - 1)]; }
        if (h === "right" && g === 99999) return [5, 5];
        return null;
    }

    surfaceId() { return "fake-grid"; }
    isFlat() { return this._flat; }
    viewportSize() { return { width: SCALE, height: SCALE }; }
    canvas() { return null; }

    projectVertices({ subsample = 1 } = {}) {
        const pick = (hemi) => {
            const idx = [], px = [];
            for (let k = 0; k < hemi.idx.length; k++) if (k % subsample === 0) { idx.push(hemi.idx[k]); px.push(hemi.px[k]); }
            return { idx, px };
        };
        return { left: pick(this._left), right: pick(this._right) };
    }

    allVertexUV() {
        return { left: { idx: this._left.idx, uv: this._left.uv }, right: { idx: this._right.idx, uv: this._right.uv } };
    }

    vertexUV(o) { return o ? this._uvOf(o.h, o.g) : null; }

    projectVerticesInUvBounds(b) {
        const within = (hemi) => {
            const uv = [], px = [];
            for (let k = 0; k < hemi.uv.length; k++) {
                const [u, v] = hemi.uv[k];
                if (u >= b.minu && u <= b.maxu && v >= b.minv && v <= b.maxv) { uv.push(hemi.uv[k]); px.push(hemi.px[k]); }
            }
            return { uv, px };
        };
        return { left: within(this._left), right: within(this._right) };
    }

    setOverlayLayer() { this.calls.setOverlayLayer++; }
    setLayerVisible() {}
    flatten() { this.calls.flatten++; this._flat = true; this._emitMix(); }
    setCameraTarget() {}
    setCameraRadius(r) { this._radius = r; }
    cameraRadius() { return this._radius; }
    requestRender() {}
    onMixChange(cb) { this._mixCbs.push(cb); return () => { this._mixCbs = this._mixCbs.filter((c) => c !== cb); }; }

    // --- test drivers (not part of the contract) ---
    _emitMix() { for (const cb of this._mixCbs) cb(); }
    setFlat(flat) { this._flat = flat; this._emitMix(); }   // simulate the unfold slider moving
}
