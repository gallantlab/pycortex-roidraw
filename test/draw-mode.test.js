import test from "node:test";
import assert from "node:assert";
import { DrawModeMachine } from "../core/draw-mode.js";

// The DrawModeMachine is the pure state machine behind roidraw's flat-only Draw mode.
// It owns exactly two pieces of state — the current mode ("display"|"draw") and the
// "have we actually reached flat since the last flatten-for-draw" latch — and decides:
//   - when entering Draw should the surface flatten,
//   - whether an incoming mix frame means "the user inflated, drop back to Display",
//   - whether starting an edit needs a re-flatten,
//   - whether lasso capture should be live.
// The point of the latch is that the flatten glide emits many *non-flat* mix frames on
// its way to flat; those must NOT be read as "the user inflated" and bounce us out.

test("starts in display mode, latch down", () => {
    const m = new DrawModeMachine();
    assert.strictEqual(m.mode, "display");
    assert.strictEqual(m.sawFlat, false);
});

test("entering Draw switches mode and requests a flatten", () => {
    const m = new DrawModeMachine();
    const r = m.enterDraw();
    assert.strictEqual(m.mode, "draw");
    assert.strictEqual(r.flatten, true, "entering Draw must request a flatten");
    assert.strictEqual(m.sawFlat, false, "latch resets so the glide doesn't bounce us out");
});

test("the flatten glide does NOT bounce us out of Draw", () => {
    // This is the whole reason the latch exists. After enterDraw() requests a flatten,
    // the surface emits a run of non-flat mix frames before it arrives at flat. None of
    // them may exit Draw, because we have not yet reached flat.
    const m = new DrawModeMachine();
    m.enterDraw();
    for (let i = 0; i < 5; i++) {
        assert.strictEqual(m.noteMix(false).exit, false, `glide frame ${i} must not exit`);
        assert.strictEqual(m.mode, "draw");
    }
    // ...and the moment it reaches flat, the latch arms.
    assert.strictEqual(m.noteMix(true).exit, false);
    assert.strictEqual(m.sawFlat, true);
});

test("inflating AFTER reaching flat drops back to Display", () => {
    const m = new DrawModeMachine();
    m.enterDraw();
    m.noteMix(true);                       // reached flat, latch armed
    const r = m.noteMix(false);            // user drags the unfold slider
    assert.strictEqual(r.exit, true, "a non-flat frame after flat means the user inflated → exit");
});

test("mix frames are inert while in Display mode", () => {
    const m = new DrawModeMachine();
    assert.strictEqual(m.noteMix(false).exit, false);
    assert.strictEqual(m.noteMix(true).exit, false);
    assert.strictEqual(m.mode, "display");
});

test("re-entering Draw re-arms the latch (a stale sawFlat can't bounce the next entry)", () => {
    const m = new DrawModeMachine();
    m.enterDraw();
    m.noteMix(true);                       // sawFlat = true
    m.enterDisplay();
    m.enterDraw();                         // fresh entry
    assert.strictEqual(m.sawFlat, false, "latch must reset on every Draw entry");
    assert.strictEqual(m.noteMix(false).exit, false, "first glide frame of the new entry must not exit");
});

test("starting an edit on an inflated surface requests a re-flatten and re-arms the latch", () => {
    const m = new DrawModeMachine();
    m.enterDraw();
    m.noteMix(true);                       // flat, latch armed
    // pretend the surface somehow inflated; user clicks edit on an ROI
    const r = m.noteEditStart(false);
    assert.strictEqual(r.flatten, true);
    assert.strictEqual(m.sawFlat, false, "re-flatten resets the latch so its own glide doesn't exit");
});

test("starting an edit while already flat does not re-flatten", () => {
    const m = new DrawModeMachine();
    m.enterDraw();
    m.noteMix(true);
    const r = m.noteEditStart(true);
    assert.strictEqual(r.flatten, false);
    assert.strictEqual(m.sawFlat, true, "already flat → latch stays armed");
});

test("lasso is live only in Draw, flat, and not editing", () => {
    const m = new DrawModeMachine();
    // display mode → never
    assert.strictEqual(m.lassoActive(true, false), false);
    m.enterDraw();
    assert.strictEqual(m.lassoActive(false, false), false, "not flat yet → no lasso");
    assert.strictEqual(m.lassoActive(true, true), false, "editing → no lasso");
    assert.strictEqual(m.lassoActive(true, false), true, "draw + flat + not editing → lasso live");
});
