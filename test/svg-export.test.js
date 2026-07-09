import test from "node:test";
import assert from "node:assert";
import { exportSulciSvg, escapeXml, SULCI_PATH_STYLE, SULCI_STROKE_WIDTH } from "../core/svg-export.js";

// The caller injects geometry; these fakes make the writer's behavior observable.
const pathFor = () => "M0,0 C1,1 2,2 3,3";        // never ends with Z — the writer must not add one
const opts = { pathFor, width: 1024, height: 768 };

const sulcus = (name) => ({ name, bezier: { closed: false, anchors: [[0, 0], [1, 1]] } });

test("escapeXml: escapes the five XML entities", () => {
    assert.strictEqual(escapeXml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});

test("SULCI_PATH_STYLE keeps stroke-linecap:round, the one [sulci_paths] key [rois_paths] lacks", () => {
    assert.match(SULCI_PATH_STYLE, /(^|;)stroke-linecap:round(;|$)/);
    assert.match(SULCI_PATH_STYLE, new RegExp(`(^|;)stroke-width:${SULCI_STROKE_WIDTH}(;|$)`));
    assert.match(SULCI_PATH_STYLE, /(^|;)fill:none(;|$)/);
    // omitted on purpose: a dangling filter ref, and two keys whose config value is the string "None"
    for (const dead of ["filter", "stroke-dasharray", "stroke-dashoffset"])
        assert.ok(!SULCI_PATH_STYLE.includes(dead), `${dead} must not reach the exported style`);
});

test("exportSulciSvg: emits a sulci layer with shapes and labels groups", () => {
    const xml = exportSulciSvg([sulcus("CS")], opts);
    assert.match(xml, /<g inkscape:groupmode="layer" id="sulci" inkscape:label="sulci"/);
    assert.match(xml, /id="sulci_shapes"/);
    assert.match(xml, /id="sulci_labels"/);
    assert.match(xml, /inkscape:label="CS"/);
});

test("exportSulciSvg: open paths never close with Z", () => {
    const xml = exportSulciSvg([sulcus("CS")], opts);
    const ds = [...xml.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]);
    assert.strictEqual(ds.length, 1);
    for (const d of ds) assert.ok(!/[Zz]\s*$/.test(d), "sulcus path must not close: " + d);
});

test("exportSulciSvg: same-named sulci merge into one group, one path each", () => {
    const xml = exportSulciSvg([sulcus("CS"), sulcus("CS"), sulcus("STS")], opts);
    const groups = [...xml.matchAll(/inkscape:label="(CS|STS)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(groups, ["CS", "STS"]);       // one <g> per distinct name
    const csGroup = xml.split('inkscape:label="CS"')[1].split("</g>")[0];
    assert.strictEqual((csGroup.match(/<path /g) || []).length, 2);
});

/*
 * The labels layer must exist and must be EMPTY. Both halves are load-bearing in
 * cortex/svgoverlay.py, and getting either wrong breaks db.get_overlay(subject):
 *   - Labels.__init__ calls _find_layer(layer, "labels"), which raises ValueError when absent;
 *   - it then does an unguarded `float(text.get('x'))` over every <text> it finds, so a <text>
 *     carrying only data-ptidx (which is what the WebGL viewer wants, and all a vertex index can
 *     supply) raises TypeError. pycortex derives sulcus labels from the path geometry itself.
 */
test("exportSulciSvg: the labels layer exists but holds no <text>", () => {
    const xml = exportSulciSvg([sulcus("CS"), sulcus("CS")], opts);
    assert.match(xml, /id="sulci_labels"/, "pycortex's Labels raises ValueError without this layer");
    assert.ok(!xml.includes("<text"), "a <text> without x/y makes Labels.__init__ raise TypeError");
    assert.ok(!xml.includes("data-ptidx"), "data-ptidx is pycortex's output, never its input");
});

test("exportSulciSvg: escapes a hostile name in the group label", () => {
    const xml = exportSulciSvg([sulcus('a&b<c>"d')], opts);
    assert.ok(!xml.includes('inkscape:label="a&b'), "raw ampersand leaked into the attribute");
    assert.match(xml, /inkscape:label="a&amp;b&lt;c&gt;&quot;d"/);
});

test("exportSulciSvg: skips a sulcus whose path cannot be built", () => {
    const xml = exportSulciSvg([sulcus("CS")], { ...opts, pathFor: () => null });
    assert.strictEqual(xml, "", "no path means no document at all");
});

test("exportSulciSvg: no sulci yields an empty string", () => {
    assert.strictEqual(exportSulciSvg([], opts), "");
});

/*
 * The document must be a well-formed, self-describing SVG. Every earlier test in this file passes
 * against a bare fragment that uses the `inkscape:` prefix with no namespace declaration — which
 * ElementTree, lxml, browsers and Inkscape all reject with "unbound prefix". Assert the two things
 * that make the prefix legal, and the root that makes it a document.
 *
 * test/test_sulci_svg.py runs this same output through Python's XML parser, using the very queries
 * cortex/svgoverlay.py uses. That is the check that a string-matching test cannot make.
 */
test("exportSulciSvg: declares the svg + inkscape namespaces on a real <svg> root", () => {
    const xml = exportSulciSvg([sulcus("CS")], opts);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg /);
    assert.match(xml, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(xml, /xmlns:inkscape="http:\/\/www\.inkscape\.org\/namespaces\/inkscape"/);
    assert.match(xml, /<\/svg>\n?$/);
});

test("exportSulciSvg: carries the overlay's pixel size, so the paths' coords have a frame", () => {
    const xml = exportSulciSvg([sulcus("CS")], opts);
    assert.match(xml, /width="1024" height="768" viewBox="0 0 1024 768"/);
});

test("exportSulciSvg: an XML comment can never contain '--'", () => {
    // The merge instructions are emitted as a comment; a stray "--" would make the document
    // ill-formed, which is exactly the class of bug this file exists to prevent.
    const xml = exportSulciSvg([sulcus("CS")], opts);
    const comment = xml.slice(xml.indexOf("<!--") + 4, xml.indexOf("-->"));
    assert.ok(!comment.includes("--"), "XML comments may not contain a double hyphen");
    assert.ok(!comment.endsWith("-"), "XML comments may not end with a hyphen");
});
