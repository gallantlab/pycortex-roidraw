import test from "node:test";
import assert from "node:assert/strict";
import { button, isTextEntry } from "../ui/dom-utils.js";

// Plain objects stand in for elements: the predicate reads only tagName/type/isContentEditable.
test("isTextEntry: text-like inputs, textareas and contenteditable are text entry", () => {
    assert.equal(isTextEntry({ tagName: "INPUT" }), true);                 // type defaults to text
    assert.equal(isTextEntry({ tagName: "INPUT", type: "text" }), true);
    assert.equal(isTextEntry({ tagName: "INPUT", type: "search" }), true);
    assert.equal(isTextEntry({ tagName: "INPUT", type: "number" }), true); // dat.GUI's id-less boxes
    assert.equal(isTextEntry({ tagName: "TEXTAREA" }), true);
    assert.equal(isTextEntry({ tagName: "DIV", isContentEditable: true }), true);
});

test("isTextEntry: the Import file input, buttons, checkboxes, sliders, pickers are NOT", () => {
    for (const type of ["file", "button", "checkbox", "radio", "range", "color", "submit", "reset", "image"])
        assert.equal(isTextEntry({ tagName: "INPUT", type }), false, type);
    assert.equal(isTextEntry({ tagName: "BUTTON" }), false);
    assert.equal(isTextEntry({ tagName: "CANVAS" }), false);
    assert.equal(isTextEntry(null), false);
    assert.equal(isTextEntry(undefined), false);
});

test("button: a type=button with the label and class, whose click fires the callback", () => {
    const saved = globalThis.document;
    globalThis.document = { createElement: (tag) => ({ tagName: tag.toUpperCase() }) };
    try {
        let clicks = 0;
        const b = button("Go", () => clicks++, "roidraw-action");
        assert.equal(b.tagName, "BUTTON");
        assert.equal(b.type, "button", "never a submit button");
        assert.equal(b.textContent, "Go");
        assert.equal(b.className, "roidraw-action");
        b.onclick({});
        assert.equal(clicks, 1);
        assert.equal(button("Bare", () => {}).className, undefined, "no class unless one is given");
    } finally {
        globalThis.document = saved;
    }
});
