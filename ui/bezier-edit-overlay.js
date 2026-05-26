/*
 * bezier-edit-overlay.js — a transparent 2D canvas over the flatmap for EDITING an ROI's bezier
 * by dragging its anchor knots. Host-agnostic: it only needs the adapter to locate the surface
 * canvas and to project the vertices around the ROI (for the uv<->px transform of the current view).
 *
 * The bezier is stored in view-independent flat-UV; to show and grab its knots we fit a homography
 * uv->px from the vertices LOCAL to the ROI (the flatmap isn't perfectly planar, so a single global
 * homography drifts — locally it's near-exact), and invert it to map a drag back to uv. v1 is "drag
 * knots only": moving a knot recomputes the Catmull-Rom tangent handles, so the curve stays smooth
 * without the user touching handles.
 *
 *   onEdit(bezier)  — fired on drag-release with the updated bezier (host re-derives membership).
 */
import { fitHomography, applyHomography, invertHomography } from "../core/transform.js";
import { bezierFromAnchors, evalClosedBezier } from "../core/bezier.js";

const HIT_RADIUS = 9;        // px; how close a click must be to grab a knot
const TRACK_MS = 500;        // after a zoom/pan, keep re-tracking the surface for this long
const LOCAL_MARGIN = 0.06;   // uv padding around the ROI for the LOCAL homography fit
const CURVE_SAMPLES = 40;    // samples/segment when stroking the preview curve (kills chord undercut)

export class BezierEditOverlay {
    constructor(adapter, { onEdit } = {}) {
        this.adapter = adapter;
        this.onEdit = onEdit || (() => {});
        this.roi = null;
        this.anchors = null;    // working copy [[u,v],...]; handles are derived on the fly
        this._uvPoly = null;    // the bezier sampled to a uv polyline; recomputed only when anchors change
        this.H = null;          // uv -> px
        this.Hinv = null;       // px -> uv
        this._anchorPx = [];    // cached knot px for hit-testing/redraw
        this._drag = -1;        // index of the knot being dragged, or -1
        this._hover = -1;
        this._panLast = null;
        this._raf = 0;          // requestAnimationFrame id of the post-gesture tracking loop
        this._trackUntil = 0;   // timestamp the tracking loop should run until

        const el = document.createElement("canvas");
        el.className = "roidraw-overlay roidraw-edit-overlay";
        document.body.appendChild(el);
        this.el = el;
        this.ctx = el.getContext("2d");

        this._onResize = () => this.reproject();
        window.addEventListener("resize", this._onResize);
        el.addEventListener("mousedown", (e) => this._onDown(e));
        el.addEventListener("mousemove", (e) => this._onMove(e));
        el.addEventListener("mouseup", (e) => this._onUp(e));
        el.addEventListener("mouseleave", (e) => { if (this._drag >= 0 || this._panLast) this._onUp(e); });
        el.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    }

    syncRect() {
        const r = this.adapter.canvas().getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
        this.el.style.left = Math.round(r.left) + "px";
        this.el.style.top = Math.round(r.top) + "px";
        this.el.style.width = w + "px";
        this.el.style.height = h + "px";
        // assigning canvas.width/height clears the bitmap + resets the 2D context, so only do it on
        // an actual size change (syncRect runs every tracking frame, where the size rarely changes).
        if (this.el.width !== w || this.el.height !== h) { this.el.width = w; this.el.height = h; }
    }

    // Begin editing `roi` (must have a bezier), or pass null to stop.
    setEditing(roi) {
        this.roi = roi && roi.bezier && roi.bezier.anchors ? roi : null;
        this.anchors = this.roi ? this.roi.bezier.anchors.map((p) => [p[0], p[1]]) : null;
        this._recurve();
        this._drag = -1; this._hover = -1; this._panLast = null;
        this.el.style.pointerEvents = this.roi ? "auto" : "none";
        this.el.classList.toggle("roidraw-edit-overlay--active", !!this.roi);
        if (this.roi) { this.syncRect(); this.reproject(); } else { this._stopTracking(); this._clear(); }
    }

    isEditing() { return !!this.roi; }

    // Re-sample the bezier to a uv polyline. Only the anchors change (on a knot drag), never the
    // view — so caching this lets the per-frame tracking loop just re-map it through the new
    // homography instead of rebuilding + re-sampling the curve every frame.
    _recurve() {
        this._uvPoly = (this.anchors && this.anchors.length >= 3)
            ? evalClosedBezier(bezierFromAnchors(this.anchors), CURVE_SAMPLES) : null;
    }

    // The viewer applies a camera change on its NEXT render frame, so reprojecting synchronously in
    // a wheel/pan handler reads a stale camera (knots lag the surface by a frame, and a damped zoom
    // keeps gliding for several). Instead, re-track on rAF for a short window after the gesture, so
    // the knots follow the surface every frame until the camera settles.
    _pokeTracking() {
        this._trackUntil = (typeof performance !== "undefined" ? performance.now() : Date.now()) + TRACK_MS;
        if (!this._raf) this._raf = requestAnimationFrame(() => this._trackFrame());
    }

    _trackFrame() {
        this._raf = 0;
        if (!this.roi) return;
        this.reproject();
        const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
        if (now < this._trackUntil) this._raf = requestAnimationFrame(() => this._trackFrame());
    }

    _stopTracking() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; } this._trackUntil = 0; }

    // Re-fit the uv->px homography for the current view and redraw. Call on pan/zoom/mix/resize.
    // The fit is LOCAL to the ROI: the flatmap isn't perfectly planar, so one global homography
    // drifts (the curve sits slightly inside the baked outline), but around a single ROI it's
    // near-exact. Falls back to the whole flatmap only if the local region is too sparse on screen.
    reproject() {
        if (!this.roi || !this.anchors || this.anchors.length < 3) { this._clear(); return; }
        this.syncRect();
        let c = this._correspondences(this._anchorUvBounds(LOCAL_MARGIN));
        // If the ROI region is too sparse on screen, fall back to the whole flatmap — but ONLY to
        // bootstrap the very first fit. Once we have a homography we keep it rather than reprojecting
        // every vertex each frame in the tracking loop (which would stall when the ROI is off-screen).
        if (c.src.length < 6 && !this.H) c = this._correspondences(null);
        if (c.src.length >= 4) {
            const H = fitHomography(c.src, c.dst);
            if (H) { this.H = H; this.Hinv = invertHomography(H); }   // else keep the last good fit
        }
        this._redraw();
    }

    // uv->px correspondences from the vertices inside `bounds` (or the whole flatmap if null).
    _correspondences(bounds) {
        const b = bounds || { minu: -Infinity, maxu: Infinity, minv: -Infinity, maxv: Infinity };
        const proj = this.adapter.projectVerticesInUvBounds(b);
        const src = [], dst = [];
        for (const h of ["left", "right"]) {
            const p = proj[h];
            if (!p) continue;
            for (let i = 0; i < p.uv.length; i++) { src.push(p.uv[i]); dst.push(p.px[i]); }
        }
        return { src, dst };
    }

    // uv bounding box of the current anchors, padded by `m`.
    _anchorUvBounds(m) {
        let minu = Infinity, maxu = -Infinity, minv = Infinity, maxv = -Infinity;
        for (const a of this.anchors) {
            if (a[0] < minu) minu = a[0];
            if (a[0] > maxu) maxu = a[0];
            if (a[1] < minv) minv = a[1];
            if (a[1] > maxv) maxv = a[1];
        }
        return { minu: minu - m, maxu: maxu + m, minv: minv - m, maxv: maxv + m };
    }

    _evtPt(e) { const r = this.el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

    _hitTest(pt) {
        let best = -1, bd = HIT_RADIUS * HIT_RADIUS;
        for (let i = 0; i < this._anchorPx.length; i++) {
            const a = this._anchorPx[i];
            const dx = a[0] - pt[0], dy = a[1] - pt[1], d = dx * dx + dy * dy;
            if (d <= bd) { bd = d; best = i; }
        }
        return best;
    }

    _onDown(e) {
        if (!this.roi || !this.Hinv) return;
        e.preventDefault();
        const pt = this._evtPt(e);
        const hit = this._hitTest(pt);
        if (hit >= 0 && !e.shiftKey) { this._drag = hit; this.el.style.cursor = "grabbing"; }  // grab a knot
        else { this._panLast = pt; }                                                            // empty (or Shift): pan
    }

    _onMove(e) {
        const pt = this._evtPt(e);
        if (this._drag >= 0) {
            e.preventDefault();
            this.anchors[this._drag] = applyHomography(this.Hinv, pt);   // px -> uv
            this._recurve();                                              // anchors changed
            this._redraw();
            return;
        }
        if (this._panLast) {
            this.adapter.pan(pt[0] - this._panLast[0], pt[1] - this._panLast[1]);
            this._panLast = pt;
            this._pokeTracking();   // re-track on rAF (the pan applies on the next render frame)
            return;
        }
        const hov = this._hitTest(pt);
        if (hov !== this._hover) { this._hover = hov; this.el.style.cursor = hov >= 0 ? "grab" : "default"; this._redraw(); }
    }

    _onUp() {
        const wasDragging = this._drag >= 0;
        this._drag = -1; this._panLast = null;
        this.el.style.cursor = this._hover >= 0 ? "grab" : "default";
        if (wasDragging) {
            this.onEdit(bezierFromAnchors(this.anchors));   // commit -> host re-derives + re-bakes
            this.reproject();                                // realign the local fit to the new shape
        }
    }

    _onWheel(e) {
        if (!this.roi) return;
        e.preventDefault();
        this.adapter.zoom(e.deltaY);
        this._pokeTracking();   // re-track on rAF (the zoom applies on the next render frame)
    }

    _clear() { if (this.ctx) this.ctx.clearRect(0, 0, this.el.width, this.el.height); }

    _redraw() {
        const ctx = this.ctx;
        if (!ctx) return;
        this._clear();
        if (!this.roi || !this.H || !this._uvPoly) return;

        // the curve: the cached (dense) uv polyline mapped through the current homography. Dense
        // sampling means no chord undercut, so the preview matches the baked cubic outline.
        const poly = this._uvPoly.map((uv) => applyHomography(this.H, uv));
        ctx.strokeStyle = "#39d0ff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(poly[0][0], poly[0][1]);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
        ctx.closePath();
        ctx.stroke();

        // the draggable knots
        this._anchorPx = this.anchors.map((uv) => applyHomography(this.H, uv));
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#0a3a4a";
        for (let i = 0; i < this._anchorPx.length; i++) {
            const a = this._anchorPx[i], r = (i === this._drag || i === this._hover) ? 6 : 4;
            ctx.beginPath();
            ctx.arc(a[0], a[1], r, 0, Math.PI * 2);
            ctx.fillStyle = (i === this._drag) ? "#fff" : "#39d0ff";
            ctx.fill();
            ctx.stroke();
        }
    }

    destroy() {
        this._stopTracking();
        window.removeEventListener("resize", this._onResize);
        if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }
}
