/*
 * mode-toggle.js — a [ Display | Draw ] segmented toggle. Display = host control panel visible,
 * draw panel hidden; Draw = flat + draw panel, control panel hidden. Host-agnostic; the
 * controller calls position() with the control-panel rect so it can sit just left of it.
 */
export class ModeToggle {
    constructor({ onMode } = {}) {
        const bar = document.createElement("div");
        bar.className = "roidraw-modebar";
        this.displayBtn = this._mkBtn("Display", "display", onMode);
        this.drawBtn = this._mkBtn("Draw", "draw", onMode);
        bar.appendChild(this.displayBtn);
        bar.appendChild(this.drawBtn);
        document.body.appendChild(bar);
        this.el = bar;
    }

    _mkBtn(label, mode, onMode) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "roidraw-modebtn";
        b.textContent = label;
        b.onclick = () => onMode && onMode(mode);
        return b;
    }

    // Remove the toggle bar from the DOM (matches the overlays' destroy(); called by ROIDrawer teardown).
    destroy() { if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el); this.el = null; }

    setMode(mode) {
        this.displayBtn.classList.toggle("roidraw-modebtn--active", mode === "display");
        this.drawBtn.classList.toggle("roidraw-modebtn--active", mode === "draw");
    }

    /* Sit just left of the host control panel (top-aligned); falls back to the CSS default. */
    position(rect) {
        if (rect && rect.width > 0) {
            this.el.style.right = Math.round(window.innerWidth - rect.left + 8) + "px";
            this.el.style.top = Math.round(rect.top) + "px";
        }
    }
}
