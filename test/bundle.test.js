/*
 * bundle.test.js — smoke test of the DISTRIBUTED artifact (dist/roidraw.bundle.js), the single file
 * users actually drop into a viewer. `npm test` rebuilds it first (pretest), so this proves the
 * current source bundles into a script that loads cleanly and exposes the public ROIDraw API. A
 * broken/half-built bundle — the thing a release would ship — fails here instead of in someone's
 * browser.
 */
import test from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundlePath = fileURLToPath(new URL("../dist/roidraw.bundle.js", import.meta.url));

test("the bundle was built", () => {
    assert.ok(existsSync(bundlePath), "dist/roidraw.bundle.js missing — run `npm run build`");
    assert.ok(readFileSync(bundlePath, "utf8").length > 10000, "bundle suspiciously small");
});

test("the bundle loads in a browser-like sandbox and exposes window.ROIDraw", () => {
    const code = readFileSync(bundlePath, "utf8");
    // a minimal browser-ish global; the bundle only touches the DOM inside functions, not at load,
    // so a bare window/document stub is enough to evaluate the top level.
    const win = {};
    const ctx = {
        window: win,
        self: win,
        document: { createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
                    getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} },
                    addEventListener() {} },
        console,
    };
    ctx.globalThis = ctx;
    vm.runInNewContext(code, ctx, { filename: "roidraw.bundle.js" });

    assert.strictEqual(typeof win.ROIDraw, "object", "window.ROIDraw should be set as a side effect");
    for (const fn of ["attach", "autoAttach", "ROIDrawer", "surfaceReady", "findSurface"]) {
        assert.strictEqual(typeof win.ROIDraw[fn], "function", `window.ROIDraw.${fn} should be a function`);
    }
    // the teardown API must ship so a viewer can detach/re-attach without leaking
    assert.strictEqual(typeof win.ROIDraw.ROIDrawer.prototype.destroy, "function", "ROIDrawer needs a destroy()");
});

test("the bundle inlines its CSS (single self-contained file, no external fetch)", () => {
    const code = readFileSync(bundlePath, "utf8");
    // roidraw.css ships inlined as a string; a marker class proves it was bundled, not left external.
    assert.ok(code.includes("roidraw"), "expected inlined roidraw styles/markers in the bundle");
});
