/*
 * lasso-overlay.js — a transparent 2D canvas over the surface that captures the lasso while
 * drawing. Host-agnostic: it only needs the adapter to locate the surface canvas. It emits:
 *   onLasso(points)   — a completed lasso (>= 3 points), in canvas-relative px.
 *   onInspect(x, y)   — a Shift-click (not drag), so the host can pick the voxel underneath.
 * Committed ROIs are NOT drawn here (the adapter renders them into the surface); this only
 * shows the in-progress lasso, and drawing happens at full-flat so it never needs reprojection.
 */
const DRAG_THRESHOLD = 4; // px; distinguishes a Shift-click (inspect) from a Shift-drag

export class LassoOverlay {
    constructor(adapter, { onLasso, onInspect } = {}) {
        this.adapter = adapter;
        this.onLasso = onLasso || (() => {});
        this.onInspect = onInspect || (() => {});
        this.active = false;
        this.passthrough = false;   // Shift held -> drag pans the surface, click inspects a voxel
        this.drawing = false;
        this.lasso = [];
        this._gesture = "none";     // "lasso" | "shift" — fixed at mousedown
        this._downPt = null;
        this._panLast = null;
        this._moved = false;

        const el = document.createElement("canvas");
        el.className = "roidraw-overlay";
        document.body.appendChild(el);
        this.el = el;
        this.ctx = el.getContext("2d");

        this._onResize = () => this.syncRect();
        window.addEventListener("resize", this._onResize);
        el.addEventListener("mousedown", (e) => this._onDown(e));
        el.addEventListener("mousemove", (e) => this._onMove(e));
        el.addEventListener("mouseup", (e) => this._onUp(e));
        el.addEventListener("mouseleave", (e) => { if (this._gesture !== "none") this._onUp(e); });
        el.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });

        this.syncRect();
        // canvas size can settle slightly after load; re-measure shortly after attach.
        setTimeout(() => this.syncRect(), 800);
    }

    syncRect() {
        const r = this.adapter.canvas().getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        this.el.style.left = Math.round(r.left) + "px";
        this.el.style.top = Math.round(r.top) + "px";
        this.el.style.width = w + "px";
        this.el.style.height = h + "px";
        this.el.width = w;
        this.el.height = h;
        this._redraw();
    }

    setActive(on) {
        this.active = on;
        this.passthrough = false;
        this._gesture = "none";
        this.el.style.pointerEvents = on ? "auto" : "none";
        if (on) this.syncRect(); else this._cancel();
        this._applyMode();
    }

    // Shift held: a drag pans the surface (so you can zoom/pan in to draw fine detail), and a
    // click (no drag) inspects the voxel underneath. Plain drag (no Shift) is the lasso.
    setPassthrough(on) {
        if (!this.active || this._gesture !== "none" || on === this.passthrough) return;
        this.passthrough = on;
        this._applyMode();
    }

    _applyMode() {
        const nav = this.active && this.passthrough;   // Shift: pan/inspect mode
        this.el.classList.toggle("roidraw-overlay--active", this.active && !nav);
        this.el.classList.toggle("roidraw-overlay--inspect", nav);
        this.el.style.cursor = nav ? "grab" : (this.active ? "crosshair" : "default");
    }

    _evtPt(e) {
        const r = this.el.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];   // overlay rect == canvas rect
    }

    _onDown(e) {
        if (!this.active) return;
        e.preventDefault();
        this._downPt = this._evtPt(e);
        if (this.passthrough) {                 // Shift: becomes a pan (if dragged) or inspect (if clicked)
            this._gesture = "shift";
            this._panLast = this._downPt;
            this._moved = false;
        } else {
            this._gesture = "lasso";
            this.drawing = true;
            this.lasso = [this._downPt];
        }
    }

    _onMove(e) {
        if (this._gesture === "shift") {
            const p = this._evtPt(e);
            if (!this._moved &&
                (Math.abs(p[0] - this._downPt[0]) > DRAG_THRESHOLD || Math.abs(p[1] - this._downPt[1]) > DRAG_THRESHOLD)) {
                this._moved = true;
                this.el.style.cursor = "grabbing";
            }
            if (this._moved) {                  // it's a drag -> pan
                this.adapter.pan(p[0] - this._panLast[0], p[1] - this._panLast[1]);
                this._panLast = p;
            }
            return;
        }
        if (this._gesture !== "lasso") return;
        e.preventDefault();
        this.lasso.push(this._evtPt(e));
        this._redraw();
    }

    _onUp(e) {
        const g = this._gesture;
        this._gesture = "none";
        if (g === "shift") {
            if (!this._moved) { const p = this._evtPt(e); this.onInspect(p[0], p[1]); }   // a click -> inspect
            this._applyMode();                  // restore grab cursor (from grabbing)
            return;
        }
        if (g !== "lasso") return;
        this.drawing = false;
        const pts = this.lasso;
        this.lasso = [];
        this._redraw();
        if (pts.length >= 3) this.onLasso(pts);
    }

    _onWheel(e) {
        if (!this.active) return;
        e.preventDefault();
        this.adapter.zoom(e.deltaY);
    }

    _cancel() {
        this.drawing = false;
        this._gesture = "none";
        this.lasso = [];
        this._redraw();
    }

    cancel() { this._cancel(); }

    _redraw() {
        const ctx = this.ctx;
        if (!ctx) return;
        ctx.clearRect(0, 0, this.el.width, this.el.height);
        if (this.lasso.length > 1) {
            ctx.strokeStyle = "#ffcc00";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(this.lasso[0][0], this.lasso[0][1]);
            for (let j = 1; j < this.lasso.length; j++) ctx.lineTo(this.lasso[j][0], this.lasso[j][1]);
            ctx.stroke();
        }
    }

    destroy() {
        window.removeEventListener("resize", this._onResize);
        if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }
}
