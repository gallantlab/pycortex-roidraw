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
// The two modes. The string values are part of the public surface — ROIDrawer.setMode() accepts
// them (the mode toggle's buttons send them) and ROIDrawer.mode returns them — so they must stay
// "display"/"draw"; the consts just name them so no caller spells a mode as a bare literal.
export const MODE = { DISPLAY: "display", DRAW: "draw" };

// The two draw tools: what a plain drag produces. A lasso is a closed ROI; a trace is an open
// sulcus. The panel's selector, the lasso overlay and the controller's status line all name the
// tool through these, and `asTool` is the one normalization (anything that isn't TRACE is LASSO).
export const TOOL = { LASSO: "lasso", TRACE: "trace" };
export const asTool = (t) => (t === TOOL.TRACE ? TOOL.TRACE : TOOL.LASSO);

export class DrawModeMachine {
    constructor() {
        this.mode = MODE.DISPLAY;
        this.sawFlat = false;
    }

    enterDraw() {
        this.mode = MODE.DRAW;
        this.sawFlat = false;   // re-arm: the flatten glide's non-flat frames must not bounce us out
        return { flatten: true };
    }

    enterDisplay() {
        this.mode = MODE.DISPLAY;
        return {};
    }

    // A surface morph frame. In Draw: reaching flat arms the latch; a non-flat frame once the
    // latch is armed means the user inflated, so the caller should drop back to Display.
    noteMix(isFlat) {
        if (this.mode === MODE.DRAW) {
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
        return this.mode === MODE.DRAW && isFlat && !editing;
    }
}
