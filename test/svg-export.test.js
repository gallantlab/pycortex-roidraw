import test from "node:test";
import assert from "node:assert";
import { exportSulciSvg, escapeXml, SULCI_PATH_STYLE } from "../core/svg-export.js";

// The caller injects geometry; these fakes make the writer's behavior observable.
const pathFor = (bez) => "M0,0 C1,1 2,2 3,3";      // never ends with Z — the writer must not add one
const ptidxFor = (lv) => (lv ? lv.g : null);

const sulcus = (name, g) => ({ name, bezier: { closed: false, anchors: [[0, 0], [1, 1]] }, labelVert: g == null ? null : { h: "left", g } });

test("escapeXml: escapes the five XML entities", () => {
    assert.strictEqual(escapeXml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});

test("SULCI_PATH_STYLE matches pycortex defaults.cfg [sulci_paths]", () => {
    assert.strictEqual(SULCI_PATH_STYLE, "fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6");
});

test("exportSulciSvg: emits a sulci layer with shapes and labels groups", () => {
    const xml = exportSulciSvg([sulcus("CS", 12)], { pathFor, ptidxFor });
    assert.match(xml, /<g inkscape:groupmode="layer" id="sulci" inkscape:label="sulci"/);
    assert.match(xml, /id="sulci_shapes"/);
    assert.match(xml, /id="sulci_labels"/);
    assert.match(xml, /inkscape:label="CS"/);
});

test("exportSulciSvg: open paths never close with Z", () => {
    const xml = exportSulciSvg([sulcus("CS", 12)], { pathFor, ptidxFor });
    const ds = [...xml.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]);
    assert.strictEqual(ds.length, 1);
    for (const d of ds) assert.ok(!/[Zz]\s*$/.test(d), "sulcus path must not close: " + d);
});

test("exportSulciSvg: same-named sulci merge into one group, one path each", () => {
    const xml = exportSulciSvg([sulcus("CS", 12), sulcus("CS", 34), sulcus("STS", 56)], { pathFor, ptidxFor });
    const groups = [...xml.matchAll(/inkscape:label="(CS|STS)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(groups, ["CS", "STS"]);       // one <g> per distinct name
    const csGroup = xml.split('inkscape:label="CS"')[1].split("</g>")[0];
    assert.strictEqual((csGroup.match(/<path /g) || []).length, 2);
});

test("exportSulciSvg: one label per distinct name, using the first labelVert", () => {
    const xml = exportSulciSvg([sulcus("CS", 12), sulcus("CS", 34)], { pathFor, ptidxFor });
    const texts = [...xml.matchAll(/<text data-ptidx="(\d+)"[^>]*>([^<]*)<\/text>/g)];
    assert.strictEqual(texts.length, 1);
    assert.strictEqual(texts[0][1], "12");
    assert.strictEqual(texts[0][2], "CS");
});

test("exportSulciSvg: a sulcus with no labelVert emits no text", () => {
    const xml = exportSulciSvg([sulcus("CS", null)], { pathFor, ptidxFor });
    assert.ok(!xml.includes("<text"));
    assert.match(xml, /<path /);
});

test("exportSulciSvg: escapes a hostile name in both attribute and text node", () => {
    const xml = exportSulciSvg([sulcus('a&b<c>"d', 12)], { pathFor, ptidxFor });
    assert.ok(!xml.includes('inkscape:label="a&b'), "raw ampersand leaked into the attribute");
    assert.match(xml, /inkscape:label="a&amp;b&lt;c&gt;&quot;d"/);
    assert.match(xml, />a&amp;b&lt;c&gt;&quot;d<\/text>/);
});

test("exportSulciSvg: skips a sulcus whose path cannot be built", () => {
    const xml = exportSulciSvg([sulcus("CS", 12)], { pathFor: () => null, ptidxFor });
    assert.ok(!xml.includes("<path"));
});

test("exportSulciSvg: no sulci yields an empty string", () => {
    assert.strictEqual(exportSulciSvg([], { pathFor, ptidxFor }), "");
});
