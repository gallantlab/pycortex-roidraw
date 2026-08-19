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
 */
import { fitHomography, applyHomography, invertHomography } from "../core/transform.js";
import {
    cloneBezier, evalBezier, moveAnchor, moveHandle, setAnchorSmooth,
    splitSegment, deleteAnchor, nearestOnBezier, isClosed, hasCurve,
} from "../core/bezier.js";
import { polygonBounds } from "../core/geom.js";
import { uvPxCorrespondences } from "../adapter/viewer-adapter.js";
import { hitTest, nearestWithin } from "./overlay-geom.js";
import { CanvasOverlay } from "./overlay-canvas.js";
import { isTextEntry } from "./dom-utils.js";

const HIT_RADIUS = 9;        // px; how close a click must be to grab an anchor
const HANDLE_RADIUS = 8;     // px; how close a click must be to grab a tangent handle
const CURVE_HIT = 7;         // px; how close a double-click must be to the curve to add a point
const CURVE_HIT_SAMPLES = 24;// segments/curve sampled when finding the nearest point for a click
const DRAG_SLOP = 1.5;       // px; movement under this counts as a click (no commit / deselect)
const TRACK_MS = 500;        // after a zoom/pan, keep re-tracking the surface for this long
const LOCAL_MARGIN = 0.06;   // uv padding around the shape for the LOCAL homography fit
const CURVE_SAMPLES = 40;    // samples/segment when stroking the preview curve (kills chord undercut)
const ANCHOR_R = 4;          // anchor glyph radius (px); a selected/hovered anchor draws larger
const ANCHOR_R_BIG = 6;
const HANDLE_DOT_R = 4;      // tangent-handle dot radius (px)
const COLOR = {              // editor palette
    curve: "#39d0ff", handleLine: "#9fe8ff", handleFill: "#fff",
    handleStroke: "#1f7fa0", anchorStroke: "#0a3a4a", anchorSel: "#fff",
};
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class BezierEditOverlay extends CanvasOverlay {
    constructor(adapter, { onEdit } = {}) {
        super(adapter, "roidraw-overlay roidraw-edit-overlay");
        this.onEdit = onEdit || (() => {});
        this.shape = null;
        this.bez = null;        // working copy { anchors, inHandles, outHandles, smooth }
        this._uvPoly = null;    // the bezier sampled to a uv polyline; recomputed only when bez changes
        this.H = null;          // uv -> px
        this.Hinv = null;       // px -> uv
        this._anchorPx = [];    // cached anchor px for hit-testing/redraw
        this._handlePx = null;  // { out:[x,y], in:[x,y] } for the SELECTED anchor (else null)
        this._sel = -1;         // selected anchor index, or -1
        this._drag = null;      // { kind:"anchor"|"handle", i, which } while dragging, else null
        this._dragMoved = false;
        this._downPt = null;    // px where the current drag started (for the click-vs-drag slop test)
        this._hover = null;     // hovered target (for cursor), or null
        this._panLast = null;
        this._panMoved = false;
        this._raf = 0;          // requestAnimationFrame id of the post-gesture tracking loop
        this._trackUntil = 0;   // timestamp the tracking loop should run until

        const el = this.el;
        this._onKey = (e) => this._onKeyDown(e);
        window.addEventListener("keydown", this._onKey);
        el.addEventListener("mousedown", (e) => this._onDown(e));
        el.addEventListener("mousemove", (e) => this._onMove(e));
        el.addEventListener("mouseup", (e) => this._onUp(e));
        el.addEventListener("mouseleave", (e) => { if (this._drag || this._panLast) this._onUp(e); });
        el.addEventListener("dblclick", (e) => this._onDblClick(e));
        el.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    }

    // A resize moves the surface under the knots: re-measure AND re-fit (the base class only re-measures).
    onResize() { this.reproject(); }

    // Begin editing `shape` — an ROI (closed curve) or a sulcus (open one); it must carry a bezier.
    // Pass null to stop.
    setEditing(shape) {
        this.shape = shape && shape.bezier && shape.bezier.anchors ? shape : null;
        this.bez = this.shape ? cloneBezier(this.shape.bezier) : null;
        this._sel = -1;
        this._recurve();
        this._drag = null; this._dragMoved = false; this._hover = null; this._panLast = null;
        this.el.style.pointerEvents = this.shape ? "auto" : "none";
        this.el.classList.toggle("roidraw-edit-overlay--active", !!this.shape);
        if (this.shape) { this.syncRect(); this.reproject(); } else { this._stopTracking(); this._clearCanvas(); }
    }

    isEditing() { return !!this.shape; }

    // Re-sample the bezier to a uv polyline. Only the curve changes (on an edit), never the view —
    // so caching this lets the per-frame tracking loop just re-map it through the new homography
    // instead of rebuilding + re-sampling the curve every frame.
    _recurve() {
        this._uvPoly = hasCurve(this.bez) ? evalBezier(this.bez, CURVE_SAMPLES) : null;
    }

    // The viewer applies a camera change on its NEXT render frame, so reprojecting synchronously in
    // a wheel/pan handler reads a stale camera (knots lag the surface by a frame, and a damped zoom
    // keeps gliding for several). Instead, re-track on rAF for a short window after the gesture, so
    // the knots follow the surface every frame until the camera settles.
    _pokeTracking() {
        this._trackUntil = now() + TRACK_MS;
        if (!this._raf) this._raf = requestAnimationFrame(() => this._trackFrame());
    }

    _trackFrame() {
        this._raf = 0;
        if (!this.shape) return;
        this.reproject();
        if (now() < this._trackUntil) this._raf = requestAnimationFrame(() => this._trackFrame());
    }

    _stopTracking() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; } this._trackUntil = 0; }

    // Re-fit the uv->px homography for the current view and redraw. Call on pan/zoom/mix/resize.
    // The fit is LOCAL to the shape: the flatmap isn't perfectly planar, so one global homography
    // drifts (the curve sits slightly inside the baked outline), but around a single shape it's
    // near-exact. Falls back to the whole flatmap only if the local region is too sparse on screen.
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
            if (H) { this.H = H; this.Hinv = invertHomography(H); }   // else keep the last good fit
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
        return hitTest(this._anchorPx, this._handlePx, this._sel, pt, { hitRadius: HIT_RADIUS, handleRadius: HANDLE_RADIUS });
    }

    // Is `pt` (px) close to the curve? Map it to uv, find the nearest curve point, map that back to
    // px and compare in px. Returns { seg, t } for a split, or null.
    _hitCurve(pt) {
        if (!this.Hinv || !this.H) return null;
        const uv = applyHomography(this.Hinv, pt);
        const hit = nearestOnBezier(this.bez, uv, CURVE_HIT_SAMPLES);
        if (!hit) return null;
        const px = applyHomography(this.H, hit.point);
        const dx = px[0] - pt[0], dy = px[1] - pt[1];
        return (dx * dx + dy * dy <= CURVE_HIT * CURVE_HIT) ? { seg: hit.seg, t: hit.t } : null;
    }

    _onDown(e) {
        if (!this.shape || !this.Hinv) return;
        e.preventDefault();
        const pt = this._evtPt(e);
        const hit = e.shiftKey ? null : this._hitTest(pt);   // Shift forces a pan
        if (hit) {
            if (hit.kind === "anchor") this._select(hit.i);
            this._drag = hit; this._dragMoved = false; this._downPt = pt;
            this.el.style.cursor = "grabbing";
        } else {
            this._panLast = pt; this._panMoved = false;       // empty (or Shift): pan / deselect
        }
    }

    _onMove(e) {
        const pt = this._evtPt(e);
        if (this._drag) {
            e.preventDefault();
            if (!this._dragMoved) {                            // hold geometry until the click clearly drags
                const dx = pt[0] - this._downPt[0], dy = pt[1] - this._downPt[1];
                if (dx * dx + dy * dy <= DRAG_SLOP * DRAG_SLOP) return;
                this._dragMoved = true;
            }
            const uv = applyHomography(this.Hinv, pt);         // px -> uv
            this.bez = this._drag.kind === "handle"
                ? moveHandle(this.bez, this._drag.i, this._drag.which, uv)
                : moveAnchor(this.bez, this._drag.i, uv);
            this._recurve();
            this._redraw();
            return;
        }
        if (this._panLast) {
            const dx = pt[0] - this._panLast[0], dy = pt[1] - this._panLast[1];
            if (dx || dy) this._panMoved = true;
            this.adapter.pan(dx, dy);
            this._panLast = pt;
            this._pokeTracking();   // re-track on rAF (the pan applies on the next render frame)
            return;
        }
        const hov = this._hitTest(pt);
        const key = (t) => (t ? t.kind + t.i + (t.which || "") : "");
        if (key(hov) !== key(this._hover)) {
            this._hover = hov;
            this.el.style.cursor = hov ? "grab" : "default";
            this._redraw();
        }
    }

    _onUp() {
        if (this._drag) {
            const moved = this._dragMoved;
            this._drag = null;
            this.el.style.cursor = this._hover ? "grab" : "default";
            if (moved) { this._commit(); this.reproject(); }   // realign the local fit to the new shape
            else this._redraw();                               // a click (select only) — no commit
            return;
        }
        if (this._panLast) {
            const wasClick = !this._panMoved;
            this._panLast = null;
            if (wasClick && this._sel >= 0) { this._sel = -1; this._redraw(); }   // click empty -> deselect
        }
    }

    _onDblClick(e) {
        if (!this.shape || !this.Hinv) return;
        e.preventDefault();
        const pt = this._evtPt(e);
        const anchor = this._hitTestAnchorOnly(pt);
        if (anchor >= 0) {                                     // toggle smooth <-> corner
            this.bez = setAnchorSmooth(this.bez, anchor, !this.bez.smooth[anchor]);
            this._select(anchor); this._recurve(); this._commit(); this.reproject();
            return;
        }
        const c = this._hitCurve(pt);
        if (c) {                                               // add an anchor on the curve
            this.bez = splitSegment(this.bez, c.seg, c.t);
            this._invalidatePointerTargets();                  // the splice shifted every index past seg
            this._select(c.seg + 1); this._recurve(); this._commit(); this.reproject();
        }
    }

    _hitTestAnchorOnly(pt) { return nearestWithin(this._anchorPx, pt, HIT_RADIUS); }

    /* Drop every pointer target that names an anchor by index. Call whenever the anchor list
     * changes underneath one: a stale `_drag.i` would be written through on the next mousemove
     * (moving the wrong anchor), and a stale `_hover.i` would draw the wrong anchor enlarged. */
    _invalidatePointerTargets() {
        this._drag = null;
        this._dragMoved = false;
        this._downPt = null;
        this._hover = null;
        this.el.style.cursor = "default";
    }

    _onKeyDown(e) {
        if (!this.shape || this._sel < 0) return;
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        if (isTextEntry(e.target)) return;   // not while typing (the same rule as the controller's keys)
        e.preventDefault();
        const before = this.bez.anchors.length;
        this.bez = deleteAnchor(this.bez, this._sel);
        if (this.bez.anchors.length === before) return;        // refused (floor: 3 closed, 2 open)
        // A drag or hover in flight names an anchor index that this splice just invalidated: the
        // index is either past the end now, or it silently refers to a DIFFERENT anchor. Drop them
        // — the thing being pointed at no longer exists.
        this._invalidatePointerTargets();
        this._sel = -1; this._recurve(); this._commit(); this.reproject();
    }

    _onWheel(e) {
        if (!this.shape) return;
        e.preventDefault();
        this.adapter.zoom(e.deltaY);
        this._pokeTracking();   // re-track on rAF (the zoom applies on the next render frame)
    }

    _select(i) { this._sel = i; }

    // push the working curve to the host (re-derives membership + re-bakes the white outline)
    _commit() { this.onEdit(cloneBezier(this.bez)); }

    _redraw() {
        const ctx = this.ctx;
        if (!ctx) return;
        this._clearCanvas();
        if (!this.shape || !this.H || !this._uvPoly) return;
        const toPx = (uv) => applyHomography(this.H, uv);

        // the curve: the cached (dense) uv polyline mapped through the current homography. Dense
        // sampling means no chord undercut, so the preview matches the baked cubic outline.
        const poly = this._uvPoly.map(toPx);
        ctx.strokeStyle = COLOR.curve;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(poly[0][0], poly[0][1]);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
        if (isClosed(this.bez)) ctx.closePath();   // an open curve has no closing chord
        ctx.stroke();

        this._anchorPx = this.bez.anchors.map(toPx);

        // the selected anchor's tangent handles (drawn under the anchors so the anchor stays grabbable)
        this._handlePx = null;
        if (this._sel >= 0 && this._sel < this._anchorPx.length) {
            const a = this._anchorPx[this._sel];
            const n = this.bez.anchors.length;
            const open = !isClosed(this.bez);
            // An open curve's endpoints have exactly one live tangent: anchor 0 has only `out`,
            // anchor n-1 only `in`. The other handle coincides with the anchor — a dot on a dot.
            const out = !(open && this._sel === n - 1) ? toPx(this.bez.outHandles[this._sel]) : null;
            const inp = !(open && this._sel === 0) ? toPx(this.bez.inHandles[this._sel]) : null;
            this._handlePx = { out, in: inp };
            ctx.strokeStyle = COLOR.handleLine;
            ctx.lineWidth = 1;
            for (const hp of [out, inp]) {
                if (!hp) continue;
                ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(hp[0], hp[1]); ctx.stroke();
                ctx.beginPath(); ctx.arc(hp[0], hp[1], HANDLE_DOT_R, 0, Math.PI * 2);
                ctx.fillStyle = COLOR.handleFill; ctx.fill();
                ctx.lineWidth = 1.5; ctx.strokeStyle = COLOR.handleStroke; ctx.stroke();
                ctx.strokeStyle = COLOR.handleLine; ctx.lineWidth = 1;
            }
        }

        // the anchors: smooth = circle (●), corner = square (■). Selected = white, hovered = larger.
        ctx.lineWidth = 2;
        ctx.strokeStyle = COLOR.anchorStroke;
        const hoverI = this._hover && this._hover.kind === "anchor" ? this._hover.i : -1;
        for (let i = 0; i < this._anchorPx.length; i++) {
            const a = this._anchorPx[i];
            const big = (i === this._sel || i === hoverI);
            const r = big ? ANCHOR_R_BIG : ANCHOR_R;
            ctx.fillStyle = (i === this._sel) ? COLOR.anchorSel : COLOR.curve;
            ctx.beginPath();
            if (this.bez.smooth[i]) ctx.arc(a[0], a[1], r, 0, Math.PI * 2);
            else ctx.rect(a[0] - r, a[1] - r, r * 2, r * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    destroy() {
        this._stopTracking();
        window.removeEventListener("keydown", this._onKey);
        super.destroy();
    }
}
