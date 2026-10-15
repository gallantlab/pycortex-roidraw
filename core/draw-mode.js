/*
 * draw-mode.js — the pure state machine behind roidraw's Draw mode (flat-only for ROIs + sulci).
 *
 * No DOM, no adapter, no THREE: it owns only the mode and the "reached flat since the last
 * flatten-for-draw" latch, and turns surface/UI events into decisions the controller acts on.
 * Keeping it out of the controller makes the latch — which guards against the flatten glide's own
 * transient non-flat frames bouncing the user out of Draw — testable in isolation.
 *
 * Decisions returned to the caller:
 *   enterDraw(needsFlat)   -> { flatten }  request a flatten (ROI/sulcus drawing is flat-only)
 *   enterDisplay()         -> {}           nothing to do beyond the mode change
 *   setNeedsFlat(needsFlat, isFlat) -> { flatten }  the tool changed; a flat tool on an inflated
 *                                           surface re-flattens (a point needs no flat)
 *   noteMix(isFlat)        -> { exit }     true => the user inflated under a flat tool; drop to Display
 *   noteEditStart(isFlat)  -> { flatten }  re-flatten if an edit starts while inflated
 *   lassoActive(isFlat, editing) -> bool   capture is live only in Draw + a flat tool + flat + not editing
 */
// The two modes. The string values are part of the public surface — ROIDrawer.setMode() accepts
// them (the mode toggle's buttons send them) and ROIDrawer.mode returns them — so they must stay
// "display"/"draw"; the consts just name them so no caller spells a mode as a bare literal.
export const MODE = { DISPLAY: "display", DRAW: "draw" };

// The draw tools. A lasso drag is a closed ROI; a trace drag is an open sulcus; a click with POINT
// marks one vertex. The panel's selector, the lasso overlay and the controller's status line all
// name the tool through these, and `asTool` is the one normalization (anything unknown is LASSO).
// LASSO and TRACE draw on the flatmap; POINT picks on the surface at any unfold mix.
export const TOOL = { LASSO: "lasso", TRACE: "trace", POINT: "point" };
export const asTool = (t) => (t === TOOL.TRACE || t === TOOL.POINT ? t : TOOL.LASSO);
export const toolNeedsFlat = (t) => asTool(t) !== TOOL.POINT;

export class DrawModeMachine {
    constructor() {
        this.mode = MODE.DISPLAY;
        this.sawFlat = false;
        this.needsFlat = true;  // whether the active tool draws on the flatmap
    }

    enterDraw(needsFlat = true) {
        this.mode = MODE.DRAW;
        this.needsFlat = needsFlat;
        this.sawFlat = false;   // re-arm: the flatten glide's non-flat frames must not bounce us out
        return { flatten: needsFlat };
    }

    // The active tool changed. Switching to a flat tool while inflated in Draw re-flattens (and
    // re-arms the latch so that glide doesn't exit); switching to it while already flat arms the
    // latch, so a later inflate exits as usual. A non-flat tool (POINT) never flattens or exits.
    setNeedsFlat(needsFlat, isFlat) {
        this.needsFlat = needsFlat;
        if (this.mode !== MODE.DRAW || !needsFlat) return { flatten: false };
        this.sawFlat = isFlat;
        return { flatten: !isFlat };
    }

    enterDisplay() {
        this.mode = MODE.DISPLAY;
        return {};
    }

    // A surface morph frame. In Draw: reaching flat arms the latch; a non-flat frame once the
    // latch is armed means the user inflated, so the caller should drop back to Display.
    noteMix(isFlat) {
        if (this.mode === MODE.DRAW && this.needsFlat) {
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
        return this.mode === MODE.DRAW && this.needsFlat && isFlat && !editing;
    }
}
