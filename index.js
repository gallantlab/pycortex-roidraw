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
import { ROISet } from "./core/roi-model.js";
import { DrawModeMachine } from "./core/draw-mode.js";
import { deriveRoiFromLasso, roiFromBezier, backfillBezier } from "./draw-pipeline.js";
import { LassoOverlay } from "./ui/lasso-overlay.js";
import { BezierEditOverlay } from "./ui/bezier-edit-overlay.js";
import { DrawPanel } from "./ui/draw-panel.js";
import { ModeToggle } from "./ui/mode-toggle.js";
import css from "./ui/roidraw.css";

const LAYER = "drawnrois";
const FILL_TARGET = 0.70;  // brain fills ~70% of the viewport
const FRAME_LERP = 0.30;   // per-frame damping of the zoom-to-fill during a morph

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
        this.rois = new ROISet();
        // Drawing is flat-only. The DrawModeMachine owns the mode and the "reached flat since the
        // last flatten-for-draw" latch, so the transient non-flat mix events emitted *during* a
        // flatten glide don't bounce us back out of Draw. this.mode reads through to it.
        this._dm = new DrawModeMachine();

        this.overlay = new LassoOverlay(this.adapter, {
            onLasso: (pts) => this._finishLasso(pts),
            onInspect: (x, y) => this.adapter.inspectAt(x, y),
        });
        this.editOverlay = new BezierEditOverlay(this.adapter, {
            onEdit: (bez) => this._applyEdit(bez),
        });
        this.editingId = null;
        this.panel = new DrawPanel({
            onExport: () => this.exportJSON(),
            onImport: (file) => this._import(file),
            onClear: () => this.clear(),
            onRemove: (id) => this.remove(id),
            onEdit: (id) => this._editToggle(id),
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
        if (!fr) { if (tries < 60) setTimeout(() => this._frameOnLoad(tries + 1), 100); return; }
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
        this._frame();
        this._renderStatus();
    }

    // --- modes ------------------------------------------------------------------------

    setMode(mode) {
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

    _renderStatus() {
        if (this.mode !== "draw") return;   // the panel is hidden in Display mode
        if (!this.adapter.isFlat()) { this.panel.setStatus("Flattening…", "warn"); return; }
        if (this.editOverlay.isEditing()) this.panel.setStatus("Editing — drag ● to move · click an anchor, drag ○ to bend · double-click the line to add a point · double-click ● to toggle corner/smooth · select + Delete to remove · scroll to zoom · ✓ done when finished.", "draw");
        else this.panel.setStatus("Lasso to draw · ✎ to edit a shape · scroll to zoom · Shift+drag to pan · Shift+click to inspect.", "draw");
    }

    // --- drawing pipeline -------------------------------------------------------------

    _finishLasso(pts) {
        // Derive membership + an editable bezier from the lasso: select at the current view, fit a
        // bezier to the ring (flat-UV), then re-derive membership FROM the bezier so the stored
        // vertices match the editable curve (the bezier is the source of truth thereafter). Pure
        // pipeline, testable headless — see draw-pipeline.js / test/draw-pipeline.test.js.
        const sel = deriveRoiFromLasso(this.adapter, pts);
        if (!sel.total) { this.panel.message("0 vertices selected — lasso the flatmap."); return; }

        const name = window.prompt("ROI name:", "roi" + (this.rois.length + 1));
        if (name === null) return;
        this.rois.add({
            name, left: sel.left, right: sel.right,
            outline: sel.outline, labelVert: sel.labelVert, bezier: sel.bezier,
        });
        this._sync();
        this.panel.message('ROI "' + name + '": ' + sel.total + " vertices." + (sel.bezier ? " ✎ editable." : ""));
    }

    // --- editing ----------------------------------------------------------------------

    // Toggle shape editing. id => start editing that ROI's bezier; null => stop.
    _editToggle(id) {
        const roi = id != null ? this.rois.rois.find((r) => r.id === id) : null;
        // Editing happens on the flatmap (the bezier knots live in the flat view). Starting an edit
        // re-flattens if the surface has been inflated, so the shape's anchors land on the surface.
        if (roi && this._dm.noteEditStart(this.adapter.isFlat()).flatten) this.adapter.flatten();
        this.editingId = roi ? roi.id : null;
        this.editOverlay.setEditing(roi || null);
        this.panel.setEditingId(this.editingId);
        this._updateDrawActive();            // lasso off while editing, back on when done
        this.panel.renderList(this.rois.rois);
        this._renderStatus();
    }

    // A drag-release from the edit overlay: store the new bezier and re-derive vertices from it.
    _applyEdit(bezier) {
        const roi = this.rois.rois.find((r) => r.id === this.editingId);
        if (!roi) return;
        roi.bezier = bezier;
        const d = roiFromBezier(this.adapter, bezier);
        if (d && d.total) { roi.left = d.left; roi.right = d.right; roi.outline = d.outline; roi.labelVert = d.labelVert; }
        this.adapter.setOverlayLayer(LAYER, this.rois.rois);   // re-rasterize the smooth outline
        this.panel.renderList(this.rois.rois);                 // refresh the vertex count
    }

    _sync() {
        this.adapter.setOverlayLayer(LAYER, this.rois.rois);
        this.panel.renderList(this.rois.rois);
    }

    remove(id) {
        if (id === this.editingId) this._editToggle(null);
        this.rois.remove(id);
        this._sync();
    }
    clear() { this._editToggle(null); this.rois.clear(); this._sync(); }

    // --- export / import --------------------------------------------------------------

    exportJSON() {
        if (!this.rois.length) { this.panel.message("Nothing to export."); return; }
        let text;
        try { text = JSON.stringify(this.rois.toJSON(this.adapter.surfaceId()), null, 2); }
        catch (e) { this.panel.message("Export failed: " + (e && e.message ? e.message : e)); return; }
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "rois.json";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        // Firefox writes a 0-byte file if the anchor is removed / the URL revoked before the
        // download starts — defer both well past the click instead of tearing down immediately.
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
        this.panel.message("Exported " + this.rois.length + " ROI(s), " + text.length + " bytes, to rois.json.");
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
                const added = this.rois.loadJSON(JSON.parse(text));
                // back-fill an editable bezier for ROIs saved before this feature (v1 files), so
                // imported shapes can be edited just like freshly drawn ones.
                let fitted = 0;
                for (const roi of added) {
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
        window.addEventListener("keydown", this._keydown, true);
        window.addEventListener("keyup", this._keyup, true);
        window.addEventListener("blur", () => this.overlay.setPassthrough(false));
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
            try { window.roidrawer = attach(v, opts); }
            catch (e) { console.error("[roidraw] attach failed:", e); }
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
