/*
 * point-picker.js — the POINT tool's input: a click on the surface canvas places a point.
 *
 * Unlike the lasso it lays NO overlay over the surface and never captures the pointer: the host
 * keeps every gesture (drag to rotate, wheel to zoom, its own click-pick crosshair and console
 * line), and this only listens. A primary-button press released within the click slop, with no
 * modifier key held, is a click; onPick fires at the release, against the camera the user clicked
 * on. (pycortex dispatches "dblpick" but nothing listens for it, so there is no double-click
 * gesture to defer for.) One pointer at a time: a second pointer, or a pointercancel, ends the
 * gesture without a pick. Host-agnostic: it asks the adapter only for the surface canvas. Emits
 * onPick(x, y) in canvas-relative px.
 */
import { movedPast } from "./overlay-geom.js";

export class PointPicker {
    constructor(adapter, { onPick } = {}) {
        this.adapter = adapter;
        this.onPick = onPick || (() => {});
        this.active = false;
        this._down = null;          // { id, pt } for the press in flight
        this._el = null;            // the canvas the listeners are bound to (while active)
        this._onDown = (e) => this._pointerDown(e);
        this._onUp = (e) => this._pointerUp(e);
        this._onCancel = () => { this._down = null; };
    }

    setActive(on) {
        if (on === this.active) return;
        if (on) {
            // No canvas yet: stay inactive, so a later setActive(true) retries the binding.
            const el = this.adapter.canvas();
            if (!el) return;
            this._el = el;
            el.addEventListener("pointerdown", this._onDown);
            el.addEventListener("pointerup", this._onUp);
            el.addEventListener("pointercancel", this._onCancel);
            el.classList.add("roidraw-pointpick");
        } else {
            this._unbind();
        }
        this.active = on;
    }

    _pt(e) {
        const r = this._el.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    _pointerDown(e) {
        // A second pointer (a pinch) ends the gesture: neither finger places a point.
        if (this._down) { this._down = null; return; }
        if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
        this._down = { id: e.pointerId, pt: this._pt(e) };
    }

    _pointerUp(e) {
        const d = this._down;
        if (!d || e.pointerId !== d.id) return;
        this._down = null;
        const pt = this._pt(e);
        if (movedPast(d.pt, pt)) return;   // a drag: the host rotated the surface
        this.onPick(pt[0], pt[1]);
    }

    _unbind() {
        this._down = null;
        if (this._el) {
            this._el.removeEventListener("pointerdown", this._onDown);
            this._el.removeEventListener("pointerup", this._onUp);
            this._el.removeEventListener("pointercancel", this._onCancel);
            this._el.classList.remove("roidraw-pointpick");
        }
        this._el = null;
    }

    destroy() { this.active = false; this._unbind(); }
}
