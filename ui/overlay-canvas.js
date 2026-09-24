/*
 * overlay-canvas.js — the transparent 2D <canvas> that roidraw lays over the host's WebGL canvas.
 * Base class for LassoOverlay (capturing a stroke) and BezierEditOverlay (editing a curve). It owns
 * what both share:
 *   - the canvas itself, kept the same size and position as the surface canvas (a ResizeObserver
 *     catches size changes that aren't window resizes; the window resize listener catches the canvas
 *     moving without changing size);
 *   - pointer wiring: a primary-button pointerdown starts a gesture and captures the pointer, so a
 *     drag that leaves the canvas keeps tracking and ends only on pointerup; pointercancel (or a
 *     lost capture) cancels the gesture instead of committing it;
 *   - wheel -> adapter.zoom, and the Shift/empty-space pan-drag bookkeeping (click vs drag by the
 *     shared CLICK_SLOP rule);
 *   - the cursor, as one of the mutually exclusive `roidraw-overlay--draw|grab|grabbing` classes
 *     whose cursors live in roidraw.css;
 *   - teardown.
 * Host-agnostic — it only asks the adapter where the surface canvas is and to pan/zoom.
 *
 * Subclass hooks (all optional except where noted):
 *   _wantsInput()             -> bool: take pointer/wheel input at all right now (required).
 *   _pointerDown(e, pt)       -> bool: start a gesture at `pt`; return false to decline it.
 *   _pointerMove(e, pt)       a move; `this._pointerId` is non-null while a gesture is in flight.
 *   _pointerUp(e, pt)         the gesture's pointer was released (commit).
 *   _pointerCancel()          the gesture was interrupted (discard).
 *   _pointerLeave()           the pointer left the canvas with no gesture in flight.
 *   _viewChanged()            the camera was just panned or zoomed.
 */
import { movedPast } from "./overlay-geom.js";

const CURSORS = ["draw", "grab", "grabbing"];

export class CanvasOverlay {
    constructor(adapter, className) {
        this.adapter = adapter;
        const el = document.createElement("canvas");
        el.className = className;
        document.body.appendChild(el);
        this.el = el;
        this.ctx = el.getContext("2d");
        this._pointerId = null;     // the captured pointer while a gesture is in flight, else null
        this._pan = null;           // { down, last, moved } while a pan-drag is in flight, else null

        el.addEventListener("pointerdown", (e) => this._onPointerDown(e));
        el.addEventListener("pointermove", (e) => {
            if (this._pointerId === null || e.pointerId === this._pointerId) this._pointerMove(e, this._evtPt(e));
        });
        el.addEventListener("pointerup", (e) => {
            if (e.pointerId !== this._pointerId) return;
            this._pointerId = null;
            this._pointerUp(e, this._evtPt(e));
        });
        const cancel = (e) => {
            if (e.pointerId !== this._pointerId) return;   // lostpointercapture also follows a normal pointerup
            this._pointerId = null;
            this._pointerCancel();
        };
        el.addEventListener("pointercancel", cancel);
        el.addEventListener("lostpointercapture", cancel);
        el.addEventListener("pointerleave", () => { if (this._pointerId === null) this._pointerLeave(); });
        el.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });

        // Subclasses decide what a resize means (re-measure only, or re-measure + reproject).
        this._onResize = () => this.onResize();
        window.addEventListener("resize", this._onResize);
        if (typeof ResizeObserver !== "undefined") {
            this._resizeObs = new ResizeObserver(this._onResize);   // also fires once on observe()
            this._resizeObs.observe(adapter.canvas());
        }
    }

    /* What a surface-canvas resize does; the default just re-measures. */
    onResize() { this.syncRect(); }

    /* Match the host canvas's screen rect. Assigning canvas.width/height clears the bitmap and
     * resets the 2D context, so it happens only on an actual size change (the edit overlay calls
     * this every tracking frame, where the size rarely changes). */
    syncRect() {
        if (!this.el) return;
        const r = this.adapter.canvas().getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
        this.el.style.left = Math.round(r.left) + "px";
        this.el.style.top = Math.round(r.top) + "px";
        this.el.style.width = w + "px";
        this.el.style.height = h + "px";
        if (this.el.width !== w || this.el.height !== h) { this.el.width = w; this.el.height = h; }
    }

    /* A pointer event's position in overlay px (the overlay rect == the surface canvas rect). */
    _evtPt(e) {
        const r = this.el.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    _clearCanvas() { if (this.ctx) this.ctx.clearRect(0, 0, this.el.width, this.el.height); }

    /* Show one of the CURSORS (styled in roidraw.css), or the default arrow for null. */
    _setCursor(kind) {
        for (const c of CURSORS) this.el.classList.toggle("roidraw-overlay--" + c, c === kind);
    }

    _onPointerDown(e) {
        // Primary button only (right/middle clicks never start a gesture), one gesture at a time.
        if (e.button !== 0 || this._pointerId !== null || !this._wantsInput()) return;
        if (!this._pointerDown(e, this._evtPt(e))) return;
        e.preventDefault();
        this._pointerId = e.pointerId;
        this.el.setPointerCapture(e.pointerId);
    }

    /* End an in-flight gesture from code (not from the pointer): drop and release the capture so the
     * rest of that drag goes back to the host and the next pointerdown isn't refused. Clearing
     * _pointerId first keeps the lostpointercapture this triggers from firing _pointerCancel. */
    _releasePointer() {
        const id = this._pointerId;
        if (id === null) return;
        this._pointerId = null;
        try { this.el?.releasePointerCapture(id); } catch { /* capture already gone */ }
    }

    _onWheel(e) {
        if (!this._wantsInput()) return;
        e.preventDefault();
        this.adapter.zoom(e.deltaY);
        this._viewChanged();
    }

    // --- pan-drag bookkeeping: a pointer that goes down, maybe drags (pans), and comes up.

    _panStart(pt) { this._pan = { down: pt, last: pt, moved: false }; }

    /* Pan by the pointer's movement once it has moved past the click slop. Returns true if it panned. */
    _panMove(pt) {
        const p = this._pan;
        if (!p) return false;
        if (!p.moved) {
            if (!movedPast(p.down, pt)) return false;
            p.moved = true;
            this._setCursor("grabbing");
        }
        this.adapter.pan(pt[0] - p.last[0], pt[1] - p.last[1]);
        p.last = pt;
        this._viewChanged();
        return true;
    }

    /* End the pan. Returns true if the pointer never moved past the click slop (it was a click). */
    _panEnd() {
        const wasClick = !!this._pan && !this._pan.moved;
        this._pan = null;
        return wasClick;
    }

    // Default hooks: no gesture, no reaction.
    _pointerDown() { return false; }
    _pointerMove() {}
    _pointerUp() {}
    _pointerCancel() {}
    _pointerLeave() {}
    _viewChanged() {}

    /* Remove the canvas and stop watching the surface. Subclasses that hold timers/rAF stop them first. */
    destroy() {
        this._releasePointer();
        window.removeEventListener("resize", this._onResize);
        if (this._resizeObs) { this._resizeObs.disconnect(); this._resizeObs = null; }
        this.el?.remove();
        this.el = null;
        this.ctx = null;
    }
}
