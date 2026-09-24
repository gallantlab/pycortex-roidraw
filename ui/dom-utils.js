/*
 * dom-utils.js — small DOM helpers shared by the UI and the controller: the one button factory
 * every roidraw control uses, and the text-entry predicate every keyboard handler agrees on.
 * Host-agnostic.
 */

/* A button that fires `onClick` when clicked. Every roidraw button is type="button" so it can't
 * submit a surrounding form the host may have wrapped the page in. */
export function button(label, onClick, className) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (className) b.className = className;
    b.onclick = () => onClick();
    return b;
}

/* Is `el` a text-entry target? Global shortcuts (Shift-to-pan, Esc, Delete on a selected anchor)
 * must stay out of the way while the user types, but a file input, button, checkbox, slider, or
 * color picker is NOT text entry — so the gestures keep working even when one of those holds
 * focus (the Import file input does, right after a pick; dat.GUI's number boxes are id-less
 * <input>s). One rule, used by every keydown handler: a blanket `tagName === "INPUT"` check here
 * would silently kill Delete the moment the user clicked a panel button. */
export function isTextEntry(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName || "";
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    return !/^(file|button|checkbox|radio|range|color|submit|reset|image)$/i.test(el.type || "text");
}
