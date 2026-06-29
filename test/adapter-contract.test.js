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

// "required" = the contract impl throws (no sensible default); "optional niceties" have defaults.
const isRequired = (n) => ViewerAdapter.prototype[n].toString().includes("throw new Error");

test("the contract exposes a non-trivial set of methods (sanity)", () => {
    assert.ok(contractMethods().length >= 20, "expected the documented ViewerAdapter surface");
});

test("PycortexAdapter overrides EVERY ViewerAdapter contract method", () => {
    for (const n of contractMethods()) {
        assert.strictEqual(typeof PycortexAdapter.prototype[n], "function", `PycortexAdapter missing ${n}`);
        assert.notStrictEqual(PycortexAdapter.prototype[n], ViewerAdapter.prototype[n],
            `PycortexAdapter.${n} is still the contract stub — not implemented`);
    }
});

test("FakeSurfaceAdapter overrides every REQUIRED contract method", () => {
    for (const n of contractMethods()) {
        if (!isRequired(n)) continue;
        assert.notStrictEqual(FakeSurfaceAdapter.prototype[n], ViewerAdapter.prototype[n],
            `FakeSurfaceAdapter is missing required contract method ${n}`);
    }
});
