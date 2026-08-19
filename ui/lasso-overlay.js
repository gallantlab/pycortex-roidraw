/*
 * lasso-overlay.js — a transparent 2D canvas over the surface that captures the lasso while
 * drawing. Host-agnostic: it only needs the adapter to locate the surface canvas. It emits:
 *   onLasso(points)   — a completed CLOSED lasso (>= 3 points), in canvas-relative px.
 *   onTrace(points)   — a completed OPEN stroke (>= 2 points), in canvas-relative px (a sulcus).
 *   onInspect(x, y)   — a Shift-click (not drag), so the host can pick the voxel underneath.
 * Committed ROIs are NOT drawn here (the adapter renders them into the surface); this only
 * shows the in-progress lasso, and drawing happens at full-flat so it never needs reprojection.
 */
import { polygonBounds } from "../core/geom.js";
import { TOOL, asTool } from "../core/draw-mode.js";
import { CanvasOverlay } from "./overlay-canvas.js";

const DRAG_THRESHOLD = 4;       // px; distinguishes a click from a drag (Shift-inspect, and a stray
                                // click that would otherwise become a degenerate shape)
const LASSO_STROKE = "#ffcc00"; // in-progress lasso outline color
const LASSO_WIDTH = 1.5;
const SETTLE_MS = 800;          // the host canvas can settle slightly after load; re-measure once then

/* Diagonal of the stroke's bounding box, in px. 0 for a stroke that never left its start point. */
function bboxDiagonal(pts) {
    const b = polygonBounds(pts);
    return Math.hypot(b.maxx - b.minx, b.maxy - b.miny);
}

export class LassoOverlay extends CanvasOverlay {
    constructor(adapter, { onLasso, onInspect, onTrace } = {}) {
        super(adapter, "roidraw-overlay");
        this.onLasso = onLasso || (() => {});
        this.onTrace = onTrace || (() => {});
        this.onInspect = onInspect || (() => {});
        this.active = false;
        this.passthrough = false;   // Shift held -> drag pans the surface, click inspects a voxel
        this.drawing = false;
        this.tool = TOOL.LASSO;     // TOOL.LASSO (closed ROI) | TOOL.TRACE (open sulcus)
        this.lasso = [];
        this._gesture = "none";     // "lasso" | "shift" — fixed at mousedown
        this._downPt = null;
        this._panLast = null;
        this._moved = false;

        const el = this.el;
        el.addEventListener("mousedown", (e) => this._onDown(e));
        el.addEventListener("mousemove", (e) => this._onMove(e));
        el.addEventListener("mouseup", (e) => this._onUp(e));
        el.addEventListener("mouseleave", (e) => { if (this._gesture !== "none") this._onUp(e); });
        el.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });

        this.syncRect();
        // tracked so destroy() can cancel it: autoAttach destroys-then-attaches, and an orphaned
        // re-measure would touch a removed canvas.
        this._settleTimer = setTimeout(() => { this._settleTimer = 0; this.syncRect(); }, SETTLE_MS);
    }

    syncRect() {
        super.syncRect();
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

    /* Which gesture a plain drag performs: a closed ROI lasso, or an open sulcus trace. */
    setTool(tool) {
        const t = asTool(tool);
        if (t === this.tool) return;
        this.tool = t;
        this._cancel();            // an in-flight stroke belongs to the old tool
    }

    _applyMode() {
        const nav = this.active && this.passthrough;   // Shift: pan/inspect mode
        this.el.classList.toggle("roidraw-overlay--active", this.active && !nav);
        this.el.classList.toggle("roidraw-overlay--inspect", nav);
        this.el.style.cursor = nav ? "grab" : (this.active ? "crosshair" : "default");
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
        // Both tools reject a degenerate stroke — an accidental click with a few pixels of wobble
        // still emits several points. Requiring the stroke's bounding-box diagonal to exceed the
        // same threshold that separates a Shift-click from a Shift-drag means a stray click can
        // neither mint a near-zero-length sulcus nor run the whole selection pipeline for nothing.
        // Beyond that, a trace needs only 2 points (a line); a closed lasso needs 3 to bound an area.
        const trace = this.tool === TOOL.TRACE;
        if (pts.length < (trace ? 2 : 3) || bboxDiagonal(pts) <= DRAG_THRESHOLD) return;
        if (trace) this.onTrace(pts); else this.onLasso(pts);
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
        this._clearCanvas();
        if (this.lasso.length > 1) {
            // Drawn as an open polyline for BOTH tools: a lasso's closure is implied by the
            // point-in-polygon test, not by the preview stroke.
            ctx.strokeStyle = LASSO_STROKE;
            ctx.lineWidth = LASSO_WIDTH;
            ctx.beginPath();
            ctx.moveTo(this.lasso[0][0], this.lasso[0][1]);
            for (let j = 1; j < this.lasso.length; j++) ctx.lineTo(this.lasso[j][0], this.lasso[j][1]);
            ctx.stroke();
        }
    }

    destroy() {
        if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = 0; }
        super.destroy();
    }
}
