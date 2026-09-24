/*
 * draw-panel.js — the drawing control panel (status, kind selector, shape list, export/import/clear,
 * message line). Host-agnostic; built from DOM nodes (names go through textContent, so a shape
 * named with HTML can't inject). Styling is in roidraw.css.
 */

import { TOOL, asTool } from "../core/draw-mode.js";
import { button } from "./dom-utils.js";

const noop = () => {};

export class DrawPanel {
    // Every callback is normalized to a no-op once, here, so no call site has to guard.
    constructor({ onExport, onExportSulci, onImport, onClear, onRemove, onEdit, onTool } = {}) {
        this.onExport = onExport || noop;
        this.onExportSulci = onExportSulci || noop;
        this.onImport = onImport || noop;
        this.onClear = onClear || noop;
        this.onRemove = onRemove || noop;
        this.onEdit = onEdit || noop;
        this.onTool = onTool || noop;

        const el = document.createElement("div");
        el.className = "roidraw-panel";

        const h = document.createElement("h2");
        h.textContent = "Draw ROIs + sulci";
        el.appendChild(h);

        // Which gesture a plain drag performs. An ROI is a closed lasso; a sulcus is an open trace.
        this.tool = TOOL.LASSO;
        const tools = document.createElement("div");
        tools.className = "roidraw-tools";
        tools.setAttribute("role", "group");
        tools.setAttribute("aria-label", "shape kind");
        this._toolBtns = {};
        for (const [tool, label] of [[TOOL.LASSO, "ROI"], [TOOL.TRACE, "Sulcus"]]) {
            const b = button(label, () => this.setTool(tool), "roidraw-tools__btn");
            b.setAttribute("aria-pressed", String(tool === this.tool));
            this._toolBtns[tool] = b;
            tools.appendChild(b);
        }
        el.appendChild(tools);

        this.statusEl = document.createElement("div");
        this.statusEl.className = "roidraw-status";
        el.appendChild(this.statusEl);

        // big, obvious "finish editing" control — shown only while a shape is being edited
        this.doneEl = button("✓ Done editing", () => this.onEdit(null), "roidraw-action roidraw-done");
        this.doneEl.style.display = "none";
        el.appendChild(this.doneEl);

        this.listEl = document.createElement("div");
        this.listEl.className = "roidraw-list";
        el.appendChild(this.listEl);

        el.appendChild(button("Export ROIs (JSON)", () => this.onExport(), "roidraw-action"));
        el.appendChild(button("Export sulci (SVG)", () => this.onExportSulci(), "roidraw-action"));

        // Import reads the ROI JSON only. Sulci export is one-way, into pycortex's own overlays.svg.
        const lab = document.createElement("label");
        lab.textContent = "Import: ";
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json,application/json";
        inp.onchange = (e) => {
            const f = e.target.files && e.target.files[0];
            if (f) this.onImport(f);
            e.target.value = "";
            e.target.blur();   // don't keep keyboard focus on the file input (Shift-to-pan needs body focus)
        };
        lab.appendChild(inp);
        el.appendChild(lab);

        el.appendChild(button("Clear all", () => this.onClear(), "roidraw-action"));

        this.msgEl = document.createElement("div");
        this.msgEl.className = "roidraw-msg";
        el.appendChild(this.msgEl);

        document.body.appendChild(el);
        this.el = el;
        // Paint the initial segmented-control state WITHOUT firing onTool: the owner is still
        // constructing this panel and may not be ready to handle a callback yet.
        this._reflectTool();
        this.renderList([]);
    }

    /* Paint the segmented control to match this.tool. Fires no callback. */
    _reflectTool() {
        for (const [t, b] of Object.entries(this._toolBtns)) {
            const on = t === this.tool;
            b.classList.toggle("roidraw-tools__btn--on", on);
            b.setAttribute("aria-pressed", String(on));
        }
    }

    /* Select the active draw tool, reflect it, and notify the controller. */
    setTool(tool) {
        this.tool = asTool(tool);
        this._reflectTool();
        this.onTool(this.tool);
    }

    /* The one-line hint under the heading. kind: "draw" (normal) | "warn" (flattening). */
    setStatus(text, kind) {
        this.statusEl.textContent = text;
        this.statusEl.className = "roidraw-status roidraw-status--" + kind;
    }

    message(text) { this.msgEl.textContent = text; }

    setVisible(on) { this.el.style.display = on ? "" : "none"; }

    // Remove the panel from the DOM (every UI component has a destroy(); ROIDrawer calls them all).
    destroy() { this.el?.remove(); this.el = null; }

    // Rebuild the shape list. `editingId` is the id of the shape (ROI or sulcus) being edited — its
    // row is highlighted, its edit button reads "editing", and the "✓ Done editing" control shows —
    // or null.
    renderList(shapes, editingId = null) {
        const ed = editingId == null ? null : shapes.find((s) => s.id === editingId);
        this.doneEl.style.display = ed ? "" : "none";
        if (ed) this.doneEl.textContent = "✓ Done editing “" + ed.name + "”";

        const list = this.listEl;
        list.textContent = "";
        if (!shapes.length) {
            const e = document.createElement("span");
            e.className = "roidraw-list__empty";
            e.textContent = "nothing drawn yet";
            list.appendChild(e);
            return;
        }
        for (const s of shapes) {
            const editing = s === ed;
            const sulcus = s.kind === "sulcus";
            const row = document.createElement("div");
            row.className = "roidraw-roi" + (editing ? " roidraw-roi--editing" : "");

            const sw = document.createElement("span");
            sw.className = "roidraw-roi__swatch";
            sw.style.background = s.color;            // style property (not HTML) — safe
            row.appendChild(sw);

            // Duplicate names are legal (a sulcus is traced once per hemisphere), and an ROI and a
            // sulcus may share a name too — so the row states its kind.
            const kd = document.createElement("span");
            kd.className = "roidraw-roi__kind";
            kd.textContent = sulcus ? "∿" : "◯";
            kd.title = sulcus ? "sulcus" : "ROI";
            row.appendChild(kd);

            const nm = document.createElement("span");
            nm.className = "roidraw-roi__name";
            nm.textContent = s.name;                  // textContent — no injection
            row.appendChild(nm);

            const ct = document.createElement("span");
            ct.className = "roidraw-roi__count";
            // ROIs count enclosed vertices; a sulcus has no membership, so it counts its anchors.
            ct.textContent = sulcus
                ? String(s.bezier && s.bezier.anchors ? s.bezier.anchors.length : 0)
                : String(s.left.length + s.right.length);
            ct.title = sulcus ? "anchors" : "vertices";
            row.appendChild(ct);

            // edit toggle — a real button (bigger hit target); only shapes with a bezier can edit.
            // The controller re-checks the bezier: a disabled button is a UI courtesy, not a guard.
            const edit = button(editing ? "editing" : "✎ edit", () => this.onEdit(editing ? null : s.id),
                "roidraw-roi__editbtn" + (editing ? " roidraw-roi__editbtn--on" : ""));
            edit.title = s.bezier ? (editing ? "finish editing" : "edit shape") : "no editable curve";
            edit.disabled = !s.bezier;
            row.appendChild(edit);

            // a real <button> (keyboard-focusable + activatable), not an href-less <a>
            const del = button("✕", () => this.onRemove(s.id), "roidraw-roi__del");
            del.title = "remove";
            del.setAttribute("aria-label", "remove " + (sulcus ? "sulcus " : "ROI ") + s.name);
            row.appendChild(del);

            list.appendChild(row);
        }
    }
}
