/*
 * draw-mode.js — the pure state machine behind roidraw's flat-only Draw mode.
 *
 * No DOM, no adapter, no THREE: it owns only the mode and the "reached flat since the last
 * flatten-for-draw" latch, and turns surface/UI events into decisions the controller acts on.
 * Extracted from the controller so the latch — which guards against the flatten glide's own
 * transient non-flat frames bouncing the user out of Draw — is testable in isolation.
 *
 * Decisions returned to the caller:
 *   enterDraw()            -> { flatten }  request a flatten (drawing is flat-only)
 *   noteMix(isFlat)        -> { exit }     true => the user inflated; caller drops to Display
 *   noteEditStart(isFlat)  -> { flatten }  re-flatten if an edit starts while inflated
 *   lassoActive(isFlat, editing) -> bool   capture is live only in Draw + flat + not editing
 */
export class DrawModeMachine {
    constructor() {
        this.mode = "display";
        this.sawFlat = false;
    }

    enterDraw() {
        this.mode = "draw";
        this.sawFlat = false;   // re-arm: the flatten glide's non-flat frames must not bounce us out
        return { flatten: true };
    }

    enterDisplay() {
        this.mode = "display";
        return {};
    }

    // A surface morph frame. In Draw: reaching flat arms the latch; a non-flat frame once the
    // latch is armed means the user inflated, so the caller should drop back to Display.
    noteMix(isFlat) {
        if (this.mode === "draw") {
            if (isFlat) this.sawFlat = true;
            else if (this.sawFlat) return { exit: true };
        }
        return { exit: false };
    }

    // Starting an edit happens on the flatmap; if the surface is inflated we re-flatten first
    // (which re-arms the latch so that flatten's own glide doesn't trip noteMix's exit).
    noteEditStart(isFlat) {
        if (!isFlat) { this.sawFlat = false; return { flatten: true }; }
        return { flatten: false };
    }

    lassoActive(isFlat, editing) {
        return this.mode === "draw" && isFlat && !editing;
    }
}
