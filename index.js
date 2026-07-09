/*
 * index.js — the ROI-drawing controller. Wires the pure core (selection/outline/model) to a
 * ViewerAdapter and the UI. The only host-specific dependency is the adapter, so swapping
 * adapters ports the whole feature to another viewer.
 *
 * Public API (also on window.ROIDraw for the build-time injected bundle):
 *   attach(viewer, opts)  -> ROIDrawer
 *   autoAttach(opts)       -> poll until the viewer is ready, then attach (for make_static onload)
 */
import { PycortexAdapter, surfaceReady, findSurface } from "./adapter/pycortex-adapter.js";
import { ShapeSet } from "./core/shape-model.js";
import { DrawModeMachine } from "./core/draw-mode.js";
import { deriveRoiFromLasso, roiFromBezier, backfillBezier, backfillLabel, curveFromTrace, labelForCurve } from "./draw-pipeline.js";
import { LassoOverlay } from "./ui/lasso-overlay.js";
import { BezierEditOverlay } from "./ui/bezier-edit-overlay.js";
import { DrawPanel } from "./ui/draw-panel.js";
import { ModeToggle } from "./ui/mode-toggle.js";
import css from "./ui/roidraw.css";

const LAYER = "drawnrois";
const FILL_TARGET = 0.70;  // brain fills ~70% of the viewport
const FRAME_LERP = 0.30;   // per-frame damping of the zoom-to-fill during a morph
const FRAME_TRIES = 60;    // _frameOnLoad: polls for a measurable surface, 100 ms apart
const FRAME_POLL_MS = 100;
// Firefox writes a 0-byte file if the anchor is removed / the object URL revoked before the
// download starts, so both are deferred well past the click.
const DOWNLOAD_TEARDOWN_MS = 4000;
const OVERLAY_SYNC_TRIES = 40;  // _sync: retries while the host's SVG overlay is still loading
const OVERLAY_SYNC_MS = 250;    // ...interval between those retries

// The one-line hint under the panel heading, per state. Kept out of _renderStatus so that
// function reads as the state machine it is.
const STATUS = {
    flattening: "Flattening…",
    editing: "Editing — drag ● to move · click an anchor, drag ○ to bend · double-click the line to " +
             "add a point · double-click ● to toggle corner/smooth · select + Delete to remove · " +
             "scroll to zoom · ✓ done when finished.",
    trace: "Drag along the sulcus · ✎ to edit a curve · scroll to zoom · Shift+drag to pan · Shift+click to inspect.",
    lasso: "Lasso to draw an ROI · ✎ to edit a shape · scroll to zoom · Shift+drag to pan · Shift+click to inspect.",
};

/* Byte length of a string once encoded, which is what a downloaded file actually weighs.
 * `str.length` counts UTF-16 code units and undercounts every non-ASCII character in a shape name. */
const byteLength = (s) => new TextEncoder().encode(s).length;

function injectCss() {
    if (document.getElementById("roidraw-css")) return;
    const s = document.createElement("style");
    s.id = "roidraw-css";
    s.textContent = css;
    document.head.appendChild(s);
}

class ROIDrawer {
    constructor(viewer, opts = {}) {
        injectCss();
        this.adapter = new PycortexAdapter(viewer, opts); // throws if the surface isn't ready
        this.shapes = new ShapeSet();
        // Drawing is flat-only. The DrawModeMachine owns the mode and the "reached flat since the
        // last flatten-for-draw" latch, so the transient non-flat mix events emitted *during* a
        // flatten glide don't bounce us back out of Draw. this.mode reads through to it.
        this._dm = new DrawModeMachine();

        this.overlay = new LassoOverlay(this.adapter, {
            onLasso: (pts) => this._finishLasso(pts),
            onTrace: (pts) => this._finishTrace(pts),
            onInspect: (x, y) => this.adapter.inspectAt(x, y),
        });
        this.editOverlay = new BezierEditOverlay(this.adapter, {
            onEdit: (bez) => this._applyEdit(bez),
        });
        this.editingId = null;
        this._timers = new Set();   // pending setTimeout ids, all cancelled by destroy()
        this._syncRetries = 0;      // consecutive failed setOverlayLayer attempts
        this._syncTimer = 0;        // the queued _sync retry, if any
        this.panel = new DrawPanel({
            onExport: () => this.exportJSON(),
            onExportSulci: () => this.exportSulciSVG(),
            onImport: (file) => this._import(file),
            onClear: () => this.clear(),
            onRemove: (id) => this.remove(id),
            onEdit: (id) => this._editToggle(id),
            onTool: (tool) => this._setTool(tool),
        });
        this.toggle = new ModeToggle({ onMode: (m) => this.setMode(m) });

        this._unsubMix = this.adapter.onMixChange(() => this._onMix());
        this._wireKeys();

        this.adapter.applyHostDefaults();         // hide built-in ROIs (keep sulci), collapse panel
        this.adapter.collapseControlPanel(true);
        this._onResize = () => this._positionUI();
        window.addEventListener("resize", this._onResize);

        this.setMode("display");
        this._frameOnLoad(0);                      // center + ~70% fill the default view (glide)
    }

    // The mode ("display"|"draw") is owned by the state machine; read through to it.
    get mode() { return this._dm.mode; }

    /* setTimeout, remembered, so destroy() can cancel it. autoAttach destroys a prior drawer
     * before attaching a new one; an orphaned poll would keep calling a dead adapter. */
    _later(fn, ms) {
        const id = setTimeout(() => { this._timers.delete(id); fn(); }, ms);
        this._timers.add(id);
        return id;
    }

    // --- view framing -----------------------------------------------------------------

    _frame() {
        const fr = this.adapter.measureFrame(FILL_TARGET);
        if (!fr) return;
        this.adapter.setCameraTarget(fr.com);
        const cur = this.adapter.cameraRadius();
        if (typeof cur === "number") this.adapter.setCameraRadius(cur + (fr.radius - cur) * FRAME_LERP);
    }

    _frameOnLoad(tries) {
        const fr = this.adapter.measureFrame(FILL_TARGET);
        if (!fr) { if (tries < FRAME_TRIES) this._later(() => this._frameOnLoad(tries + 1), FRAME_POLL_MS); return; }
        this.adapter.animateCamera({ target: fr.com, radius: fr.radius }); // glide, not a jump
    }

    _onMix() {
        // Drawing is flat-only: once we've reached flat in Draw, any move away from flat (the user
        // inflating / dragging the unfold slider) drops us back to Display. The machine's latch
        // ignores the transient non-flat mix events emitted while Draw's own flatten glide is still
        // in flight, so selecting Draw doesn't immediately bounce back out.
        if (this._dm.noteMix(this.adapter.isFlat()).exit) { this.setMode("display"); return; }
        this._updateDrawActive();   // lasso turns on once the flatten finishes
        if (this.editOverlay.isEditing()) this.editOverlay.reproject();  // keep knots on the surface
        // Auto-frame only while drawing (so Draw's flatten glide stays centered). In Display the user
        // owns the camera; re-framing on every unfold-slider morph there would fight their zoom/pan.
        if (this.mode === "draw") this._frame();
        this._renderStatus();
    }

    // --- modes ------------------------------------------------------------------------

    setMode(mode) {
        // Re-entering Draw would re-flatten and re-arm the machine's latch, stomping on a flatten
        // glide already in flight. (Re-entering Display is idempotent, and the constructor calls
        // setMode("display") to paint the initial UI — so only Draw short-circuits.)
        if (mode === "draw" && this.mode === "draw") return;
        if (mode === "draw") {
            if (this._dm.enterDraw().flatten) this.adapter.flatten();  // flat-only; lasso activates once flat
            this.adapter.setControlPanelVisible(false);
            this.panel.setVisible(true);
        } else {
            this._dm.enterDisplay();
            this._editToggle(null);          // leaving Draw ends any in-progress edit
            this.panel.setVisible(false);
            this.adapter.setControlPanelVisible(true);
        }
        this.toggle.setMode(mode);
        this._updateDrawActive();
        this._positionUI();
        this._renderStatus();
    }

    // Lasso capture is on exactly when we're in Draw mode AND flat AND not editing a shape. Drawing
    // is flat-only; Draw mode flattens automatically, so capture switches on when the morph finishes.
    _updateDrawActive() {
        this.overlay.setActive(this._dm.lassoActive(this.adapter.isFlat(), this.editOverlay.isEditing()));
    }

    // Which gesture a plain drag performs. Ending an in-flight edit first: the edit overlay owns
    // the pointer while it is up, and the new tool's stroke would be swallowed by it.
    _setTool(tool) {
        if (this.editOverlay.isEditing()) this._editToggle(null);
        this.overlay.setTool(tool);
        this._renderStatus();
    }

    _renderStatus() {
        if (this.mode !== "draw") return;   // the panel is hidden in Display mode
        if (!this.adapter.isFlat()) { this.panel.setStatus(STATUS.flattening, "warn"); return; }
        if (this.editOverlay.isEditing()) this.panel.setStatus(STATUS.editing, "draw");
        else this.panel.setStatus(this.overlay.tool === "trace" ? STATUS.trace : STATUS.lasso, "draw");
    }

    // --- drawing pipeline -------------------------------------------------------------

    _finishLasso(pts) {
        // Derive membership + an editable bezier from the lasso: select at the current view, fit a
        // bezier to the ring (flat-UV), then re-derive membership FROM the bezier so the stored
        // vertices match the editable curve (the bezier is the source of truth thereafter). Pure
        // pipeline, testable headless — see draw-pipeline.js / test/draw-pipeline.test.js.
        const sel = deriveRoiFromLasso(this.adapter, pts);
        if (!sel.total) { this.panel.message("0 vertices selected — lasso the flatmap."); return; }

        const fallback = "roi" + (this.shapes.byKind("roi").length + 1);
        const entered = window.prompt("ROI name:", fallback);
        if (entered === null) return;                 // Cancel
        const name = entered.trim() || fallback;      // OK on a blank/whitespace field => use the default
        this.shapes.add({
            kind: "roi", name, left: sel.left, right: sel.right,
            outline: sel.outline, labelVert: sel.labelVert, bezier: sel.bezier,
        });
        this._sync();
        this.panel.message('ROI "' + name + '": ' + sel.total + " vertices." + (sel.bezier ? " ✎ editable." : ""));
    }

    _finishTrace(pts) {
        // A sulcus is an OPEN curve with no vertex membership — pycortex stores none either. The
        // fitted bezier is the whole datum, so there is nothing to re-derive and nothing that can
        // fall out of sync with it.
        const curve = curveFromTrace(this.adapter, pts);
        if (!curve) { this.panel.message("Couldn't fit a curve — trace a longer stroke on the flatmap."); return; }

        const fallback = "sulcus" + (this.shapes.byKind("sulcus").length + 1);
        const entered = window.prompt("Sulcus name (reuse a name for the other hemisphere):", fallback);
        if (entered === null) return;                 // Cancel
        const name = entered.trim() || fallback;
        this.shapes.add({ kind: "sulcus", name, bezier: curve.bezier, labelVert: curve.labelVert });
        this._sync();
        this.panel.message('Sulcus "' + name + '": ' + curve.bezier.anchors.length + " anchors. ✎ editable.");
    }

    // --- editing ----------------------------------------------------------------------

    // Toggle shape editing. id => start editing that shape's bezier; null => stop.
    _editToggle(id) {
        const found = id != null ? this.shapes.shapes.find((s) => s.id === id) : null;
        // Only a shape with an editable curve can be edited. BezierEditOverlay refuses the rest, so
        // accepting one here would leave editingId naming a shape the overlay isn't editing: the
        // panel would highlight it and offer "✓ Done editing" while the lasso stayed armed.
        const shape = (found && found.bezier && found.bezier.anchors) ? found : null;
        // Editing happens on the flatmap (the bezier knots live in the flat view). Starting an edit
        // re-flattens if the surface has been inflated, so the shape's anchors land on the surface.
        if (shape && this._dm.noteEditStart(this.adapter.isFlat()).flatten) this.adapter.flatten();
        this.editingId = shape ? shape.id : null;
        this.editOverlay.setEditing(shape);
        this.panel.setEditingId(this.editingId);
        this._updateDrawActive();            // lasso off while editing, back on when done
        this.panel.renderList(this.shapes.shapes);
        this._renderStatus();
    }

    // A drag-release from the edit overlay: store the new bezier. For an ROI, re-derive its vertex
    // membership from the curve (the bezier is the source of truth). A sulcus HAS no membership.
    _applyEdit(bezier) {
        const shape = this.shapes.shapes.find((s) => s.id === this.editingId);
        if (!shape) return;
        shape.bezier = bezier;
        if (shape.kind === "roi") {
            const d = roiFromBezier(this.adapter, bezier);
            if (d && d.total) { shape.left = d.left; shape.right = d.right; shape.outline = d.outline; shape.labelVert = d.labelVert; }
        } else {
            // A sulcus has no membership to re-derive, but the name label baked onto the surface must
            // follow the curve — otherwise a reshaped sulcus keeps its name at the original midpoint.
            // (This label is live-overlay only; it is never written into the exported SVG.)
            const lv = labelForCurve(this.adapter, bezier);
            if (lv) shape.labelVert = lv;
        }
        this._sync();                       // re-rasterize the smooth outline + refresh the panel row
    }

    // Push the model into the surface overlay and the panel. setOverlayLayer fails while the host's
    // SVG overlay is still loading; without a retry the shape sits in the model and the panel,
    // listed and counted, and is simply never drawn. Poll until it lands.
    _sync() {
        this.panel.renderList(this.shapes.shapes);
        if (this.adapter.setOverlayLayer(LAYER, this.shapes.shapes)) { this._syncRetries = 0; return; }
        if (this._syncTimer) return;   // a retry is already queued, and it will read the latest model
        if (this._syncRetries >= OVERLAY_SYNC_TRIES) {
            this.panel.message("The viewer's SVG overlay never loaded — shapes can't be drawn onto the surface.");
            return;
        }
        if (this._syncRetries++ === 0) this.panel.message("Waiting for the viewer's SVG overlay to load…");
        this._syncTimer = this._later(() => { this._syncTimer = 0; this._sync(); }, OVERLAY_SYNC_MS);
    }

    remove(id) {
        if (id === this.editingId) this._editToggle(null);
        this.shapes.remove(id);
        this._sync();
    }
    clear() { this._editToggle(null); this.shapes.clear(); this._sync(); }

    // --- export / import --------------------------------------------------------------

    _download(text, filename, mime) {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        this._later(() => { a.remove(); URL.revokeObjectURL(url); }, DOWNLOAD_TEARDOWN_MS);
    }

    exportJSON() {
        const rois = this.shapes.byKind("roi");
        if (!rois.length) { this.panel.message("No ROIs to export."); return; }
        let text;
        try { text = JSON.stringify(this.shapes.toJSON(this.adapter.surfaceId()), null, 2); }
        catch (e) { this.panel.message("Export failed: " + (e && e.message ? e.message : e)); return; }
        this._download(text, "rois.json", "application/json");
        this.panel.message("Exported " + rois.length + " ROI(s), " + byteLength(text) + " bytes, to rois.json.");
    }

    /* Sulci export as pycortex's OWN overlays.svg markup, not as a roidraw JSON format: copy the
     * shape groups into the subject's overlays.svg and quickflat/WebGL/Inkscape read them. */
    exportSulciSVG() {
        const sulci = this.shapes.byKind("sulcus");
        if (!sulci.length) { this.panel.message("No sulci to export."); return; }
        let xml;
        try { xml = this.adapter.exportSulciMarkup(sulci); }
        catch (e) { this.panel.message("Export failed: " + (e && e.message ? e.message : e)); return; }
        // null and "" are different failures with different fixes: the adapter can't name the
        // coordinate space yet, versus it could and no curve produced a path.
        if (xml === null) { this.panel.message("Export failed: the viewer's SVG overlay isn't loaded yet — try again in a moment."); return; }
        if (!xml) { this.panel.message("Export failed: no sulcus has a usable curve (each needs at least 2 anchors)."); return; }
        this._download(xml, "sulci.svg", "image/svg+xml");
        this.panel.message("Exported " + sulci.length + " sulcus curve(s), " + byteLength(xml) + " bytes, to sulci.svg.");
    }

    _import(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const text = reader.result;
                if (!text || !String(text).trim()) {
                    this.panel.message("Import failed: “" + file.name + "” is empty (0 bytes). Re-export and try again.");
                    return;
                }
                const added = this.shapes.loadJSON(JSON.parse(text));
                // back-fill an editable bezier for ROIs saved before this feature (v1 files), so
                // imported shapes can be edited just like freshly drawn ones.
                let fitted = 0;
                // Imported documents are vertexset-v2, which is an ROI format — every entry is an
                // ROI. Sulci import is not supported (export is one-way; see the design spec).
                for (const roi of added) {
                    // back-fill a label vertex (same centroid-nearest rule as freshly drawn ROIs)
                    if (!roi.labelVert && roi.outline) {
                        const lv = backfillLabel(this.adapter, roi.outline);
                        if (lv) roi.labelVert = lv;
                    }
                    if (roi.bezier || !roi.outline) continue;
                    const bez = backfillBezier(this.adapter, roi.outline);
                    if (bez) { roi.bezier = bez; fitted++; }
                }
                this._sync();
                this.panel.message("Imported " + added.length + " ROI(s) from " + file.name +
                    (fitted ? " (" + fitted + " made editable)." : "."));
            } catch (err) {
                this.panel.message("Import failed: " + (err && err.message ? err.message : err));
            }
        };
        reader.onerror = () => this.panel.message("Import failed: could not read “" + file.name + "”.");
        reader.readAsText(file);
    }

    // --- ui positioning + keyboard ----------------------------------------------------

    _positionUI() {
        if (this.mode === "display") this.toggle.position(this.adapter.controlPanelRect());
    }

    _wireKeys() {
        this._keydown = (e) => {
            // ignore global shortcuts only while typing in a TEXT field — a file input (Import) is
            // not text entry, so Shift-to-pan must still work even if it happens to hold focus.
            if (this._isTextEntry(e.target)) return;
            if (e.key === "Escape") { if (this.editOverlay.isEditing()) this._editToggle(null); else this.overlay.cancel(); }
            else if (e.key === "Shift") this.overlay.setPassthrough(true);
        };
        this._keyup = (e) => { if (e.key === "Shift") this.overlay.setPassthrough(false); };
        this._blur = () => this.overlay.setPassthrough(false);   // dropping focus must release Shift-pan
        // capture phase: intercept Shift/Esc before the host viewer's own keyboard handlers see them.
        window.addEventListener("keydown", this._keydown, true);
        window.addEventListener("keyup", this._keyup, true);
        window.addEventListener("blur", this._blur);             // stored so destroy() can remove it
    }

    // Tear down everything attach() wired up: pending timers, the mix subscription, the window
    // listeners, the adapter's own host hooks, and every child UI component (each has its own
    // destroy()). Lets a viewer detach/re-attach without leaking — which autoAttach does on reload.
    destroy() {
        for (const id of this._timers) clearTimeout(id);
        this._timers.clear();
        this._syncTimer = 0;
        if (this._unsubMix) this._unsubMix();
        window.removeEventListener("resize", this._onResize);
        window.removeEventListener("keydown", this._keydown, true);
        window.removeEventListener("keyup", this._keyup, true);
        window.removeEventListener("blur", this._blur);
        for (const c of [this.overlay, this.editOverlay, this.panel, this.toggle]) if (c && c.destroy) c.destroy();
        if (this.adapter && this.adapter.destroy) this.adapter.destroy();
    }

    // True only for text-entry targets (so we don't swallow Shift/Esc there). A file/button input
    // is NOT text entry, so global gestures keep working even if such an element holds focus.
    _isTextEntry(t) {
        if (!t) return false;
        if (t.isContentEditable) return true;
        const tag = t.tagName || "";
        if (tag === "TEXTAREA") return true;
        if (tag !== "INPUT") return false;
        return !/^(file|button|checkbox|radio|range|color|submit|reset|image)$/i.test(t.type || "text");
    }
}

export function attach(viewer, opts) { return new ROIDrawer(viewer, opts); }

// Poll until the viewer + surface are ready, then attach. Used by the make_static onload block.
export function autoAttach(opts = {}) {
    let tries = 120; // ~36s
    const go = () => {
        const v = window.viewer;
        if (v && surfaceReady(v)) {
            try {
                if (window.roidrawer && window.roidrawer.destroy) window.roidrawer.destroy();  // don't leak a prior attach
                window.roidrawer = attach(v, opts);
            } catch (e) { console.error("[roidraw] attach failed:", e); }
            return;
        }
        if (tries-- > 0) setTimeout(go, 300);
        else console.warn("[roidraw] viewer never became ready");
    };
    go();
}

if (typeof window !== "undefined") {
    window.ROIDraw = { attach, autoAttach, ROIDrawer, surfaceReady, findSurface };
}
