/*
 * point-picker.test.js — the Point tool's click listener, on a fake canvas (no DOM). A click picks
 * at its release; a drag (the host rotating), a modifier/secondary button, a second pointer or a
 * pointercancel never picks; deactivating unbinds; a canvas that isn't there yet is retried.
 */
import test from "node:test";
import assert from "node:assert";
import { PointPicker } from "../ui/point-picker.js";

function fakeCanvas() {
    const L = {};
    return {
        L,
        classes: new Set(),
        addEventListener(t, f) { L[t] = f; },
        removeEventListener(t, f) { if (L[t] === f) delete L[t]; },
        classList: { add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, _s: null },
        getBoundingClientRect: () => ({ left: 10, top: 20 }),
    };
}

function setup(canvas = fakeCanvas()) {
    canvas.classList._s = canvas.classes;
    const picks = [];
    const p = new PointPicker({ canvas: () => canvas }, { onPick: (x, y) => picks.push([x, y]) });
    p.setActive(true);
    return { canvas, picks, p };
}

const ev = (o = {}) => ({ button: 0, pointerId: 1, clientX: 50, clientY: 60, ...o });

test("a click picks once, at its release, in canvas-relative px", () => {
    const { canvas, picks } = setup();
    canvas.L.pointerdown(ev());
    canvas.L.pointerup(ev({ clientX: 51 }));
    assert.deepStrictEqual(picks, [[41, 40]]);
});

test("a drag, a modifier, a secondary button, or a mismatched pointer never picks", () => {
    const { canvas, picks } = setup();
    canvas.L.pointerdown(ev()); canvas.L.pointerup(ev({ clientX: 80 }));            // drag: rotate
    canvas.L.pointerdown(ev({ shiftKey: true })); canvas.L.pointerup(ev());
    canvas.L.pointerdown(ev({ button: 2 })); canvas.L.pointerup(ev({ button: 2 }));
    canvas.L.pointerdown(ev()); canvas.L.pointerup(ev({ pointerId: 7 }));
    assert.deepStrictEqual(picks, []);
});

test("a second pointer (pinch) or a pointercancel ends the gesture without a pick", () => {
    const { canvas, picks } = setup();
    canvas.L.pointerdown(ev()); canvas.L.pointerdown(ev({ pointerId: 2 }));
    canvas.L.pointerup(ev({ pointerId: 2 })); canvas.L.pointerup(ev());
    canvas.L.pointerdown(ev()); canvas.L.pointercancel(ev()); canvas.L.pointerup(ev());
    assert.deepStrictEqual(picks, []);
});

test("two quick clicks are two picks (no deferral to lose one)", () => {
    const { canvas, picks } = setup();
    for (let i = 0; i < 2; i++) { canvas.L.pointerdown(ev()); canvas.L.pointerup(ev()); }
    assert.strictEqual(picks.length, 2);
});

test("deactivating unbinds every listener and the cursor class", () => {
    const { canvas, p } = setup();
    assert.ok(canvas.classes.has("roidraw-pointpick"));
    p.setActive(false);
    assert.deepStrictEqual(Object.keys(canvas.L), []);
    assert.ok(!canvas.classes.has("roidraw-pointpick"));
});

test("no canvas yet: stays inactive, and a later setActive(true) binds", () => {
    let el = null;
    const canvas = fakeCanvas();
    canvas.classList._s = canvas.classes;
    const p = new PointPicker({ canvas: () => el }, {});
    p.setActive(true);
    assert.strictEqual(p.active, false);
    el = canvas;
    p.setActive(true);
    assert.strictEqual(p.active, true);
    assert.ok(canvas.L.pointerup, "listeners bound on the retry");
});
