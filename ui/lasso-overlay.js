/*
 * lasso-overlay.js — a transparent 2D canvas over the surface that captures the lasso while
 * drawing. Host-agnostic: it only needs the adapter to locate the surface canvas. It emits:
 *   onLasso(points)   — a completed CLOSED lasso (>= 3 points), in canvas-relative px.
 *   onTrace(points)   — a completed OPEN stroke (>= 2 points), in canvas-relative px (a sulcus).
 *   onInspect(x, y)   — a Shift-click (not drag), so the host can pick the voxel underneath.
 * Committed ROIs are NOT drawn here (the adapter renders them into the surface); this only
 * shows the in-progress lasso, and drawing happens at full-flat so it never needs reprojection.
 */
import { TOOL, asTool } from "../core/draw-mode.js";
import { CanvasOverlay } from "./overlay-canvas.js";
import { isUsableStroke } from "./overlay-geom.js";

const LASSO_STROKE = "#ffcc00"; // in-progress lasso outline color
const LASSO_WIDTH = 1.5;

export class LassoOverlay extends CanvasOverlay {
    constructor(adapter, { onLasso, onInspect, onTrace } = {}) {
        super(adapter, "roidraw-overlay");
        this.onLasso = onLasso || (() => {});
        this.onTrace = onTrace || (() => {});
        this.onInspect = onInspect || (() => {});
        this.active = false;
        this.passthrough = false;   // Shift held -> drag pans the surface, click inspects a voxel
        this.tool = TOOL.LASSO;     // TOOL.LASSO (closed ROI) | TOOL.TRACE (open sulcus)
        this.lasso = [];
        this._gesture = "none";     // "lasso" | "shift" — fixed at pointerdown
        this.syncRect();
    }

    syncRect() {
        super.syncRect();
        this._redraw();
    }

    setActive(on) {
        if (on === this.active) return;
        this.active = on;
        this.passthrough = false;
        if (on) this.syncRect(); else this.cancel();
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
        this.cancel();             // an in-flight stroke belongs to the old tool
    }

    /* Drop any in-flight gesture without emitting anything. */
    cancel() {
        this._releasePointer();
        this._gesture = "none";
        this._panEnd();
        this.lasso = [];
        this._redraw();
        this._applyMode();
    }

    // Mode classes (roidraw.css) carry the tint, outline, pointer-events, and cursor.
    _applyMode() {
        if (!this.el) return;
        const nav = this.active && this.passthrough;   // Shift: pan/inspect mode
        this.el.classList.toggle("roidraw-overlay--active", this.active && !nav);
        this.el.classList.toggle("roidraw-overlay--inspect", nav);
        this._setCursor(nav ? "grab" : (this.active ? "draw" : null));
    }

    _wantsInput() { return this.active; }

    _pointerDown(e, pt) {
        if (this.passthrough) {                 // Shift: becomes a pan (if dragged) or inspect (if clicked)
            this._gesture = "shift";
            this._panStart(pt);
        } else {
            this._gesture = "lasso";
            this.lasso = [pt];
        }
        return true;
    }

    _pointerMove(e, pt) {
        if (this._gesture === "shift") { this._panMove(pt); return; }
        if (this._gesture !== "lasso") return;
        e.preventDefault();
        this.lasso.push(pt);
        this._redraw();
    }

    _pointerUp(e, pt) {
        const g = this._gesture;
        this._gesture = "none";
        if (g === "shift") {
            if (this._panEnd()) this.onInspect(pt[0], pt[1]);   // a click -> inspect
            this._applyMode();                                  // restore grab cursor (from grabbing)
            return;
        }
        if (g !== "lasso") return;
        const pts = this.lasso;
        this.lasso = [];
        this._redraw();
        // A stray click can neither mint a near-zero-length sulcus nor run the whole selection
        // pipeline for nothing: see isUsableStroke.
        const trace = this.tool === TOOL.TRACE;
        if (!isUsableStroke(pts, !trace)) return;
        if (trace) this.onTrace(pts); else this.onLasso(pts);
    }

    _pointerCancel() { this.cancel(); }

    // A zoom mid-stroke would move the surface under the px already captured, distorting the
    // stroke, so the wheel is swallowed (still preventDefault-ed, so the page doesn't scroll).
    _onWheel(e) {
        if (this._gesture === "lasso") { e.preventDefault(); return; }
        super._onWheel(e);
    }

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
}
