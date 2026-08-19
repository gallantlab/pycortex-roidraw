/*
 * index.js — the drawing controller. Wires the pure core (selection/outline/bezier/model) to a
 * ViewerAdapter and the UI. The only host-specific dependency is the adapter, so swapping
 * adapters ports the whole feature to another viewer.
 *
 * Public API (also on window.ROIDraw for the build-time injected bundle):
 *   attach(viewer, opts)  -> ROIDrawer
 *   autoAttach(opts)       -> poll until the viewer is ready, then attach (for make_static onload)
 * `opts` is passed through to the PycortexAdapter ({ animSpeedFallback }).
 */
import { PycortexAdapter, surfaceReady, findSurface } from "./adapter/pycortex-adapter.js";
import { ShapeSet } from "./core/shape-model.js";
import { DrawModeMachine, MODE, TOOL } from "./core/draw-mode.js";
import { TimerSet } from "./core/timer-set.js";
import { deriveRoiFromLasso, roiFromBezier, backfillBezier, backfillLabel, curveFromTrace, labelForCurve } from "./draw-pipeline.js";
import { LassoOverlay } from "./ui/lasso-overlay.js";
import { BezierEditOverlay } from "./ui/bezier-edit-overlay.js";
import { DrawPanel } from "./ui/draw-panel.js";
import { ModeToggle } from "./ui/mode-toggle.js";
import { isTextEntry } from "./ui/dom-utils.js";
import css from "./ui/roidraw.css";

const LAYER = "drawnrois";     // the overlay layer every drawn shape is baked into
const FRAME_LERP = 0.30;       // per-frame damping of the zoom-to-fill during a morph
const FRAME_TRIES = 60;        // _frameOnLoad: polls for a measurable surface, 100 ms apart
const FRAME_POLL_MS = 100;
// Firefox writes a 0-byte file if the anchor is removed / the object URL revoked before the
// download starts, so both are deferred well past the click.
const DOWNLOAD_TEARDOWN_MS = 4000;
const OVERLAY_SYNC_TRIES = 40;   // _sync: retries while the host's SVG overlay is still loading
const OVERLAY_SYNC_MS = 250;     // ...interval between those retries
const AUTOATTACH_TRIES = 120;    // autoAttach: polls for a ready viewer, 300 ms apart (~36 s)
const AUTOATTACH_POLL_MS = 300;

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
        this._timers = new TimerSet();  // every poll/deferred teardown; destroy() cancels them
        this._syncRetries = 0;          // consecutive failed setOverlayLayer attempts
        this._syncTimer = 0;            // the queued _sync retry, if any
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

        this.setMode(MODE.DISPLAY);
        this._frameOnLoad(0);                      // center + fill the default view (glide)
    }

    // The mode (MODE.DISPLAY | MODE.DRAW) is owned by the state machine; read through to it.
    get mode() { return this._dm.mode; }

    // --- view framing -----------------------------------------------------------------
    // measureFrame's fill fraction is the adapter's default (host framing is the adapter's call).

    _frame() {
        const fr = this.adapter.measureFrame();
        if (!fr) return;
        this.adapter.setCameraTarget(fr.com);
        const cur = this.adapter.cameraRadius();
        if (typeof cur === "number") this.adapter.setCameraRadius(cur + (fr.radius - cur) * FRAME_LERP);
    }

    _frameOnLoad(tries) {
        const fr = this.adapter.measureFrame();
        if (!fr) { if (tries < FRAME_TRIES) this._timers.later(() => this._frameOnLoad(tries + 1), FRAME_POLL_MS); return; }
        this.adapter.animateCamera({ target: fr.com, radius: fr.radius }); // glide, not a jump
    }

    _onMix() {
        // Drawing is flat-only: once we've reached flat in Draw, any move away from flat (the user
        // inflating / dragging the unfold slider) drops us back to Display. The machine's latch
        // ignores the transient non-flat mix events emitted while Draw's own flatten glide is still
        // in flight, so selecting Draw doesn't immediately bounce back out.
        if (this._dm.noteMix(this.adapter.isFlat()).exit) { this.setMode(MODE.DISPLAY); return; }
        this._updateDrawActive();   // lasso turns on once the flatten finishes
        if (this.editOverlay.isEditing()) this.editOverlay.reproject();  // keep knots on the surface
        // Auto-frame only while drawing (so Draw's flatten glide stays centered). In Display the user
        // owns the camera; re-framing on every unfold-slider morph there would fight their zoom/pan.
        if (this.mode === MODE.DRAW) this._frame();
        this._renderStatus();
    }

    // --- modes ------------------------------------------------------------------------

    setMode(mode) {
        // Re-entering Draw would re-flatten and re-arm the machine's latch, stomping on a flatten
        // glide already in flight. (Re-entering Display is idempotent, and the constructor calls
        // setMode("display") to paint the initial UI — so only Draw short-circuits.)
        if (mode === MODE.DRAW && this.mode === MODE.DRAW) return;
        if (mode === MODE.DRAW) {
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
        if (this.mode !== MODE.DRAW) return;   // the panel is hidden in Display mode
        if (!this.adapter.isFlat()) { this.panel.setStatus(STATUS.flattening, "warn"); return; }
        if (this.editOverlay.isEditing()) this.panel.setStatus(STATUS.editing, "draw");
        else this.panel.setStatus(this.overlay.tool === TOOL.TRACE ? STATUS.trace : STATUS.lasso, "draw");
    }

    // --- drawing pipeline -------------------------------------------------------------

    _finishLasso(pts) {
        // Derive membership + an editable bezier from the lasso: select at the current view, fit a
        // bezier to the ring (flat-UV), then re-derive membership FROM the bezier so the stored
        // vertices match the editable curve (the bezier is the source of truth thereafter). Pure
        // pipeline, testable headless — see draw-pipeline.js / test/draw-pipeline.test.js.
        const sel = deriveRoiFromLasso(this.adapter, pts);
        if (!sel.total) { this.panel.message("0 vertices selected — lasso the flatmap."); return; }

        const name = this._promptName("ROI name:", "roi");
        if (name === null) return;                    // Cancel
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

        const name = this._promptName("Sulcus name (reuse a name for the other hemisphere):", "sulcus");
        if (name === null) return;                    // Cancel
        this.shapes.add({ kind: "sulcus", name, bezier: curve.bezier, labelVert: curve.labelVert });
        this._sync();
        this.panel.message('Sulcus "' + name + '": ' + curve.bezier.anchors.length + " anchors. ✎ editable.");
    }

    /* Ask for a new shape's name. The default is the model's own numbering for that kind (the same
     * rule an import without a name gets); a blank/whitespace answer takes the default; Cancel
     * returns null and the caller aborts the add. */
    _promptName(label, kind) {
        const fallback = this.shapes.defaultName(kind);
        const entered = window.prompt(label, fallback);
        if (entered === null) return null;
        return entered.trim() || fallback;
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
        this._syncTimer = this._timers.later(() => { this._syncTimer = 0; this._sync(); }, OVERLAY_SYNC_MS);
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
        this._timers.later(() => { a.remove(); URL.revokeObjectURL(url); }, DOWNLOAD_TEARDOWN_MS);
    }

    /* The one export flow: serialize with `build()` (exceptions become a panel message), download
     * the text, and report the byte size. `build` returns the document text, or null to abort after
     * having posted its own message. */
    _export(build, filename, mime, describe) {
        let text;
        try { text = build(); }
        catch (e) { this.panel.message("Export failed: " + (e && e.message ? e.message : e)); return; }
        if (text === null) return;
        this._download(text, filename, mime);
        this.panel.message("Exported " + describe + ", " + byteLength(text) + " bytes, to " + filename + ".");
    }

    exportJSON() {
        const rois = this.shapes.byKind("roi");
        if (!rois.length) { this.panel.message("No ROIs to export."); return; }
        this._export(() => JSON.stringify(this.shapes.toJSON(this.adapter.surfaceId()), null, 2),
            "rois.json", "application/json", rois.length + " ROI(s)");
    }

    /* Sulci export as pycortex's OWN overlays.svg markup, not as a roidraw JSON format: copy the
     * shape groups into the subject's overlays.svg and quickflat/WebGL/Inkscape read them. */
    exportSulciSVG() {
        const sulci = this.shapes.byKind("sulcus");
        if (!sulci.length) { this.panel.message("No sulci to export."); return; }
        this._export(() => {
            const xml = this.adapter.exportSulciMarkup(sulci);
            // null and "" are different failures with different fixes: the adapter can't name the
            // coordinate space yet, versus it could and no curve produced a path.
            if (xml === null) { this.panel.message("Export failed: the viewer's SVG overlay isn't loaded yet — try again in a moment."); return null; }
            if (!xml) { this.panel.message("Export failed: no sulcus has a usable curve (each needs at least 2 anchors)."); return null; }
            return xml;
        }, "sulci.svg", "image/svg+xml", sulci.length + " sulcus curve(s)");
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
        if (this.mode === MODE.DISPLAY) this.toggle.position(this.adapter.controlPanelRect());
    }

    _wireKeys() {
        this._keydown = (e) => {
            // ignore global shortcuts only while typing in a TEXT field — a file input (Import) is
            // not text entry, so Shift-to-pan must still work even if it happens to hold focus.
            if (isTextEntry(e.target)) return;
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
    // listeners, the baked overlay layer, the adapter's own host hooks, and every child UI
    // component (each has its own destroy()). Lets a viewer detach/re-attach without leaking —
    // which autoAttach does on reload. The layer is cleared here (not in the adapter's destroy)
    // because the controller owns the layer name; a re-attach would otherwise bake a second
    // layer with the same id on top of the orphaned first.
    destroy() {
        this._timers.clear();
        this._syncTimer = 0;
        if (this._unsubMix) this._unsubMix();
        window.removeEventListener("resize", this._onResize);
        window.removeEventListener("keydown", this._keydown, true);
        window.removeEventListener("keyup", this._keyup, true);
        window.removeEventListener("blur", this._blur);
        for (const c of [this.overlay, this.editOverlay, this.panel, this.toggle]) if (c && c.destroy) c.destroy();
        try { this.adapter.setOverlayLayer(LAYER, []); }
        catch (e) { console.warn("[roidraw] clearing the overlay layer on destroy failed:", e); }
        if (this.adapter.destroy) this.adapter.destroy();
    }
}

export function attach(viewer, opts) { return new ROIDrawer(viewer, opts); }

// Poll until the viewer + surface are ready, then attach. Used by the make_static onload block.
export function autoAttach(opts = {}) {
    let tries = AUTOATTACH_TRIES;
    const go = () => {
        const v = window.viewer;
        if (v && surfaceReady(v)) {
            try {
                if (window.roidrawer && window.roidrawer.destroy) window.roidrawer.destroy();  // don't leak a prior attach
                window.roidrawer = attach(v, opts);
            } catch (e) { console.error("[roidraw] attach failed:", e); }
            return;
        }
        if (tries-- > 0) setTimeout(go, AUTOATTACH_POLL_MS);
        else console.warn("[roidraw] viewer never became ready");
    };
    go();
}

if (typeof window !== "undefined") {
    window.ROIDraw = { attach, autoAttach, ROIDrawer, surfaceReady, findSurface };
}
