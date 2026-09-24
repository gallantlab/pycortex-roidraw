/*
 * mode-toggle.js — a [ Display | Draw ] segmented toggle. Display = host control panel visible,
 * draw panel hidden; Draw = flat + draw panel, control panel hidden. Host-agnostic; the
 * controller calls position() with the control-panel rect so it can sit just left of it.
 */
import { MODE } from "../core/draw-mode.js";
import { button } from "./dom-utils.js";

const PANEL_GAP = 8;   // px between the toggle and the host control panel's left edge

export class ModeToggle {
    constructor({ onMode } = {}) {
        const pick = onMode || (() => {});
        const bar = document.createElement("div");
        bar.className = "roidraw-modebar";
        this.displayBtn = button("Display", () => pick(MODE.DISPLAY), "roidraw-modebtn");
        this.drawBtn = button("Draw", () => pick(MODE.DRAW), "roidraw-modebtn");
        bar.appendChild(this.displayBtn);
        bar.appendChild(this.drawBtn);
        document.body.appendChild(bar);
        this.el = bar;
    }

    // Remove the toggle bar from the DOM (every UI component has a destroy(); ROIDrawer calls them all).
    destroy() { this.el?.remove(); this.el = null; }

    setMode(mode) {
        this.displayBtn.classList.toggle("roidraw-modebtn--active", mode === MODE.DISPLAY);
        this.drawBtn.classList.toggle("roidraw-modebtn--active", mode === MODE.DRAW);
    }

    /* Sit just left of the host control panel (top-aligned); falls back to the CSS default. */
    position(rect) {
        if (rect && rect.width > 0) {
            this.el.style.right = Math.round(window.innerWidth - rect.left + PANEL_GAP) + "px";
            this.el.style.top = Math.round(rect.top) + "px";
        }
    }
}
