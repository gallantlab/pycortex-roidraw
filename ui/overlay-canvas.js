/*
 * overlay-canvas.js — the transparent 2D <canvas> that roidraw lays over the host's WebGL canvas.
 * Base class for LassoOverlay (capturing a stroke) and BezierEditOverlay (editing a curve): both
 * need the same canvas, kept the same size and position as the surface canvas, the same
 * event-to-canvas-px conversion, and the same teardown. Host-agnostic — it only asks the adapter
 * where the surface canvas is. Subclasses wire their own pointer/wheel listeners on `this.el`.
 */
export class CanvasOverlay {
    constructor(adapter, className) {
        this.adapter = adapter;
        const el = document.createElement("canvas");
        el.className = className;
        document.body.appendChild(el);
        this.el = el;
        this.ctx = el.getContext("2d");
        // Subclasses decide what a resize means (re-measure only, or re-measure + reproject).
        this._onResize = () => this.onResize();
        window.addEventListener("resize", this._onResize);
    }

    /* What a window resize does; the default just re-measures. */
    onResize() { this.syncRect(); }

    /* Match the host canvas's screen rect. Assigning canvas.width/height clears the bitmap and
     * resets the 2D context, so it happens only on an actual size change (the edit overlay calls
     * this every tracking frame, where the size rarely changes). */
    syncRect() {
        const r = this.adapter.canvas().getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
        this.el.style.left = Math.round(r.left) + "px";
        this.el.style.top = Math.round(r.top) + "px";
        this.el.style.width = w + "px";
        this.el.style.height = h + "px";
        if (this.el.width !== w || this.el.height !== h) { this.el.width = w; this.el.height = h; }
    }

    /* A mouse event's position in overlay px (the overlay rect == the surface canvas rect). */
    _evtPt(e) {
        const r = this.el.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    _clearCanvas() { if (this.ctx) this.ctx.clearRect(0, 0, this.el.width, this.el.height); }

    /* Remove the canvas and the window listener. Subclasses that hold timers/rAF stop them first. */
    destroy() {
        window.removeEventListener("resize", this._onResize);
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
        this.el = null;
    }
}
