/*
 * bezier-edit-overlay.js — a transparent 2D canvas over the flatmap for EDITING a drawn shape's
 * bezier with FULL vector controls. The shape is an ROI (a closed curve) or a sulcus (an open one);
 * the two differ only in whether the curve closes, the anchor floor (3 vs 2), and the endpoints,
 * which on an open curve are permanent corners carrying a single tangent handle each.
 *
 * Host-agnostic: it only needs the adapter to locate the surface canvas and to project the vertices
 * around the shape (for the uv<->px transform of the current view).
 *
 * The bezier (anchors + explicit in/out tangent handles + a per-anchor smooth flag) is stored in
 * view-independent flat-UV; to show and grab its parts we fit a homography uv->px from the vertices
 * LOCAL to the shape (the flatmap isn't perfectly planar, so a single global homography drifts —
 * locally it's near-exact), and invert it to map a drag back to uv.
 *
 * Controls:
 *   - drag an anchor (●/■)         move it; its two handles travel with it
 *   - click an anchor              select it -> its tangent handles (○) appear
 *   - drag a handle (○)            bend the curve; a smooth anchor mirrors the opposite handle,
 *                                  a corner anchor moves the two sides independently
 *   - double-click the curve       insert a new anchor there (curve shape preserved)
 *   - double-click an anchor       toggle it between smooth (●, circle) and corner (■, square)
 *   - Delete / Backspace           remove the selected anchor (>= 3 kept; >= 2 for an open curve)
 *   - drag empty space / Shift+drag  pan;  scroll  zoom
 *
 *   onEdit(bezier)  — fired whenever the curve changes (host re-derives membership + re-bakes).
 *                     Returning false refuses the edit: the overlay goes back to the stored curve.
 */
import { fitHomography, applyHomography, invertHomography } from "../core/transform.js";
import {
    cloneBezier, evalBezier, moveAnchor, moveHandle, setAnchorSmooth,
    splitSegment, deleteAnchor, nearestOnBezier, isClosed, hasCurve,
} from "../core/bezier.js";
import { polygonBounds, sqDist } from "../core/geom.js";
import { uvPxCorrespondences } from "../adapter/viewer-adapter.js";
import { hitTest, nearestWithin, movedPast } from "./overlay-geom.js";
import { CanvasOverlay } from "./overlay-canvas.js";
import { isTextEntry } from "./dom-utils.js";

const HIT_RADIUS = 9;        // px; how close a click must be to grab an anchor
const HANDLE_RADIUS = 8;     // px; how close a click must be to grab a tangent handle
const CURVE_HIT = 7;         // px; how close a double-click must be to the curve to add a point
const CURVE_HIT_SAMPLES = 24;// segments/curve sampled when finding the nearest point for a click
const TRACK_MS = 500;        // after a zoom/pan, keep re-tracking the surface for this long
const LOCAL_MARGIN = 0.06;   // uv padding around the shape for the LOCAL homography fit
const CURVE_SAMPLES = 40;    // samples/segment when stroking the preview curve (kills chord undercut)
const ANCHOR_R = 4;          // anchor glyph radius (px); a selected/hovered anchor draws larger
const ANCHOR_R_BIG = 6;
const HANDLE_DOT_R = 4;      // tangent-handle dot radius (px)
const WIDTH = {              // stroke widths (px)
    curve: 1.5, handleLine: 1, handleDot: 1.5, anchor: 2,
};
const COLOR = {              // editor palette
    curve: "#39d0ff", handleLine: "#9fe8ff", handleFill: "#fff",
    handleStroke: "#1f7fa0", anchorStroke: "#0a3a4a", anchorSel: "#fff",
};

export class BezierEditOverlay extends CanvasOverlay {
    constructor(adapter, { onEdit } = {}) {
        super(adapter, "roidraw-overlay roidraw-edit-overlay");
        this.onEdit = onEdit || (() => {});
        this.shape = null;
        this.bez = null;        // working copy { anchors, inHandles, outHandles, smooth }
        this._uvPoly = null;    // the bezier sampled to a uv polyline; recomputed only when bez changes
        this._raf = 0;          // requestAnimationFrame id of the post-gesture tracking loop
        this._trackUntil = 0;   // timestamp the tracking loop should run until
        this._resetView();
        this._resetPointer();

        this._onKey = (e) => this._onKeyDown(e);
        // capture phase, like the controller's keys: see Delete before the host viewer's handlers do
        window.addEventListener("keydown", this._onKey, true);
        this.el.addEventListener("dblclick", (e) => this._onDblClick(e));
    }

    // Per-shape view state: the homography and the px caches derived from it.
    _resetView() {
        this.H = null;          // uv -> px
        this.Hinv = null;       // px -> uv
        this._anchorPx = [];    // anchor px (null where unprojectable), for hit-testing and drawing
        this._handlePx = null;  // { sel, out:[x,y]|null, in:[x,y]|null } for the SELECTED anchor, else null
        this._sel = -1;         // selected anchor index, or -1
    }

    // Per-gesture pointer state. `_drag`/`_hover` name an anchor by index, so this must also run
    // whenever the anchor list changes underneath them: a stale `_drag.i` would be written through
    // on the next pointermove (moving the wrong anchor), and a stale `_hover.i` would draw the
    // wrong anchor enlarged.
    _resetPointer() {
        this._releasePointer();
        this._drag = null;      // { kind:"anchor"|"handle", i, which?, down, moved, before } while dragging
        this._hover = null;     // hovered target (for the cursor + enlarged glyph), or null
        this._panEnd();
        if (this.el) this._setCursor(null);
    }

    // A resize moves the surface under the knots: re-measure AND re-fit (the base class only re-measures).
    onResize() { this.reproject(); }

    // Begin editing `shape` — an ROI (closed curve) or a sulcus (open one); it must carry a bezier.
    // Pass null to stop.
    setEditing(shape) {
        this.shape = shape && shape.bezier && shape.bezier.anchors ? shape : null;
        this.bez = this.shape ? cloneBezier(this.shape.bezier) : null;
        this._resetView();      // the last shape's homography must not be reused for this one
        this._resetPointer();
        this._recurve();
        this.el.classList.toggle("roidraw-edit-overlay--active", !!this.shape);
        if (this.shape) this.reproject(); else { this._stopTracking(); this._clearCanvas(); }
    }

    isEditing() { return !!this.shape; }

    // Re-sample the bezier to a uv polyline. Only the curve changes (on an edit), never the view —
    // so caching this lets the per-frame tracking loop just re-map it through the new homography
    // instead of rebuilding + re-sampling the curve every frame.
    _recurve() {
        this._uvPoly = hasCurve(this.bez) ? evalBezier(this.bez, CURVE_SAMPLES) : null;
    }

    // Follow the camera after a view change (pan, zoom, mix). The viewer applies a camera change on
    // its NEXT render frame, so reprojecting synchronously in the handler reads a stale camera
    // (knots lag the surface by a frame, and a damped zoom keeps gliding for several). Instead,
    // re-track on rAF for a short window, so the knots follow the surface every frame until the
    // camera settles.
    track() {
        if (!this.shape) return;
        this._trackUntil = performance.now() + TRACK_MS;
        if (!this._raf) this._raf = requestAnimationFrame(() => this._trackFrame());
    }

    _trackFrame() {
        this._raf = 0;
        if (!this.shape) return;
        this.reproject();
        if (performance.now() < this._trackUntil) this._raf = requestAnimationFrame(() => this._trackFrame());
    }

    _stopTracking() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; } this._trackUntil = 0; }

    _viewChanged() { this.track(); }

    // Re-fit the uv->px homography for the current view and redraw, synchronously. The fit is LOCAL
    // to the shape: the flatmap isn't perfectly planar, so one global homography drifts (the curve
    // sits slightly inside the baked outline), but around a single shape it's near-exact. Falls
    // back to the whole flatmap only if the local region is too sparse on screen.
    reproject() {
        if (!hasCurve(this.bez)) { this._clearCanvas(); return; }
        this.syncRect();
        let c = uvPxCorrespondences(this.adapter, this._anchorUvBounds(LOCAL_MARGIN));
        // If the shape's region is too sparse on screen, fall back to the whole flatmap — but ONLY to
        // bootstrap the very first fit. Once we have a homography we keep it rather than reprojecting
        // every vertex each frame in the tracking loop (which would stall when the shape is off-screen).
        if (c.src.length < 6 && !this.H) c = uvPxCorrespondences(this.adapter);
        if (c.src.length >= 4) {
            const H = fitHomography(c.src, c.dst);
            const Hinv = H && invertHomography(H);
            if (Hinv) { this.H = H; this.Hinv = Hinv; }   // else keep the last good fit
        }
        this._redraw();
    }

    // uv bounding box of the current anchors, padded by `m` (in the adapter's {minu,maxu,minv,maxv} form).
    _anchorUvBounds(m) {
        const b = polygonBounds(this.bez.anchors);
        return { minu: b.minx - m, maxu: b.maxx + m, minv: b.miny - m, maxv: b.maxy + m };
    }

    // Hit-test a point against the editable bits (pure math in overlay-geom.js): the selected
    // anchor's two handles (on top), then any anchor. Returns { kind, i, which? } or null.
    _hitTest(pt) {
        return hitTest(this._anchorPx, this._handlePx, pt, { hitRadius: HIT_RADIUS, handleRadius: HANDLE_RADIUS });
    }

    // Is `pt` (px) close to the curve? Map it to uv, find the nearest curve point, map that back to
    // px and compare in px. Returns { seg, t } for a split, or null.
    _hitCurve(pt) {
        if (!this.Hinv || !this.H) return null;
        const uv = applyHomography(this.Hinv, pt);
        if (!uv) return null;
        const hit = nearestOnBezier(this.bez, uv, CURVE_HIT_SAMPLES);
        if (!hit) return null;
        const px = applyHomography(this.H, hit.point);
        if (!px) return null;
        return sqDist(px, pt) <= CURVE_HIT * CURVE_HIT ? { seg: hit.seg, t: hit.t } : null;
    }

    _wantsInput() { return !!this.shape; }

    _pointerDown(e, pt) {
        if (!this.Hinv) return false;
        const hit = e.shiftKey ? null : this._hitTest(pt);   // Shift forces a pan
        if (hit) {
            if (hit.kind === "anchor") this._sel = hit.i;   // its handles show from the next redraw
            this._drag = { ...hit, down: pt, moved: false, before: this.bez };
            this._setCursor("grabbing");
        } else {
            this._panStart(pt);                                // empty (or Shift): pan / deselect
        }
        return true;
    }

    _pointerMove(e, pt) {
        const d = this._drag;
        if (d) {
            e.preventDefault();
            if (!d.moved) {                                    // hold geometry until the click clearly drags
                if (!movedPast(d.down, pt)) return;
                d.moved = true;
            }
            const uv = applyHomography(this.Hinv, pt);         // px -> uv
            if (!uv) return;                                   // off the projectable plane: hold
            this.bez = d.kind === "handle"
                ? moveHandle(this.bez, d.i, d.which, uv)
                : moveAnchor(this.bez, d.i, uv);
            this._recurve();
            this._redraw();
            return;
        }
        if (this._pan) { this._panMove(pt); return; }
        const hov = this._hitTest(pt);
        const key = (t) => (t ? t.kind + t.i + (t.which || "") : "");
        if (key(hov) !== key(this._hover)) {
            this._hover = hov;
            this._setCursor(hov ? "grab" : null);
            this._draw();
        }
    }

    _pointerUp() {
        const d = this._drag;
        if (d) {
            this._drag = null;
            this._setCursor(this._hover ? "grab" : null);
            if (d.moved) { this._commit(); this.reproject(); }  // realign the local fit to the new shape
            else this._redraw();                               // a click (select only) — no commit
            return;
        }
        if (this._pan) {
            const wasClick = this._panEnd();
            this._setCursor(this._hover ? "grab" : null);
            if (wasClick && this._sel >= 0) { this._sel = -1; this._redraw(); }   // click empty -> deselect
        }
    }

    // An interrupted drag reverts to the curve as it was at pointerdown; nothing is committed.
    _pointerCancel() {
        const d = this._drag;
        if (d && d.moved) { this.bez = d.before; this._recurve(); }
        this._resetPointer();
        this._redraw();
    }

    _pointerLeave() {
        if (!this._hover) return;
        this._hover = null;
        this._setCursor(null);
        this._draw();
    }

    _onDblClick(e) {
        if (!this.shape || !this.Hinv) return;
        e.preventDefault();
        const pt = this._evtPt(e);
        const anchor = nearestWithin(this._anchorPx, pt, HIT_RADIUS);
        if (anchor >= 0) {                                     // toggle smooth <-> corner
            const was = this.bez.smooth[anchor];
            this.bez = setAnchorSmooth(this.bez, anchor, !was);
            this._sel = anchor;
            // an open curve's endpoints are permanent corners: the toggle is refused, nothing to commit
            if (this.bez.smooth[anchor] !== was) { this._recurve(); this._commit(); this.reproject(); }
            else this._redraw();
            return;
        }
        const c = this._hitCurve(pt);
        if (c) {                                               // add an anchor on the curve
            const before = this.bez.anchors.length;
            this.bez = splitSegment(this.bez, c.seg, c.t);
            if (this.bez.anchors.length === before) return;    // t at a segment end: nothing inserted
            this._resetPointer();                              // the splice shifted every index past seg
            this._sel = c.seg + 1; this._recurve(); this._commit(); this.reproject();
        }
    }

    _onKeyDown(e) {
        if (!this.shape || this._sel < 0) return;
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        if (isTextEntry(e.target)) return;   // not while typing (the same rule as the controller's keys)
        e.preventDefault();
        const before = this.bez.anchors.length;
        this.bez = deleteAnchor(this.bez, this._sel);
        if (this.bez.anchors.length === before) return;        // refused (floor: 3 closed, 2 open)
        this._resetPointer();                                  // the splice invalidated every index past _sel
        this._sel = -1; this._recurve(); this._commit(); this.reproject();
    }

    // push the working curve to the host (re-derives membership + re-bakes the white outline)
    _commit() {
        if (this.onEdit(cloneBezier(this.bez)) !== false) return;
        this.bez = cloneBezier(this.shape.bezier);   // refused: back to the curve the host kept
        this._sel = -1;
        this._recurve();
    }

    _redraw() { this._layout(); this._draw(); }

    // Recompute the px caches that hit-testing reads: every anchor, and the selected anchor's
    // handles. A point the homography can't project is null (never hit, never drawn).
    _layout() {
        this._anchorPx = [];
        this._handlePx = null;
        if (!this.shape || !this.H || !this.bez) return;
        const toPx = (uv) => applyHomography(this.H, uv);
        this._anchorPx = this.bez.anchors.map(toPx);
        const s = this._sel;
        if (s < 0 || s >= this._anchorPx.length || !this._anchorPx[s]) return;
        // An open curve's endpoints have exactly one live tangent: anchor 0 has only `out`,
        // anchor n-1 only `in`. The other handle coincides with the anchor — a dot on a dot.
        const n = this.bez.anchors.length;
        const open = !isClosed(this.bez);
        this._handlePx = {
            sel: s,
            out: !(open && s === n - 1) ? toPx(this.bez.outHandles[s]) : null,
            in: !(open && s === 0) ? toPx(this.bez.inHandles[s]) : null,
        };
    }

    // Paint the curve, the selected anchor's handles, and the anchors from the current caches.
    _draw() {
        const ctx = this.ctx;
        if (!ctx) return;
        this._clearCanvas();
        if (!this.shape || !this.H || !this._uvPoly) return;

        // the curve: the cached (dense) uv polyline mapped through the current homography. Dense
        // sampling means no chord undercut, so the preview matches the baked cubic outline.
        const poly = this._uvPoly.map((uv) => applyHomography(this.H, uv)).filter(Boolean);
        if (poly.length > 1) {
            ctx.strokeStyle = COLOR.curve;
            ctx.lineWidth = WIDTH.curve;
            ctx.beginPath();
            ctx.moveTo(poly[0][0], poly[0][1]);
            for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
            if (isClosed(this.bez)) ctx.closePath();   // an open curve has no closing chord
            ctx.stroke();
        }

        // the selected anchor's tangent handles (drawn under the anchors so the anchor stays grabbable)
        const h = this._handlePx;
        if (h) {
            const a = this._anchorPx[h.sel];
            for (const hp of [h.out, h.in]) {
                if (!hp) continue;
                ctx.strokeStyle = COLOR.handleLine;
                ctx.lineWidth = WIDTH.handleLine;
                ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(hp[0], hp[1]); ctx.stroke();
                ctx.fillStyle = COLOR.handleFill;
                ctx.strokeStyle = COLOR.handleStroke;
                ctx.lineWidth = WIDTH.handleDot;
                ctx.beginPath(); ctx.arc(hp[0], hp[1], HANDLE_DOT_R, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
            }
        }

        // the anchors: smooth = circle (●), corner = square (■). Selected = white, hovered = larger.
        const hoverI = this._hover && this._hover.kind === "anchor" ? this._hover.i : -1;
        for (let i = 0; i < this._anchorPx.length; i++) {
            const a = this._anchorPx[i];
            if (!a) continue;
            const r = (i === this._sel || i === hoverI) ? ANCHOR_R_BIG : ANCHOR_R;
            ctx.fillStyle = (i === this._sel) ? COLOR.anchorSel : COLOR.curve;
            ctx.strokeStyle = COLOR.anchorStroke;
            ctx.lineWidth = WIDTH.anchor;
            ctx.beginPath();
            if (this.bez.smooth[i]) ctx.arc(a[0], a[1], r, 0, Math.PI * 2);
            else ctx.rect(a[0] - r, a[1] - r, r * 2, r * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    destroy() {
        this._stopTracking();
        window.removeEventListener("keydown", this._onKey, true);
        super.destroy();
    }
}
