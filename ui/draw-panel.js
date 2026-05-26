/*
 * draw-panel.js — the ROI control panel (status, Draw toggle, ROI list, export/import/clear,
 * message line). Host-agnostic; built from DOM nodes (names go through textContent, so an ROI
 * named with HTML can't inject). Styling is in roidraw.css.
 */
export class DrawPanel {
    constructor({ onExport, onImport, onClear, onRemove, onEdit } = {}) {
        this.onRemove = onRemove || (() => {});
        this.onEdit = onEdit || (() => {});
        this._editingId = null;

        const el = document.createElement("div");
        el.className = "roidraw-panel";

        const h = document.createElement("h2");
        h.textContent = "ROI draw";
        el.appendChild(h);

        this.statusEl = document.createElement("div");
        this.statusEl.className = "roidraw-status";
        el.appendChild(this.statusEl);

        // big, obvious "finish editing" control — shown only while a shape is being edited
        this.doneEl = document.createElement("button");
        this.doneEl.className = "roidraw-done";
        this.doneEl.textContent = "✓ Done editing";
        this.doneEl.style.display = "none";
        this.doneEl.onclick = () => this.onEdit(null);
        el.appendChild(this.doneEl);

        this.listEl = document.createElement("div");
        this.listEl.className = "roidraw-list";
        el.appendChild(this.listEl);

        const exp = document.createElement("button");
        exp.textContent = "Export JSON";
        exp.onclick = () => onExport && onExport();
        el.appendChild(exp);

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
        clr.textContent = "Clear all";
        clr.onclick = () => onClear && onClear();
        el.appendChild(clr);

        this.msgEl = document.createElement("div");
        this.msgEl.className = "roidraw-msg";
        el.appendChild(this.msgEl);

        document.body.appendChild(el);
        this.el = el;
        this.renderList([]);
    }

    // The id of the ROI currently being edited (highlighted + its Edit link reads "done"), or null.
    setEditingId(id) { this._editingId = id; }

    setStatus(text, kind = "ok") {
        this.statusEl.textContent = text;
        this.statusEl.className = "roidraw-status roidraw-status--" + kind;
    }

    message(text) { this.msgEl.textContent = text; }

    setVisible(on) { this.el.style.display = on ? "" : "none"; }

    renderList(rois) {
        // surface the editing ROI's name on the big Done button (and show/hide it)
        const ed = rois.find((r) => r.id === this._editingId);
        this.doneEl.style.display = ed ? "" : "none";
        if (ed) this.doneEl.textContent = "✓ Done editing “" + ed.name + "”";

        const list = this.listEl;
        list.textContent = "";
        if (!rois.length) {
            const e = document.createElement("span");
            e.className = "roidraw-list__empty";
            e.textContent = "no ROIs yet";
            list.appendChild(e);
            return;
        }
        for (const r of rois) {
            const editing = r.id === this._editingId;
            const row = document.createElement("div");
            row.className = "roidraw-roi" + (editing ? " roidraw-roi--editing" : "");

            const sw = document.createElement("span");
            sw.className = "roidraw-roi__swatch";
            sw.style.background = r.color;            // style property (not HTML) — safe
            row.appendChild(sw);

            const nm = document.createElement("span");
            nm.className = "roidraw-roi__name";
            nm.textContent = r.name;                  // textContent — no injection
            row.appendChild(nm);

            const ct = document.createElement("span");
            ct.className = "roidraw-roi__count";
            ct.textContent = String(r.left.length + r.right.length);
            row.appendChild(ct);

            // edit toggle — a real button (bigger hit target); only ROIs with a bezier can edit
            const edit = document.createElement("button");
            edit.className = "roidraw-roi__editbtn" + (editing ? " roidraw-roi__editbtn--on" : "");
            edit.textContent = editing ? "editing" : "✎ edit";
            edit.title = r.bezier ? (editing ? "finish editing" : "edit shape") : "no editable curve";
            edit.disabled = !r.bezier;
            edit.onclick = (e) => { e.preventDefault(); if (r.bezier) this.onEdit(editing ? null : r.id); };
            row.appendChild(edit);

            const del = document.createElement("a");
            del.className = "roidraw-roi__del";
            del.textContent = "✕";
            del.title = "remove";
            del.onclick = (e) => { e.preventDefault(); this.onRemove(r.id); };
            row.appendChild(del);

            list.appendChild(row);
        }
    }
}
