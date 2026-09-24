/*
 * host-preflight.test.js — the adapter against a synthetic pycortex host. roidraw reaches into
 * pycortex internals; if pycortex drifts (renames get_position, restructures the surface, …) we
 * want a LOUD, specific error at attach time, not silent wrongness. preflightHost inspects the host
 * and reports exactly which expected capability is missing; surfaceReady (autoAttach's poll) must
 * agree with it. Further down, a constructed PycortexAdapter on a DOM-free fake host checks the
 * overlay layer's registration, its host-facing showhide, the control-panel folder, and teardown.
 */
import test, { mock } from "node:test";
import assert from "node:assert";
import { preflightHost, surfaceReady, PycortexAdapter } from "../adapter/pycortex-adapter.js";
import { safeColor } from "../adapter/pycortex-overlay.js";
import { HEMIS } from "../core/hemis.js";

// a fully-compatible synthetic host (no THREE/DOM — just the shape the adapter requires)
function goodHost() {
    const surface = { pivots: {}, hemis: {} };
    for (const h of HEMIS) surface.hemis[h] = { attributes: { position: {}, uv: {} } };
    return {
        THREE: {},
        mriview: { get_position() {} },
        svgoverlay: {},
        viewer: { surfs: [{ surf: surface }] },
    };
}

test("preflight passes a compatible host", () => {
    const r = preflightHost(goodHost());
    assert.strictEqual(r.ok, true, "compatible host should pass; missing=" + JSON.stringify(r.missing));
    assert.deepStrictEqual(r.missing, []);
});

test("preflight flags a missing THREE", () => {
    const h = goodHost(); h.THREE = undefined;
    const r = preflightHost(h);
    assert.strictEqual(r.ok, false);
    assert.ok(r.missing.some((m) => /THREE/.test(m)), "should name THREE; got " + JSON.stringify(r.missing));
});

test("preflight flags a renamed/absent mriview.get_position", () => {
    const h = goodHost(); h.mriview = { get_position: undefined };
    const r = preflightHost(h);
    assert.strictEqual(r.ok, false);
    assert.ok(r.missing.some((m) => /get_position/.test(m)), "should name get_position; got " + JSON.stringify(r.missing));
});

test("preflight flags a viewer with no locatable Surface", () => {
    const h = goodHost(); h.viewer = { surfs: [] };
    const r = preflightHost(h);
    assert.strictEqual(r.ok, false);
    assert.ok(r.missing.some((m) => /Surface/i.test(m)), "should name the Surface; got " + JSON.stringify(r.missing));
});

test("preflight flags a surface missing its position attribute", () => {
    const h = goodHost();
    h.viewer.surfs[0].surf.hemis.left.attributes = { uv: {} };   // uv present, position gone
    const r = preflightHost(h);
    assert.strictEqual(r.ok, false);
    assert.ok(r.missing.some((m) => /position/.test(m)), "should name the position attribute; got " + JSON.stringify(r.missing));
});

test("preflight flags a surface missing its uv attribute (the uv path would fail silently)", () => {
    const h = goodHost();
    delete h.viewer.surfs[0].surf.hemis.left.attributes.uv;   // position present, uv gone
    const r = preflightHost(h);
    assert.strictEqual(r.ok, false);
    assert.ok(r.missing.some((m) => /uv/.test(m)), "should name the uv attribute; got " + JSON.stringify(r.missing));
});

test("preflight flags a missing right hemisphere (projection iterates both)", () => {
    const h = goodHost();
    delete h.viewer.surfs[0].surf.hemis.right;
    const r = preflightHost(h);
    assert.strictEqual(r.ok, false);
    assert.ok(r.missing.some((m) => /right/i.test(m)), "should name the right hemi; got " + JSON.stringify(r.missing));
});

test("preflight accumulates ALL problems, not just the first", () => {
    const r = preflightHost({ THREE: undefined, mriview: undefined, svgoverlay: undefined, viewer: { surfs: [] } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.missing.length >= 3, "should report several missing capabilities; got " + JSON.stringify(r.missing));
});

test("surfaceReady agrees with preflight's surface checks (the poll never attaches too early)", () => {
    assert.strictEqual(surfaceReady(goodHost().viewer), true);
    for (const breakIt of [
        (surf) => { delete surf.hemis.right; },
        (surf) => { delete surf.hemis.left.attributes.uv; },
        (surf) => { delete surf.hemis.right.attributes.position; },
    ]) {
        const h = goodHost();
        breakIt(h.viewer.surfs[0].surf);
        assert.strictEqual(preflightHost(h).ok, false);
        assert.strictEqual(surfaceReady(h.viewer), false, "surfaceReady passed a surface preflight rejects");
    }
    assert.strictEqual(surfaceReady({ surfs: [] }), false);
});

test("safeColor accepts only 3/4/6/8-digit hex literals", () => {
    for (const c of ["#abc", "#abcd", "#A1B2C3", "#a1b2c3d4"]) assert.strictEqual(safeColor(c), c);
    for (const c of ["#abcde", "#abcdef1", "#ab", "red", "#fff;fill:red", "", null, 3])
        assert.strictEqual(safeColor(c), "#ffffff", "should reject " + JSON.stringify(c));
});

/* --- a constructed adapter on a DOM-free fake host ---------------------------------------- */

function fakeEl() {
    return {
        attrs: {}, children: [], style: {}, parentNode: null,
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    };
}

class FakeLabels {
    constructor() {
        this.shader = { uniforms: { depth: {}, scale: { value: { set() {} } } } };
        this.meshes = { left: {}, right: {} };
    }
    setMix() {}
    showhide() {}
}

// A host the adapter constructs against: one surface with a loaded SVG overlay and a menu.
function fakeHost() {
    const listeners = {};
    const svgRoot = fakeEl();
    svgRoot.ownerDocument = { createElementNS: () => fakeEl(), createTextNode: (t) => ({ t }) };
    svgRoot.setAttribute("viewBox", "0 0 200 100");
    const noopGroup = { add() {}, remove() {} };
    const svgo = {
        svg: svgRoot, posdata: {}, depth: {}, layers: {}, labels: { left: noopGroup, right: noopGroup },
        updates: 0, update() { this.updates++; },
        folders: [], ui: { addFolder(name) { const f = { name, add(o) { f.bound = o; } }; svgo.folders.push(f); return f; } },
    };
    svgo.sulci = { showhide() {} };
    const position = { count: 4 };
    const hemi = () => ({ attributes: { position, uv: { array: new Float32Array(8) } }, indexMap: {}, reverseIndexMap: [] });
    const surface = {
        pivots: { left: { back: {} }, right: { back: {} } },
        hemis: { left: hemi(), right: hemi() },
        picker: { posdata: { left: { positions: [position] }, right: { positions: [position] } } },
        svg: svgo,
    };
    const viewer = {
        surfs: [{ surf: surface }],
        canvas: [{ getBoundingClientRect: () => ({ width: 100, height: 100 }) }],
        setMix: () => 1,
        addEventListener(t, f) { (listeners[t] = listeners[t] || new Set()).add(f); },
        removeEventListener(t, f) { if (listeners[t]) listeners[t].delete(f); },
    };
    return { viewer, svgo, listeners };
}

function withHostGlobals(fn) {
    const saved = { THREE: globalThis.THREE, mriview: globalThis.mriview, svgoverlay: globalThis.svgoverlay };
    globalThis.THREE = { Vector3: class {} };
    globalThis.mriview = { get_position() {} };
    globalThis.svgoverlay = { Labels: FakeLabels };
    try { return fn(); } finally { Object.assign(globalThis, saved); }
}

const SULCUS = { kind: "sulcus", name: "CS", labelVert: { h: "right", g: 1 },
    bezier: { anchors: [[0, 0], [1, 1]], inHandles: [[0, 0], [1, 1]], outHandles: [[0, 0], [1, 1]], closed: false } };

test("replacing the layer unregisters it under the name it was registered with", () => withHostGlobals(() => {
    const { viewer, svgo } = fakeHost();
    const a = new PycortexAdapter(viewer);
    assert.strictEqual(a.setOverlayLayer("first", [SULCUS]), true);
    assert.ok(svgo.layers.first && svgo.first);
    a.setOverlayLayer("second", [SULCUS]);
    assert.strictEqual(svgo.layers.first, undefined, "stale registration left behind");
    assert.strictEqual(svgo.first, undefined);
    assert.ok(svgo.layers.second);
    assert.strictEqual(svgo.svg.children.length, 1, "exactly one drawn layer element");
    const text = svgo.svg.children[0].children[1].children[0];
    assert.strictEqual(text.attrs["data-ptidx"], "5", "right-hemi label ptidx = left vertex count + g");
}));

test("the host's showhide on the layer goes through setLayerVisible (state + re-raster)", () => withHostGlobals(() => {
    const { viewer, svgo } = fakeHost();
    const a = new PycortexAdapter(viewer);
    a.setOverlayLayer("drawn", [SULCUS]);
    const layer = svgo.layers.drawn, before = svgo.updates;
    layer.showhide(false);
    assert.strictEqual(layer.showhide(), false);
    assert.strictEqual(layer.layer.style.display, "none");
    assert.strictEqual(layer._hidden, true);
    assert.strictEqual(svgo.updates, before + 1, "hiding must re-rasterize the texture");
    layer.showhide(false);
    assert.strictEqual(svgo.updates, before + 1, "an unchanged state must not re-rasterize");
    // the state survives a rebuild: the next layer is born hidden
    a.setOverlayLayer("drawn", [SULCUS]);
    assert.match(svgo.layers.drawn.layer.attrs.style, /display:none/);
    const toggle = svgo.folders[0].bound.visible.action[0];
    assert.strictEqual(toggle.f, false, "the control-panel toggle reads the same state");
}));

test("re-attaching rebinds the one control-panel folder instead of adding a duplicate", () => withHostGlobals(() => {
    const { viewer, svgo } = fakeHost();
    const a = new PycortexAdapter(viewer);
    a.setOverlayLayer("drawn", [SULCUS]);
    a.setOverlayLayer("drawn", []);
    a.destroy();
    const b = new PycortexAdapter(viewer);
    b.setOverlayLayer("drawn", [SULCUS]);
    assert.strictEqual(svgo.folders.length, 1, "a second attach added a second folder");
    const toggle = svgo.folders[0].bound.visible.action[0];
    toggle.f = false;
    assert.strictEqual(svgo.layers.drawn.showhide(), false, "the folder drives the live adapter");
    b.destroy();
    toggle.f = true;   // bound to nothing now: a no-op, not a call into a dead adapter
    assert.strictEqual(toggle.f, false);
}));

test("after a re-attach the folder follows the new adapter before it has drawn anything", () => withHostGlobals(() => {
    const { viewer, svgo } = fakeHost();
    const a = new PycortexAdapter(viewer);
    a.setOverlayLayer("drawn", [SULCUS]);
    a.destroy();
    const b = new PycortexAdapter(viewer);
    b.setOverlayLayer("drawn", []);            // the new drawer's first sync: an empty model
    const toggle = svgo.folders[0].bound.visible.action[0];
    assert.strictEqual(toggle.f, true, "the toggle reads the live adapter, not the destroyed one");
    toggle.f = false;
    assert.strictEqual(b._overlay.layerHidden, true);
}));

test("applyHostDefaults' setData listener is removed after the startup window, and by destroy()", () => withHostGlobals(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const { viewer, listeners } = fakeHost();
        const a = new PycortexAdapter(viewer);
        a.applyHostDefaults();
        assert.strictEqual(listeners.setData.size, 1);
        mock.timers.tick(8000);
        assert.strictEqual(listeners.setData.size, 0, "listener outlived the collapse window");

        const b = new PycortexAdapter(viewer);
        b.applyHostDefaults();
        assert.strictEqual(listeners.setData.size, 1);
        b.destroy();
        b.destroy();   // idempotent
        assert.strictEqual(listeners.setData.size, 0);
    } finally { mock.timers.reset(); }
}));
