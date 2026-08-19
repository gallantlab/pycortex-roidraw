import test from "node:test";
import assert from "node:assert/strict";
import { isTextEntry } from "../ui/dom-utils.js";

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
