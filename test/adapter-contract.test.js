/*
 * adapter-contract.test.js — guards the ViewerAdapter CONTRACT. If a method is added to the
 * contract, the real PycortexAdapter must implement all of it and the FakeSurfaceAdapter must
 * implement at least every REQUIRED method (the ones whose base impl throws). This catches the
 * silent "we extended the interface but forgot one adapter" drift — for our own contract.
 */
import test from "node:test";
import assert from "node:assert";
import { ViewerAdapter } from "../adapter/viewer-adapter.js";
import { PycortexAdapter } from "../adapter/pycortex-adapter.js";
import { FakeSurfaceAdapter } from "./fake-adapter.js";

const contractMethods = () =>
    Object.getOwnPropertyNames(ViewerAdapter.prototype)
        .filter((n) => n !== "constructor" && typeof ViewerAdapter.prototype[n] === "function");

test("the declared REQUIRED set matches the methods that actually throw (the list can't drift)", () => {
    // cross-check the hand-maintained ViewerAdapter.REQUIRED against the source of truth: a required
    // method is exactly one whose base impl throws. Catches the list and the stubs falling out of sync.
    const throwers = contractMethods().filter((n) => ViewerAdapter.prototype[n].toString().includes("throw"));
    assert.deepStrictEqual([...ViewerAdapter.REQUIRED].sort(), throwers.sort(),
        "ViewerAdapter.REQUIRED is out of sync with the methods that throw");
});

test("PycortexAdapter overrides EVERY ViewerAdapter contract method", () => {
    for (const n of contractMethods()) {
        assert.strictEqual(typeof PycortexAdapter.prototype[n], "function", `PycortexAdapter missing ${n}`);
        assert.notStrictEqual(PycortexAdapter.prototype[n], ViewerAdapter.prototype[n],
            `PycortexAdapter.${n} is still the contract stub — not implemented`);
    }
});

test("FakeSurfaceAdapter overrides every REQUIRED contract method", () => {
    for (const n of ViewerAdapter.REQUIRED) {
        assert.strictEqual(typeof ViewerAdapter.prototype[n], "function", `REQUIRED names a nonexistent method ${n}`);
        assert.notStrictEqual(FakeSurfaceAdapter.prototype[n], ViewerAdapter.prototype[n],
            `FakeSurfaceAdapter is missing required contract method ${n}`);
    }
});
