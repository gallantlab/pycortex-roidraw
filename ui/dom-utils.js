/*
 * dom-utils.js — small DOM predicates shared by the UI and the controller, so every keyboard
 * handler in roidraw agrees on the same rule. Host-agnostic.
 */

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
