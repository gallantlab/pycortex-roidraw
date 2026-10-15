/*
 * points.test.js — the POINT tool: the mode machine never flattens or exits for it, the points-v1
 * document round-trips, and the pycortex adapter picks + renders points on a surface WITHOUT a
 * flatmap (no flatlims, no uv, no SVG overlay) — the case the tool exists for.
 */
import test from "node:test";
import assert from "node:assert";
import { DrawModeMachine, TOOL, asTool, toolNeedsFlat } from "../core/draw-mode.js";
import { ShapeSet, POINTS_FORMAT, FORMAT } from "../core/shape-model.js";
import { PycortexAdapter } from "../adapter/pycortex-adapter.js";
import { FakeSurfaceAdapter } from "./fake-adapter.js";

/* --- draw-mode ------------------------------------------------------------------------------- */

test("POINT is a tool that needs no flatmap", () => {
    assert.strictEqual(asTool("point"), TOOL.POINT);
    assert.strictEqual(toolNeedsFlat(TOOL.POINT), false);
    assert.strictEqual(toolNeedsFlat(TOOL.LASSO), true);
    assert.strictEqual(toolNeedsFlat(TOOL.TRACE), true);
});

test("entering Draw with the Point tool does not flatten, and inflating never exits", () => {
    const m = new DrawModeMachine();
    assert.strictEqual(m.enterDraw(false).flatten, false);
    for (const flat of [false, true, false]) assert.strictEqual(m.noteMix(flat).exit, false);
    assert.strictEqual(m.mode, "draw");
});

test("switching to a flat tool while inflated re-flattens; while flat it arms the exit latch", () => {
    const m = new DrawModeMachine();
    m.enterDraw(false);
    const r = m.setNeedsFlat(true, false);
    assert.strictEqual(r.flatten, true);
    assert.strictEqual(m.noteMix(false).exit, false, "the re-flatten glide must not exit");
    m.noteMix(true);
    assert.strictEqual(m.noteMix(false).exit, true, "inflating after reaching flat exits");

    const n = new DrawModeMachine();
    n.enterDraw(false);
    assert.strictEqual(n.setNeedsFlat(true, true).flatten, false);
    assert.strictEqual(n.noteMix(false).exit, true, "already flat: the next inflate exits");
});

test("switching to the Point tool never flattens, in or out of Draw", () => {
    const m = new DrawModeMachine();
    assert.strictEqual(m.setNeedsFlat(false, false).flatten, false);
    m.enterDraw(true);
    m.noteMix(true);
    assert.strictEqual(m.setNeedsFlat(false, true).flatten, false);
    assert.strictEqual(m.noteMix(false).exit, false, "with the Point tool, inflating stays in Draw");
});

/* --- shape model ------------------------------------------------------------------------------ */

test("points-v1 round-trips name, color, hemi, viewerVertex, xyz; ROIs stay out of it", () => {
    const s = new ShapeSet();
    s.add({ kind: "point", name: "VWFA", color: "#123456", vert: { h: "left", g: 32904 }, xyz: [-42, -57, -12] });
    s.add({ kind: "roi", name: "V1", left: [1], right: [] });
    const doc = s.toPointsJSON("mni152");
    assert.strictEqual(doc.format, POINTS_FORMAT);
    assert.strictEqual(doc.surface, "mni152");
    assert.deepStrictEqual(doc.points, [{ name: "VWFA", color: "#123456", hemi: "left", viewerVertex: 32904, xyz: [-42, -57, -12] }]);
    assert.strictEqual(s.toJSON("mni152").rois.length, 1, "the ROI document carries only the ROI");

    const t = new ShapeSet();
    const added = t.loadJSON(JSON.parse(JSON.stringify(doc)));
    assert.strictEqual(added.length, 1);
    assert.strictEqual(added[0].kind, "point");
    assert.deepStrictEqual(added[0].vert, { h: "left", g: 32904 });
    assert.deepStrictEqual(added[0].xyz, [-42, -57, -12]);
    assert.strictEqual(added[0].color, "#123456");
});

test("points-v1 import skips entries without a valid hemi/viewerVertex and names unnamed ones", () => {
    const t = new ShapeSet();
    const added = t.loadJSON({ format: POINTS_FORMAT, points: [
        { hemi: "left", viewerVertex: 5 },
        { hemi: "middle", viewerVertex: 5 },
        { hemi: "right", viewerVertex: -1 },
        { hemi: "right", viewerVertex: 2.5 },
        { hemi: "right", vertex: 6 },                       // not this format's field: skipped
        { hemi: "right", viewerVertex: 7, xyz: [1, 2] },
    ] });
    assert.deepStrictEqual(added.map((p) => [p.vert.h, p.vert.g]), [["left", 5], ["right", 7]]);
    assert.deepStrictEqual(added.map((p) => p.name), ["point1", "point2"]);
    assert.strictEqual(added[1].xyz, null, "a malformed xyz is dropped, not kept half-formed");
});

test("loadJSON still reads a vertexset, and a point never aliases the caller's object", () => {
    const t = new ShapeSet();
    assert.strictEqual(t.loadJSON({ format: FORMAT, rois: [{ name: "A", vertices: { left: [1], right: [] } }] })[0].kind, "roi");
    const vert = { h: "left", g: 3 };
    const p = t.add({ kind: "point", name: "p", vert });
    vert.g = 99;
    assert.strictEqual(p.vert.g, 3);
});

/* --- contract defaults ------------------------------------------------------------------------- */

test("the point methods' contract defaults: flat assumed, no picking, markers a no-op success", () => {
    const a = new FakeSurfaceAdapter();
    assert.strictEqual(a.hasFlat(), true);
    assert.strictEqual(a.canPick(), false);
    assert.strictEqual(a.pickVertex(1, 2), null);
    assert.strictEqual(a.vertexPosition({ h: "left", g: 0 }), null);
    assert.strictEqual(a.setPointMarkers([]), 0, "0 points could not be drawn");
});

/* --- the pycortex adapter on a surface with NO flatmap --------------------------------------- */

class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    add(o) { this.x += o.x; this.y += o.y; this.z += o.z; return this; }
    normalize() { const n = Math.hypot(this.x, this.y, this.z) || 1; return this.multiplyScalar(1 / n); }
    multiplyScalar(k) { this.x *= k; this.y *= k; this.z *= k; return this; }
}

class Group {
    constructor() { this.children = []; }
    add(o) { this.children.push(o); }
    remove(o) { this.children = this.children.filter((c) => c !== o); }
}

const FakeTHREE = {
    Vector3: V3,
    SphereGeometry: class { dispose() { this.disposed = true; } },
    MeshBasicMaterial: class { constructor(o) { this.color = o.color; } dispose() { this.disposed = true; } },
    Mesh: class { constructor(g, m) { this.geometry = g; this.material = m; this.position = new V3(); } },
};

// Vertex k of each hemisphere sits at base position (k, 10*k, 100*k); the mesh order is reversed
// (local = n-1-subject) so a subject/local mix-up shows. get_position moves +1 in x per unit of mix.
function noFlatHost({ n = 4 } = {}) {
    const surfListeners = {};
    const base = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) { base[k * 3] = k; base[k * 3 + 1] = 10 * k; base[k * 3 + 2] = 100 * k; }
    const position = { count: n, array: base };
    const hemi = () => {
        const indexMap = {}, reverseIndexMap = {};
        for (let g = 0; g < n; g++) { indexMap[g] = n - 1 - g; reverseIndexMap[n - 1 - g] = g; }
        return { attributes: { position }, indexMap, reverseIndexMap };   // no uv
    };
    const toLocalPos = (local) => new V3(base[local * 3], base[local * 3 + 1], base[local * 3 + 2]);
    let mix = 1;   // the mix slider at its far end (inflated) — must NOT read as flat
    let nextPick = { vertex: 2, hemi: "right" };
    const labels = { left: { visible: true }, right: { visible: true } };
    const picker = {
        posdata: { left: { positions: [position] }, right: { positions: [position] } },
        markers: { left: new Group(), right: new Group() },
        uniforms: { thickmix: { value: 0.25 } },
        x: {}, lkdt: {}, rkdt: {},                       // pick buffers + kd-trees: built
        get_vertex_index(renderer, camera, x, y) {
            this.lastArgs = [x, y];
            this.labelsSeen = [labels.left.visible, labels.right.visible];
            return nextPick;
        },
    };
    const surface = {
        pivots: { left: { back: {} }, right: { back: {} } },
        hemis: { left: hemi(), right: hemi() },
        picker,
        svg: { labels },
        addEventListener(t, f) { (surfListeners[t] = surfListeners[t] || new Set()).add(f); },
        removeEventListener(t, f) { if (surfListeners[t]) surfListeners[t].delete(f); },
    };
    const viewer = {
        surfs: [{ surf: surface }],
        canvas: [{ getBoundingClientRect: () => ({ width: 100, height: 100 }) }],
        renderer: {}, camera: {},
        setMix: () => mix,
        renders: 0, schedule() { this.renders++; },
        addEventListener() {}, removeEventListener() {},
    };
    const mriview = {
        thickSeen: [],
        get_position(pd, surfmix, thickmix, i) {
            this.thickSeen.push(thickmix);
            const pos = toLocalPos(i).add(new V3(surfmix, 0, 0));
            return { pos, norm: new V3(0, 0, 2), base: toLocalPos(i) };
        },
    };
    return {
        viewer, surface, picker, mriview, surfListeners, labels,
        setMix(m) { mix = m; for (const f of surfListeners.mix || []) f({ mix: m }); },
        setPick(p) { nextPick = p; },
    };
}

function withGlobals(host, fn) {
    const saved = { THREE: globalThis.THREE, mriview: globalThis.mriview, svgoverlay: globalThis.svgoverlay };
    globalThis.THREE = FakeTHREE;
    globalThis.mriview = host.mriview;
    globalThis.svgoverlay = {};
    try { return fn(); } finally { Object.assign(globalThis, saved); }
}

test("no flatmap: the adapter attaches, hasFlat/isFlat are false even at the far end of the slider", () => {
    const host = noFlatHost();
    withGlobals(host, () => {
        const a = new PycortexAdapter(host.viewer);
        assert.strictEqual(a.hasFlat(), false);
        assert.strictEqual(a.isFlat(), false, "mix 1 on a no-flatmap viewer is inflated, not flat");
        assert.strictEqual(a.vertexUV({ h: "left", g: 0 }), null);
        a.destroy();
    });
});

test("no flatmap: points-only overlay sync succeeds; an ROI is refused loudly", () => {
    const host = noFlatHost();
    withGlobals(host, () => {
        const a = new PycortexAdapter(host.viewer);
        const pt = { kind: "point", name: "p", vert: { h: "left", g: 1 }, color: "#ff0000" };
        assert.strictEqual(a.setOverlayLayer("drawn", [pt]), true);
        assert.strictEqual(a.setOverlayLayer("drawn", []), true);
        assert.throws(() => a.setOverlayLayer("drawn", [pt, { kind: "roi", name: "r", left: [], right: [] }]), /flatmap/);
        a.destroy();
    });
});

test("pickVertex returns the picker's (reverse-mapped) vertex, its hemi, and its base position", () => {
    const host = noFlatHost();
    withGlobals(host, () => {
        const a = new PycortexAdapter(host.viewer);
        // vertex 2 on a 4-vertex mesh is geometry-local 1 -> base (1, 10, 100)
        assert.deepStrictEqual(a.pickVertex(10.4, 20.6), { h: "right", g: 2, xyz: [1, 10, 100] });
        assert.deepStrictEqual(host.picker.lastArgs, [10, 21], "picker gets integer canvas px");
        host.setPick(-1);
        assert.strictEqual(a.pickVertex(0, 0), null, "background -> null");
        host.setPick({ vertex: 1, hemi: "nowhere" });
        assert.strictEqual(a.pickVertex(0, 0), null);
        a.destroy();
    });
});

test("setPointMarkers places one marker per point in picker.markers[h] and follows the mix", () => {
    const host = noFlatHost();
    withGlobals(host, () => {
        const a = new PycortexAdapter(host.viewer);
        const ok = a.setPointMarkers([
            { vert: { h: "left", g: 0 }, color: "#00ff00" },
            { vert: { h: "right", g: 3 }, color: "bad;color" },
            { vert: { h: "right", g: 99 }, color: "#0000ff" },    // not in the mesh: skipped
        ]);
        assert.strictEqual(ok, 1, "one point (vertex 99) is not in the mesh, and is counted");
        const [l] = host.picker.markers.left.children, [r] = host.picker.markers.right.children;
        assert.strictEqual(host.picker.markers.right.children.length, 1);
        // subject 0 -> local 3 -> base (3, 30, 300); mix 1 adds +1 x; normal lift 0.5 along +z
        assert.deepStrictEqual([l.position.x, l.position.y, l.position.z], [4, 30, 300.5]);
        assert.strictEqual(l.material.color, "#00ff00");
        assert.strictEqual(r.material.color, "#ffffff", "an unsafe color falls back");
        host.setMix(0);
        assert.strictEqual(l.position.x, 3, "a mix event re-places the marker");
        // replacing the set removes the old markers
        a.setPointMarkers([{ vert: { h: "left", g: 1 }, color: "#00ff00" }]);
        assert.strictEqual(host.picker.markers.left.children.length, 1);
        assert.strictEqual(host.picker.markers.right.children.length, 0);
        a.destroy();
        assert.strictEqual(host.picker.markers.left.children.length, 0, "destroy removes every marker");
        assert.strictEqual((host.surfListeners.mix || new Set()).size, 0, "destroy unbinds the mix listener");
    });
});

test("setPointMarkers reports not-ready while the picker isn't built (only when there are points)", () => {
    const host = noFlatHost();
    withGlobals(host, () => {
        const a = new PycortexAdapter(host.viewer);
        delete host.surface.picker;
        assert.strictEqual(a.setPointMarkers([{ vert: { h: "left", g: 0 }, color: "#00ff00" }]), false);
        assert.strictEqual(a.setPointMarkers([]), 0, "no points need no picker: an ROI-only sync isn't held up");
        a.destroy();
    });
});

test("pick hides the overlay's label sprites during the pick and restores them", () => {
    const host = noFlatHost();
    withGlobals(host, () => {
        const a = new PycortexAdapter(host.viewer);
        host.labels.right.visible = false;            // a state that must come back as it was
        a.pickVertex(1, 1);
        assert.deepStrictEqual(host.picker.labelsSeen, [false, false], "labels hidden while picking");
        assert.deepStrictEqual([host.labels.left.visible, host.labels.right.visible], [true, false]);
        a.destroy();
    });
});

test("pickVertex guards: not-ready host, a non-integer vertex, a vertex missing from the mesh", () => {
    const host = noFlatHost();
    withGlobals(host, () => {
        const a = new PycortexAdapter(host.viewer);
        assert.strictEqual(a.canPick(), true);
        host.setPick({ vertex: 1.5, hemi: "left" });
        assert.strictEqual(a.pickVertex(0, 0), null);
        host.setPick({ vertex: 99, hemi: "left" });
        assert.deepStrictEqual(a.pickVertex(0, 0), { h: "left", g: 99, xyz: null });
        delete host.picker.lkdt;                       // kd-trees not built yet
        assert.strictEqual(a.canPick(), false, "still loading is not the same as missing the brain");
        delete host.viewer.renderer;
        assert.strictEqual(a.pickVertex(0, 0), null);
        a.destroy();
    });
});

test("vertexPosition: this mesh's base position, or null for a vertex it doesn't have", () => {
    const host = noFlatHost();
    withGlobals(host, () => {
        const a = new PycortexAdapter(host.viewer);
        assert.deepStrictEqual(a.vertexPosition({ h: "right", g: 2 }), [1, 10, 100]);
        assert.strictEqual(a.vertexPosition({ h: "right", g: 99 }), null);
        assert.strictEqual(a.vertexPosition({ h: "middle", g: 1 }), null);
        a.destroy();
    });
});

test("markers use the picker's thickmix, and render 8-digit hex colors opaque (r69 can't parse alpha)", () => {
    const host = noFlatHost();
    withGlobals(host, () => {
        const a = new PycortexAdapter(host.viewer);
        a.setPointMarkers([{ vert: { h: "left", g: 0 }, color: "#ff000080" }]);
        assert.strictEqual(host.mriview.thickSeen.at(-1), 0.25, "the host's live thickmix");
        assert.strictEqual(host.picker.markers.left.children[0].material.color, "#ff0000");
        delete host.picker.uniforms;
        host.setMix(0.5);
        assert.strictEqual(host.mriview.thickSeen.at(-1), 0.5, "falls back to the adapter's default");
        a.destroy();
    });
});

/* --- more points-v1 + draw-mode edges ---------------------------------------------------------- */

test("points-v1: null entries and a missing points array are skipped; an empty set exports []", () => {
    const t = new ShapeSet();
    assert.deepStrictEqual(t.loadJSON({ format: POINTS_FORMAT }), []);
    const added = t.loadJSON({ format: POINTS_FORMAT, points: [null, { hemi: "left", viewerVertex: 3 }] });
    assert.strictEqual(added.length, 1);
    assert.ok(/^#/.test(added[0].color), "an imported point without a color gets a palette color");
    assert.deepStrictEqual(new ShapeSet().toPointsJSON("s").points, []);
    const s = new ShapeSet();
    s.add({ kind: "point", name: "p", vert: { h: "left", g: 1 } });
    assert.strictEqual(s.toPointsJSON("s").points[0].xyz, null, "an unknown xyz round-trips as null");
});

test("draw-mode: the lasso is never live with the Point tool; choosing a flat tool in Display doesn't flatten", () => {
    const m = new DrawModeMachine();
    assert.strictEqual(m.setNeedsFlat(true, false).flatten, false, "Display mode: nothing to flatten for");
    m.enterDraw(false);
    assert.strictEqual(m.lassoActive(true, false), false, "Point tool: no lasso even when flat");
    m.setNeedsFlat(true, true);
    assert.strictEqual(m.lassoActive(true, false), true);
});
