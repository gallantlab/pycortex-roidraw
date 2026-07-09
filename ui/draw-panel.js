/*
 * draw-panel.js — the ROI control panel (status, Draw toggle, ROI list, export/import/clear,
 * message line). Host-agnostic; built from DOM nodes (names go through textContent, so an ROI
 * named with HTML can't inject). Styling is in roidraw.css.
 */
export class DrawPanel {
    constructor({ onExport, onExportSulci, onImport, onClear, onRemove, onEdit, onTool } = {}) {
        this.onRemove = onRemove || (() => {});
        this.onEdit = onEdit || (() => {});
        this.onTool = onTool || (() => {});
        this._editingId = null;

        const el = document.createElement("div");
        el.className = "roidraw-panel";

        const h = document.createElement("h2");
        h.textContent = "ROI draw";
        el.appendChild(h);

        // Which gesture a plain drag performs. An ROI is a closed lasso; a sulcus is an open trace.
        this.tool = "lasso";
        const tools = document.createElement("div");
        tools.className = "roidraw-tools";
        tools.setAttribute("role", "group");
        tools.setAttribute("aria-label", "shape kind");
        this._toolBtns = {};
        for (const [tool, label] of [["lasso", "ROI"], ["trace", "Sulcus"]]) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "roidraw-tools__btn";
            b.textContent = label;
            b.setAttribute("aria-pressed", String(tool === this.tool));
            b.onclick = () => this.setTool(tool);
            this._toolBtns[tool] = b;
            tools.appendChild(b);
        }
        el.appendChild(tools);

        this.statusEl = document.createElement("div");
        this.statusEl.className = "roidraw-status";
        el.appendChild(this.statusEl);

        // big, obvious "finish editing" control — shown only while a shape is being edited
        this.doneEl = document.createElement("button");
        this.doneEl.type = "button";
        this.doneEl.className = "roidraw-done";
        this.doneEl.textContent = "✓ Done editing";
        this.doneEl.style.display = "none";
        this.doneEl.onclick = () => this.onEdit(null);
        el.appendChild(this.doneEl);

        this.listEl = document.createElement("div");
        this.listEl.className = "roidraw-list";
        el.appendChild(this.listEl);

        const exp = document.createElement("button");
        exp.type = "button";
        exp.textContent = "Export ROIs (JSON)";
        exp.onclick = () => onExport && onExport();
        el.appendChild(exp);

        const expS = document.createElement("button");
        expS.type = "button";
        expS.textContent = "Export sulci (SVG)";
        expS.onclick = () => onExportSulci && onExportSulci();
        el.appendChild(expS);

        const lab = document.createElement("label");
        lab.textContent = "Import: ";
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "application/json";
        inp.onchange = (e) => {
            const f = e.target.files && e.target.files[0];
            if (f && onImport) onImport(f);
            e.target.value = "";
            e.target.blur();   // don't keep keyboard focus on the file input (Shift-to-pan needs body focus)
        };
        lab.appendChild(inp);
        el.appendChild(lab);

        const clr = document.createElement("button");
        clr.type = "button";
        clr.textContent = "Clear all";
        clr.onclick = () => onClear && onClear();
        el.appendChild(clr);

        this.msgEl = document.createElement("div");
        this.msgEl.className = "roidraw-msg";
        el.appendChild(this.msgEl);

        document.body.appendChild(el);
        this.el = el;
        // Paint the initial segmented-control state WITHOUT firing onTool: this.panel isn't
        // assigned yet in ROIDrawer's constructor, and onTool routes through this.panel.setStatus.
        this._reflectTool();
        this.renderList([]);
    }

    // The id of the ROI currently being edited (highlighted + its Edit link reads "done"), or null.
    setEditingId(id) { this._editingId = id; }

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
        this.tool = tool === "trace" ? "trace" : "lasso";
        this._reflectTool();
        this.onTool(this.tool);
    }

    setStatus(text, kind = "ok") {
        this.statusEl.textContent = text;
        this.statusEl.className = "roidraw-status roidraw-status--" + kind;
    }

    message(text) { this.msgEl.textContent = text; }

    setVisible(on) { this.el.style.display = on ? "" : "none"; }

    // Remove the panel from the DOM (matches the overlays' destroy(); called by ROIDrawer teardown).
    destroy() { if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el); this.el = null; }

    renderList(shapes) {
        const ed = shapes.find((s) => s.id === this._editingId);
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
            const editing = s.id === this._editingId;
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

            // edit toggle — a real button (bigger hit target); only shapes with a bezier can edit
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "roidraw-roi__editbtn" + (editing ? " roidraw-roi__editbtn--on" : "");
            edit.textContent = editing ? "editing" : "✎ edit";
            edit.title = s.bezier ? (editing ? "finish editing" : "edit shape") : "no editable curve";
            edit.disabled = !s.bezier;
            edit.onclick = (e) => { e.preventDefault(); if (s.bezier) this.onEdit(editing ? null : s.id); };
            row.appendChild(edit);

            // a real <button> (keyboard-focusable + activatable), not an href-less <a>
            const del = document.createElement("button");
            del.type = "button";
            del.className = "roidraw-roi__del";
            del.textContent = "✕";
            del.title = "remove";
            del.setAttribute("aria-label", "remove " + (sulcus ? "sulcus " : "ROI ") + s.name);
            del.onclick = (e) => { e.preventDefault(); this.onRemove(s.id); };
            row.appendChild(del);

            list.appendChild(row);
        }
    }
}
