/*
 * fake-adapter.js — a synthetic-surface ViewerAdapter for headless tests. No THREE, no DOM, no
 * pycortex: a known G×G grid of vertices per hemisphere whose flat-UV is analytic and whose
 * current-view px is a REAL projection of that uv (rotated + translated — deliberately NOT uv*scale,
 * so a projection/y-flip/identity bug in the lasso→px→uv path can actually be caught). The right
 * hemisphere is a full second grid placed beside the left (like a real bi-hemi flat view), so a
 * left-side lasso must exclude it by position, not because "right" is one far-away point.
 *
 * Left/right vertex (i,j), i,j in 0..G-1:  subject index g = i*G + j,  uv = [i/(G-1), j/(G-1)].
 * Implementing the full ViewerAdapter also makes this a conformance check.
 */
import { ViewerAdapter } from "../adapter/viewer-adapter.js";

const SCALE = 1000;
const THETA = 0.3;          // rotate uv→px so the two axes are NOT aligned (catches shear/flip bugs)
const ORIGIN = [120, 90];   // translate so px ≠ uv*scale (catches identity/offset assumptions)
const RIGHT_U_OFFSET = 2;   // the right hemisphere lives in its OWN uv band (u∈[2,3]) beside the left
                            // (u∈[0,1]) — as in a real flat layout where the two hemis don't overlap,
                            // so a curve drawn over one hemi can't capture the other in uv space.

// Project a uv point to current-view px (rotation + translation; identity-free).
function project(u, v) {
    const c = Math.cos(THETA), s = Math.sin(THETA);
    return [ORIGIN[0] + SCALE * (c * u - s * v), ORIGIN[1] + SCALE * (s * u + c * v)];
}

export class FakeSurfaceAdapter extends ViewerAdapter {
    constructor({ grid = 11, flat = true } = {}) {
        super();
        this.G = grid;
        this._flat = flat;
        this._radius = 100;
        this._mixCbs = [];
        this.calls = { flatten: 0, setOverlayLayer: 0 };  // spy counters for wiring tests
        this._left = this._buildHemi(0);
        this._right = this._buildHemi(RIGHT_U_OFFSET);
    }

    _buildHemi(uOff) {
        const idx = [], uv = [], px = [];
        for (let i = 0; i < this.G; i++) {
            for (let j = 0; j < this.G; j++) {
                idx.push(i * this.G + j);
                const u = uOff + i / (this.G - 1), v = j / (this.G - 1);
                uv.push([u, v]);
                px.push(project(u, v));
            }
        }
        return { idx, uv, px };
    }

    // Project a hemi's local uv (u∈[0,1]) to px the same way the surface does — for tests to build lassos.
    projectUv(hemi, u, v) { return project(u + (hemi === "right" ? RIGHT_U_OFFSET : 0), v); }

    // Resolve a {h,g} back to its grid uv (the right hemi sits in its own u-band).
    _uvOf(h, g) {
        if ((h === "left" || h === "right") && g >= 0 && g < this.G * this.G) {
            const uOff = h === "right" ? RIGHT_U_OFFSET : 0;
            const i = Math.floor(g / this.G), j = g % this.G;
            return [uOff + i / (this.G - 1), j / (this.G - 1)];
        }
        return null;
    }

    surfaceId() { return "fake-grid"; }
    isFlat() { return this._flat; }
    viewportSize() { return { width: SCALE * 3, height: SCALE * 2 }; }
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

    setOverlayLayer() { this.calls.setOverlayLayer++; return true; }   // the contract returns a boolean
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
