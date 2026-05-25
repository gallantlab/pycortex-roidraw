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
import { selectInPolygon } from "./core/selection.js";
import { buildOutline, pickLabelVertex } from "./core/outline.js";
import { LassoOverlay } from "./ui/lasso-overlay.js";
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
        this.mode = "display";

        this.overlay = new LassoOverlay(this.adapter, {
            onLasso: (pts) => this._finishLasso(pts),
            onInspect: (x, y) => this.adapter.inspectAt(x, y),
        });
        this.panel = new DrawPanel({
            onExport: () => this.exportJSON(),
            onImport: (file) => this._import(file),
            onClear: () => this.clear(),
            onRemove: (id) => this.remove(id),
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
        this._updateDrawActive();   // lasso turns on once the flatten finishes
        this._frame();
        this._renderStatus();
    }

    // --- modes ------------------------------------------------------------------------

    setMode(mode) {
        this.mode = mode;
        if (mode === "draw") {
            this.adapter.setControlPanelVisible(false);
            this.panel.setVisible(true);
            this.adapter.flatten();          // lasso activates once flat (see _updateDrawActive)
        } else {
            this.panel.setVisible(false);
            this.adapter.setControlPanelVisible(true);
        }
        this.toggle.setMode(mode);
        this._updateDrawActive();
        this._positionUI();
        this._renderStatus();
    }

    // Lasso capture is on exactly when we're in Draw mode AND the surface is flat. Drawing is
    // flat-only; Draw mode flattens automatically, so capture switches on when the morph finishes.
    _updateDrawActive() {
        this.overlay.setActive(this.mode === "draw" && this.adapter.isFlat());
    }

    _renderStatus() {
        if (this.mode !== "draw") return;   // the panel is hidden in Display mode
        if (this.adapter.isFlat()) this.panel.setStatus("Lasso to draw · scroll to zoom · Shift+drag to pan · Shift+click to inspect.", "draw");
        else this.panel.setStatus("Flattening…", "warn");
    }

    // --- drawing pipeline -------------------------------------------------------------

    _finishLasso(pts) {
        const projected = this.adapter.projectVertices({ subsample: 1 });
        const sel = selectInPolygon(projected, pts);
        if (!sel.total) { this.panel.message("0 vertices selected — lasso the flatmap."); return; }
        const name = window.prompt("ROI name:", "roi" + (this.rois.length + 1));
        if (name === null) return;
        this.rois.add({
            name, left: sel.left, right: sel.right,
            outline: buildOutline(pts, sel),
            labelVert: pickLabelVertex(sel),
        });
        this._sync();
        this.panel.message('ROI "' + name + '": ' + sel.total + " vertices.");
    }

    _sync() {
        this.adapter.setOverlayLayer(LAYER, this.rois.rois);
        this.panel.renderList(this.rois.rois);
    }

    remove(id) { this.rois.remove(id); this._sync(); }
    clear() { this.rois.clear(); this._sync(); }

    // --- export / import --------------------------------------------------------------

    exportJSON() {
        if (!this.rois.length) { this.panel.message("Nothing to export."); return; }
        const blob = new Blob([JSON.stringify(this.rois.toJSON(this.adapter.surfaceId()), null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "rois.json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.panel.message("Exported " + this.rois.length + " ROI(s) to rois.json.");
    }

    _import(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                this.rois.loadJSON(JSON.parse(reader.result));
                this._sync();
                this.panel.message("Imported from " + file.name + ".");
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
            const tag = (e.target && e.target.tagName) || "";
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            if (e.key === "Escape") this.overlay.cancel();
            else if (e.key === "Shift") this.overlay.setPassthrough(true);
        };
        this._keyup = (e) => { if (e.key === "Shift") this.overlay.setPassthrough(false); };
        window.addEventListener("keydown", this._keydown, true);
        window.addEventListener("keyup", this._keyup, true);
        window.addEventListener("blur", () => this.overlay.setPassthrough(false));
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
