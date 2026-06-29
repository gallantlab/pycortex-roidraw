/*
 * host-preflight.test.js — the adapter's runtime compatibility check. roidraw reaches into pycortex
 * internals; if pycortex drifts (renames get_position, restructures the surface, …) we want a LOUD,
 * specific error at attach time, not silent wrongness. preflightHost inspects the host and reports
 * exactly which expected capability is missing.
 */
import test from "node:test";
import assert from "node:assert";
import { preflightHost } from "../adapter/pycortex-adapter.js";

// a fully-compatible synthetic host (no THREE/DOM — just the shape the adapter requires)
function goodHost() {
    const surface = {
        pivots: {},
        hemis: {
            left: { attributes: { position: {} } },
            right: { attributes: { position: {} } },
        },
    };
    surface.hemis.left.attributes.uv = {};
    surface.hemis.right.attributes.uv = {};
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
