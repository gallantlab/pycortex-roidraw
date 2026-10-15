/*
 * index.js — the drawing controller. Wires the pure core (selection/outline/bezier/model) to a
 * ViewerAdapter and the UI. Everything it asks of the host goes through the ViewerAdapter
 * contract (adapter/viewer-adapter.js, including its optional methods). The one pycortex tie is
 * that the drawer constructs a PycortexAdapter (and autoAttach polls pycortex's surfaceReady), so
 * porting to another viewer means implementing that contract and constructing its adapter here.
 *
 * Public API (also on window.ROIDraw for the build-time injected bundle):
 *   attach(viewer, opts)  -> ROIDrawer
 *   autoAttach(opts)       -> poll until the viewer is ready, then attach (for make_static onload)
 * `opts` is passed through to the PycortexAdapter ({ animSpeedFallback, pointRadius }).
 *
 * ROIs and sulci are drawn on the flatmap; points are clicked onto the surface at any unfold mix.
 * On a surface without a flatmap (adapter.hasFlat() false) only the Point tool is offered.
 */
import { PycortexAdapter, surfaceReady, findSurface, preflightHost } from "./adapter/pycortex-adapter.js";
import { ShapeSet, describePoint } from "./core/shape-model.js";
import { DrawModeMachine, MODE, TOOL, toolNeedsFlat } from "./core/draw-mode.js";
import { TimerSet } from "./core/timer-set.js";
import { deriveRoiFromLasso, roiFromBezier, backfillImported, curveFromTrace, labelForCurve } from "./draw-pipeline.js";
import { byteLength, downloadText, readTextFile } from "./io.js";
import { LassoOverlay } from "./ui/lasso-overlay.js";
import { PointPicker } from "./ui/point-picker.js";
import { BezierEditOverlay } from "./ui/bezier-edit-overlay.js";
import { DrawPanel } from "./ui/draw-panel.js";
import { ModeToggle } from "./ui/mode-toggle.js";
import { isTextEntry } from "./ui/dom-utils.js";
import css from "./ui/roidraw.css";

const LAYER = "drawnrois";     // the overlay layer every drawn shape is baked into
const FRAME_LERP = 0.30;       // per-frame damping of the zoom-to-fill during a morph
const FRAME_TRIES = 60;        // _frameOnLoad: attempts at measuring the surface, 100 ms apart
const FRAME_POLL_MS = 100;
const AUTOATTACH_TRIES = 120;  // autoAttach: attempts at finding a ready viewer, 300 ms apart (~36 s)
const AUTOATTACH_POLL_MS = 300;
const SYNC_TRIES = 40;         // _sync: attempts at baking into the SVG overlay, 250 ms apart (~10 s)
const SYNC_POLL_MS = 250;
const XYZ_MATCH_MM = 0.01;     // imported point: file xyz vs this mesh's vertex position, max distance

// The one-line hint under the panel heading, per state. Kept out of _renderStatus so that
// function reads as the state machine it is.
const STATUS = {
    flattening: "Flattening…",
    editing: "Editing — drag ● to move · click an anchor, drag ○ to bend · double-click the line to " +
             "add a point · double-click ● to toggle corner/smooth · select + Delete to remove · " +
             "scroll to zoom · ✓ done when finished.",
    trace: "Drag along the sulcus · ✎ to edit a curve · scroll to zoom · Shift+drag to pan · Shift+click to inspect.",
    lasso: "Lasso to draw an ROI · ✎ to edit a shape · scroll to zoom · Shift+drag to pan · Shift+click to inspect.",
    point: "Click the surface to place a point · drag to rotate · scroll to zoom · ✎ move to re-place a point.",
    moving: "Click the surface where the point should go · Esc to cancel.",
};

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
        this._timers = new TimerSet();  // every poll/deferred teardown; destroy() cancels them
        this._destroyed = false;
        this.adapter = new PycortexAdapter(viewer, opts); // throws if the surface isn't ready
        // Everything below installs host listeners, timers, or DOM. If any step throws, undo the
        // steps that already ran (destroy() tolerates the parts that never got built).
        try {
            this.shapes = new ShapeSet();
            // ROI/sulcus drawing is flat-only (the Point tool is not). The DrawModeMachine owns the mode and the "reached flat since
            // the last flatten-for-draw" latch, so the transient non-flat mix events emitted
            // *during* a flatten glide don't bounce us back out of Draw. this.mode reads through to it.
            this._dm = new DrawModeMachine();

            this.lasso = new LassoOverlay(this.adapter, {
                onLasso: (pts) => this._finishLasso(pts),
                onTrace: (pts) => this._finishTrace(pts),
                onInspect: (x, y) => this.adapter.inspectAt(x, y),
            });
            this.editOverlay = new BezierEditOverlay(this.adapter, {
                onEdit: (bez) => this._applyEdit(bez),
            });
            this.picker = new PointPicker(this.adapter, { onPick: (x, y) => this._pickPoint(x, y) });
            this.editingId = null;          // the shape being edited (a curve) or moved (a point)
            this._syncPending = false;      // a _sync poll is waiting for the host's SVG overlay
            this._reader = null;            // the in-flight import read, if any
            this.panel = new DrawPanel({
                onExport: () => this.exportJSON(),
                onExportSulci: () => this.exportSulciSVG(),
                onExportPoints: () => this.exportPointsJSON(),
                onImport: (file) => this._import(file),
                onClear: () => this.clear(),
                onRemove: (id) => this.remove(id),
                onEdit: (id) => this._setEditing(id),
                onTool: (tool) => this._setTool(tool),
            });
            this.toggle = new ModeToggle({ onMode: (m) => this.setMode(m) });
            // No flatmap: points only. Disabling the flat tools moves the selection to Point.
            if (!this.adapter.hasFlat()) this.panel.setFlatToolsEnabled(false);

            this._unsubMix = this.adapter.onMixChange(() => this._onMix());
            this._wireKeys();

            this.adapter.applyHostDefaults();         // hide built-in ROIs (keep sulci), collapse panel
            this.adapter.collapseControlPanel(true);
            this._onResize = () => this._positionUI();
            window.addEventListener("resize", this._onResize);

            this.setMode(MODE.DISPLAY);
            this._frameOnLoad();                       // center + fill the default view (glide)
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    // The mode (MODE.DISPLAY | MODE.DRAW) is owned by the state machine; read through to it.
    get mode() { return this._dm.mode; }

    // The active tool is the panel's selection.
    get tool() { return this.panel.tool; }

    // The point being moved (editingId names a point), or null.
    _movingPoint() {
        const s = this.editingId != null ? this.shapes.get(this.editingId) : null;
        return s && s.kind === "point" ? s : null;
    }

    // --- view framing -----------------------------------------------------------------

    _frame() {
        const fr = this.adapter.measureFrame();
        if (!fr) return;
        this.adapter.setCameraTarget(fr.com);
        const cur = this.adapter.cameraRadius();
        this.adapter.setCameraRadius(cur + (fr.radius - cur) * FRAME_LERP);
    }

    // Glide to the framed view once the surface can be measured (it may still be loading).
    _frameOnLoad() {
        this._timers.poll(() => {
            const fr = this.adapter.measureFrame();
            if (fr) this.adapter.animateCamera({ target: fr.com, radius: fr.radius }); // glide, not a jump
            return !!fr;
        }, { tries: FRAME_TRIES, ms: FRAME_POLL_MS });
    }

    _onMix() {
        // ROI/sulcus drawing is flat-only: once we've reached flat in Draw with a flat tool, any move away from flat (the user
        // inflating / dragging the unfold slider) drops us back to Display. The machine's latch
        // ignores the transient non-flat mix events emitted while Draw's own flatten glide is still
        // in flight, so selecting Draw doesn't immediately bounce back out.
        if (this._dm.noteMix(this.adapter.isFlat()).exit) { this.setMode(MODE.DISPLAY); return; }
        this._updateDrawActive();   // lasso turns on once the flatten finishes
        this.editOverlay.track();   // keep knots on the surface (a no-op when not editing)
        // Auto-frame only while drawing with a flat tool (so Draw's flatten glide stays centered). In
        // Display, and with the Point tool (which unfolds freely), the user owns the camera:
        // re-framing on every unfold-slider morph would fight their zoom/pan.
        if (this.mode === MODE.DRAW && this._dm.needsFlat) this._frame();
        this._renderStatus();
    }

    // --- modes ------------------------------------------------------------------------

    setMode(mode) {
        // Re-entering Draw would re-flatten and re-arm the machine's latch, stomping on a flatten
        // glide already in flight. (Re-entering Display is idempotent, and the constructor calls
        // setMode("display") to paint the initial UI — so only Draw short-circuits.)
        if (mode === MODE.DRAW && this.mode === MODE.DRAW) return;
        if (mode === MODE.DRAW) {
            // flat tools flatten (the lasso activates once flat); the Point tool keeps the current view
            if (this._dm.enterDraw(toolNeedsFlat(this.tool)).flatten) this.adapter.flatten();
            this.adapter.setControlPanelVisible(false);
            this.panel.setVisible(true);
        } else {
            this._dm.enterDisplay();
            this._setEditing(null);          // leaving Draw ends any in-progress edit
            this.panel.setVisible(false);
            this.adapter.setControlPanelVisible(true);
        }
        this.toggle.setMode(mode);
        this._updateDrawActive();
        this._positionUI();
        this._renderStatus();
    }

    // Lasso capture is on exactly when we're in Draw mode AND flat AND not editing a shape AND a flat
    // tool is selected. Drawing ROIs/sulci is flat-only; Draw mode flattens automatically for those
    // tools, so capture switches on when the morph finishes. Point picking is on in Draw with the
    // Point tool, at any mix (moving a point selects the Point tool first).
    _updateDrawActive() {
        this.lasso.setActive(this._dm.lassoActive(this.adapter.isFlat(), this.editOverlay.isEditing()));
        this.picker.setActive(this.tool === TOOL.POINT && this.mode === MODE.DRAW);
    }

    // Which gesture the pointer performs. Ending an in-flight edit first: the edit overlay owns
    // the pointer while it is up, and the new tool's stroke would be swallowed by it. A pending point
    // move ends when another tool is chosen. A flat tool on an inflated surface re-flattens.
    _setTool(tool) {
        if (this.editOverlay.isEditing()) this._setEditing(null);
        if (tool !== TOOL.POINT && this._movingPoint()) this._setEditing(null);
        this.lasso.setTool(tool);
        if (this._dm.setNeedsFlat(toolNeedsFlat(tool), this.adapter.isFlat()).flatten) this.adapter.flatten();
        this._updateDrawActive();
        this._renderStatus();
    }

    _renderStatus() {
        if (this.mode !== MODE.DRAW) return;   // the panel is hidden in Display mode
        if (this.tool === TOOL.POINT) {
            this.panel.setStatus(this._movingPoint() ? STATUS.moving : STATUS.point, "draw");
            return;
        }
        if (!this.adapter.isFlat()) { this.panel.setStatus(STATUS.flattening, "warn"); return; }
        if (this.editOverlay.isEditing()) this.panel.setStatus(STATUS.editing, "draw");
        else this.panel.setStatus(this.lasso.tool === TOOL.TRACE ? STATUS.trace : STATUS.lasso, "draw");
    }

    // --- drawing pipeline -------------------------------------------------------------

    _finishLasso(pts) {
        // Membership + an editable bezier from the lasso; see draw-pipeline.js.
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

    // A click with the Point tool: place a new point at the vertex under the cursor, or move the
    // point being moved there.
    _pickPoint(x, y) {
        if (!this.adapter.canPick()) { this.panel.message("The viewer is still loading — try again in a moment."); return; }
        const v = this.adapter.pickVertex(x, y);
        if (!v) { this.panel.message("No surface under the cursor — click on the brain."); return; }
        const where = describePoint(v, v.xyz);
        const moving = this._movingPoint();
        if (moving) {
            moving.vert = { h: v.h, g: v.g };
            moving.xyz = v.xyz || null;
            this._setEditing(null);
            this._sync();
            this.panel.message('Moved point "' + moving.name + '" to ' + where + ".");
            return;
        }
        const name = this._promptName("Point name:", "point");
        if (name === null) return;                    // Cancel
        this.shapes.add({ kind: "point", name, vert: { h: v.h, g: v.g }, xyz: v.xyz });
        this._sync();
        this.panel.message('Point "' + name + '": ' + where + ".");
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

    // Start editing shape `id`'s bezier (or moving point `id`), or stop editing (null).
    _setEditing(id) {
        const found = id != null ? this.shapes.get(id) : null;
        if (found && found.kind === "point") {
            // A point moves with the next click: no overlay, no flatten. Select the Point tool first
            // (which ends any curve edit and re-renders), then name the point being moved.
            if (this.tool !== TOOL.POINT) this.panel.setTool(TOOL.POINT);
            this.editingId = found.id;
            this._updateDrawActive();
            this.panel.renderList(this.shapes.shapes, this.editingId);
            this._renderStatus();
            return;
        }
        // Only a shape with an editable curve can be edited. BezierEditOverlay refuses the rest, so
        // accepting one here would leave editingId naming a shape the overlay isn't editing: the
        // panel would highlight it and offer "✓ Done editing" while the lasso stayed armed.
        const shape = (found && found.bezier && found.bezier.anchors) ? found : null;
        // A curve is edited with its own tool selected (the Point tool's click-picking would sit
        // under the edit overlay otherwise).
        // That tool switch already re-flattens an inflated surface, so it must not flatten twice.
        const switched = !!shape && this.tool === TOOL.POINT;
        if (switched) this.panel.setTool(shape.kind === "sulcus" ? TOOL.TRACE : TOOL.LASSO);
        // Editing happens on the flatmap (the bezier knots live in the flat view). Starting an edit
        // re-flattens if the surface has been inflated, so the shape's anchors land on the surface.
        if (shape && !switched && this._dm.noteEditStart(this.adapter.isFlat()).flatten) this.adapter.flatten();
        this.editingId = shape ? shape.id : null;
        this.editOverlay.setEditing(shape);
        this._updateDrawActive();            // lasso off while editing, back on when done
        this.panel.renderList(this.shapes.shapes, this.editingId);
        this._renderStatus();
    }

    // A drag-release from the edit overlay: store the new bezier. For an ROI, re-derive its vertex
    // membership from the curve (the bezier is the source of truth) — and refuse a curve that
    // encloses no vertex, since storing it would leave the bezier and the vertices disagreeing.
    // A sulcus HAS no membership. Returns false to refuse the edit (the overlay then reverts).
    _applyEdit(bezier) {
        const shape = this.shapes.get(this.editingId);
        if (!shape) return false;
        if (shape.kind === "roi") {
            const d = roiFromBezier(this.adapter, bezier);
            if (!d || !d.total) {
                this.panel.message("That edit encloses no vertices — reverted.");
                return false;
            }
            shape.bezier = bezier;
            shape.left = d.left; shape.right = d.right; shape.outline = d.outline; shape.labelVert = d.labelVert;
        } else {
            shape.bezier = bezier;
            // A sulcus has no membership to re-derive, but the name label baked onto the surface must
            // follow the curve — otherwise a reshaped sulcus keeps its name at the original midpoint.
            // (This label is live-overlay only; it is never written into the exported SVG.)
            const lv = labelForCurve(this.adapter, bezier);
            if (lv) shape.labelVert = lv;
        }
        this._sync();                       // re-rasterize the smooth outline + refresh the panel row
        return true;
    }

    // Push the model into the surface (curves into the SVG overlay, points as markers) and the panel.
    // Either can fail while the host is still loading; without a retry the shape sits in the model
    // and the panel, listed and counted, and is simply never drawn. Poll until both land. A point
    // whose vertex isn't in this mesh can never be drawn, so the user is told rather than left with
    // a listed point that never appears.
    _sync() {
        this.panel.renderList(this.shapes.shapes, this.editingId);
        if (this._syncPending) return;   // a poll is already waiting, and it reads the latest model
        let first = true;
        this._syncPending = true;
        this._timers.poll(() => {
            let curves, markers;
            try {
                curves = this.adapter.setOverlayLayer(LAYER, this.shapes.shapes.filter((s) => s.kind !== "point"));
                markers = this.adapter.setPointMarkers(this.shapes.byKind("point"));
            }
            catch (e) { this._syncPending = false; throw e; }   // a throw must not wedge every later _sync
            if (curves && markers !== false) {
                this._syncPending = false;
                if (markers > 0) this.panel.message(markers + " point(s) can't be drawn: their vertex isn't in this viewer's mesh.");
                return true;
            }
            if (first) { first = false; this.panel.message("Waiting for the viewer to finish loading…"); }
            return false;
        }, {
            tries: SYNC_TRIES, ms: SYNC_POLL_MS,
            onGiveUp: () => {
                this._syncPending = false;
                this.panel.message("The viewer never finished loading (SVG overlay or picker) — shapes can't be drawn onto the surface.");
            },
        });
    }

    remove(id) {
        if (id === this.editingId) this._setEditing(null);
        this.shapes.remove(id);
        this._sync();
    }
    clear() { this._setEditing(null); this.shapes.clear(); this._sync(); }

    // --- export / import --------------------------------------------------------------

    /* The one export flow: serialize with `build()` (exceptions become a panel message), download
     * the text, and report the byte size. `build` returns the document text, or null to abort after
     * having posted its own message. */
    _export(build, filename, mime, describe) {
        let text;
        try { text = build(); }
        catch (e) { this.panel.message("Export failed: " + (e && e.message ? e.message : e)); return; }
        if (text === null) return;
        downloadText(text, filename, mime, this._timers);
        this.panel.message("Exported " + describe + ", " + byteLength(text) + " bytes, to " + filename + ".");
    }

    exportJSON() {
        const rois = this.shapes.byKind("roi");
        if (!rois.length) { this.panel.message("No ROIs to export."); return; }
        this._export(() => JSON.stringify(this.shapes.toJSON(this.adapter.surfaceId()), null, 2),
            "rois.json", "application/json", rois.length + " ROI(s)");
    }

    exportPointsJSON() {
        const points = this.shapes.byKind("point");
        if (!points.length) { this.panel.message("No points to export."); return; }
        this._export(() => JSON.stringify(this.shapes.toPointsJSON(this.adapter.surfaceId()), null, 2),
            "points.json", "application/json", points.length + " point(s)");
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
        this._reader = readTextFile(file, {
            onText: (text) => {
                if (this._destroyed) return;
                this._reader = null;
                try {
                    if (!text || !String(text).trim()) {
                        this.panel.message("Import failed: “" + file.name + "” is empty (0 bytes). Re-export and try again.");
                        return;
                    }
                    // A vertexset (ROIs; sulci export is one-way) or a points document. ROI files
                    // saved before the bezier feature get an editable bezier and a label vertex
                    // back-filled, so they edit like fresh ROIs. ROIs can't be drawn without a
                    // flatmap, so on such a surface they are dropped (and said so), never listed undrawn.
                    const doc = JSON.parse(text);
                    const added = this.shapes.loadJSON(doc);
                    let rois = added.filter((s) => s.kind === "roi");
                    let note = "";
                    if (rois.length && !this.adapter.hasFlat()) {
                        for (const r of rois) this.shapes.remove(r.id);
                        note += " " + rois.length + " ROI(s) skipped — this surface has no flatmap.";
                        rois = [];
                    }
                    const points = this._checkImportedPoints(added.filter((s) => s.kind === "point"), doc);
                    note += points.note;
                    const fitted = rois.length ? backfillImported(this.adapter, rois) : 0;
                    this._sync();
                    const parts = [];
                    if (rois.length) parts.push(rois.length + " ROI(s)" + (fitted ? " (" + fitted + " made editable)" : ""));
                    if (points.kept) parts.push(points.kept + " point(s)");
                    this.panel.message("Imported " + (parts.join(" + ") || "nothing") + " from " + file.name + "." + note);
                } catch (err) {
                    this.panel.message("Import failed: " + (err && err.message ? err.message : err));
                }
            },
            onError: () => {
                if (this._destroyed) return;
                this._reader = null;
                this.panel.message("Import failed: could not read “" + file.name + "”.");
            },
        });
    }

    /* Imported points name vertices by index, which only means the same place in a viewer built from
     * the same mesh. Each point's file xyz is checked against this mesh's position for that vertex:
     * a point whose vertex is missing, or sits elsewhere (another subject, another CTM build), is
     * dropped — never drawn at the wrong anatomy. Kept points take this mesh's xyz. */
    _checkImportedPoints(points, doc) {
        const surface = this.adapter.surfaceId();
        let note = doc.surface && doc.surface !== surface ? " File is for “" + doc.surface + "”, this viewer is “" + surface + "”." : "";
        let dropped = 0;
        for (const p of points) {
            const here = this.adapter.vertexPosition(p.vert);
            const off = here && p.xyz ? Math.hypot(here[0] - p.xyz[0], here[1] - p.xyz[1], here[2] - p.xyz[2]) : 0;
            if (!here || off > XYZ_MATCH_MM) { this.shapes.remove(p.id); dropped++; continue; }
            p.xyz = here;
        }
        if (dropped) note += " " + dropped + " point(s) dropped — their vertex isn't at the same place in this viewer's mesh.";
        return { kept: points.length - dropped, note };
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
            if (e.key === "Escape") {
                if (this.editOverlay.isEditing() || this._movingPoint()) this._setEditing(null);
                else this.lasso.cancel();
            }
            else if (e.key === "Shift") this.lasso.setPassthrough(true);
        };
        this._keyup = (e) => { if (e.key === "Shift") this.lasso.setPassthrough(false); };
        this._blur = () => this.lasso.setPassthrough(false);   // dropping focus must release Shift-pan
        // capture phase: intercept Shift/Esc before the host viewer's own keyboard handlers see them.
        window.addEventListener("keydown", this._keydown, true);
        window.addEventListener("keyup", this._keyup, true);
        window.addEventListener("blur", this._blur);             // stored so destroy() can remove it
    }

    // Tear down everything attach() wired up: pending timers, an in-flight import read, the mix
    // subscription, the window listeners, the baked overlay layer, the adapter's own host hooks,
    // and every child UI component (each has its own destroy()). Lets a viewer detach/re-attach
    // without leaking — which autoAttach does on reload. The layer is cleared here (not in the
    // adapter's destroy) because the controller owns the layer name; a re-attach would otherwise
    // bake a second layer with the same id on top of the orphaned first. Idempotent, and safe on
    // a drawer whose constructor failed partway.
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._timers.clear();
        this._syncPending = false;
        if (this._reader) { this._reader.abort(); this._reader = null; }
        if (this._unsubMix) this._unsubMix();
        window.removeEventListener("resize", this._onResize);
        window.removeEventListener("keydown", this._keydown, true);
        window.removeEventListener("keyup", this._keyup, true);
        window.removeEventListener("blur", this._blur);
        for (const c of [this.lasso, this.picker, this.editOverlay, this.panel, this.toggle]) if (c && c.destroy) c.destroy();
        try { this.adapter.setOverlayLayer(LAYER, []); this.adapter.setPointMarkers([]); }
        catch (e) { console.warn("[roidraw] clearing the overlay layer on destroy failed:", e); }
        if (this.adapter.destroy) this.adapter.destroy();
    }
}

export function attach(viewer, opts) { return new ROIDrawer(viewer, opts); }

// The one autoAttach poll in flight: a second autoAttach call replaces it rather than racing it.
const autoAttachTimers = new TimerSet();

// Poll until the viewer + surface are ready, then attach. Used by the make_static onload block.
// A prior drawer is destroyed first (and window.roidrawer cleared, so a failed attach never
// leaves a dead drawer published there).
export function autoAttach(opts = {}) {
    autoAttachTimers.clear();
    autoAttachTimers.poll(() => {
        const v = window.viewer;
        if (!v || !surfaceReady(v)) return false;
        const prev = window.roidrawer;
        window.roidrawer = null;
        if (prev && prev.destroy) {
            try { prev.destroy(); }
            catch (e) { console.warn("[roidraw] destroying the previous drawer failed:", e); }
        }
        try { window.roidrawer = attach(v, opts); }
        catch (e) { console.error("[roidraw] attach failed:", e); }
        return true;
    }, {
        tries: AUTOATTACH_TRIES, ms: AUTOATTACH_POLL_MS,
        onGiveUp: () => {
            // Say what never showed up (e.g. a viewer with no flatmap has no uv), not just "not ready".
            const { missing } = preflightHost({ THREE: globalThis.THREE, mriview: globalThis.mriview,
                svgoverlay: globalThis.svgoverlay, viewer: window.viewer });
            console.warn("[roidraw] viewer never became ready" +
                (missing.length ? " — missing: " + missing.join(", ") : ""));
        },
    });
}

if (typeof window !== "undefined") {
    window.ROIDraw = { attach, autoAttach, ROIDrawer, surfaceReady, findSurface };
}
