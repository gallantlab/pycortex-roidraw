import test from "node:test";
import assert from "node:assert";
import { ShapeSet, FORMAT } from "../core/shape-model.js";

test("ShapeSet: add assigns id + palette color; remove; clear", () => {
    const s = new ShapeSet();
    const a = s.add({ name: "V1", left: [1, 2], right: [] });
    const b = s.add({ name: "V2", left: [], right: [3], color: "#fff" });
    assert.strictEqual(a.id, 1);
    assert.ok(/^#/.test(a.color));        // auto from palette
    assert.strictEqual(b.color, "#fff");  // explicit kept
    assert.strictEqual(s.length, 2);
    s.remove(a.id);
    assert.deepStrictEqual(s.shapes.map((r) => r.name), ["V2"]);
    s.clear();
    assert.strictEqual(s.length, 0);
});

test("toJSON/loadJSON round-trips vertices + outline + labelVert", () => {
    const s = new ShapeSet();
    s.add({
        name: "FFA", left: [10, 11, 12], right: [],
        outline: [{ h: "left", g: 10 }, { h: "left", g: 11 }, { h: "left", g: 12 }],
        labelVert: { h: "left", g: 11 },
    });
    const doc = s.toJSON("fsaverage");
    assert.strictEqual(doc.format, FORMAT);
    assert.strictEqual(doc.surface, "fsaverage");
    assert.deepStrictEqual(doc.rois[0].counts, { left: 3, right: 0 });

    const s2 = new ShapeSet();
    const added = s2.loadJSON(JSON.parse(JSON.stringify(doc)));
    assert.strictEqual(added.length, 1);
    assert.deepStrictEqual(s2.shapes[0].left, [10, 11, 12]);
    assert.deepStrictEqual(s2.shapes[0].outline, [{ h: "left", g: 10 }, { h: "left", g: 11 }, { h: "left", g: 12 }]);
    assert.deepStrictEqual(s2.shapes[0].labelVert, { h: "left", g: 11 });
});

test("loadJSON: leaves labelVert null when missing (the viewer back-fills it from geometry)", () => {
    // loadJSON is purely structural — it never invents a label vertex (no coordinates here).
    // The controller fills a missing label via draw-pipeline.backfillLabel using the adapter's uv.
    const s = new ShapeSet();
    const [roi] = s.loadJSON({
        format: FORMAT,
        rois: [{ name: "x", vertices: { left: [1, 2, 3], right: [] },
                 outline: [{ h: "left", g: 1 }, { h: "left", g: 2 }, { h: "left", g: 3 }] }],
    });
    assert.strictEqual(roi.labelVert, null);
});

test("loadJSON: defensively copies arrays (no aliasing of the caller's parsed JSON)", () => {
    const s = new ShapeSet();
    const src = { left: [1, 2], right: [], outline: [{ h: "left", g: 1 }] };
    const [roi] = s.loadJSON({ format: FORMAT, rois: [{ name: "x", vertices: { left: src.left, right: src.right }, outline: src.outline }] });
    roi.left.push(999);
    assert.deepStrictEqual(src.left, [1, 2], "mutating the model must not touch the source array");
});

test("toJSON/loadJSON round-trips the editable bezier", () => {
    const bezier = {
        closed: true,
        anchors: [[0.4, 0.5], [0.5, 0.42], [0.6, 0.5]],
        inHandles: [[0.38, 0.5], [0.48, 0.42], [0.58, 0.5]],
        outHandles: [[0.42, 0.5], [0.52, 0.42], [0.62, 0.5]],
    };
    const s = new ShapeSet();
    s.add({ name: "FFA", left: [10], right: [], bezier });
    const doc = s.toJSON("fsaverage");
    assert.strictEqual(doc.format, "pycortex-roidraw/vertexset-v2");
    assert.deepStrictEqual(doc.rois[0].bezier, bezier);

    const s2 = new ShapeSet();
    s2.loadJSON(JSON.parse(JSON.stringify(doc)));
    assert.deepStrictEqual(s2.shapes[0].bezier, bezier);
});

test("loadJSON: a v1 file (no bezier) still loads, with bezier=null", () => {
    const s = new ShapeSet();
    const [roi] = s.loadJSON({
        format: "pycortex-roidraw/vertexset-v1",
        rois: [{ name: "V1", vertices: { left: [1, 2, 3], right: [] },
                 outline: [{ h: "left", g: 1 }, { h: "left", g: 2 }, { h: "left", g: 3 }] }],
    });
    assert.strictEqual(roi.bezier, null);
    assert.deepStrictEqual(roi.left, [1, 2, 3]);
});

test("loadJSON: rejects an unknown format", () => {
    assert.throws(() => new ShapeSet().loadJSON({ format: "something-else" }), /unrecognized format/);
});

test("add: defaults to kind 'roi'", () => {
    const s = new ShapeSet();
    const r = s.add({ name: "V1", left: [1], right: [] });
    assert.strictEqual(r.kind, "roi");
});

test("add: accepts a sulcus with no vertex fields", () => {
    const s = new ShapeSet();
    const cs = s.add({ kind: "sulcus", name: "CS", bezier: { closed: false, anchors: [[0, 0], [1, 1]] } });
    assert.strictEqual(cs.kind, "sulcus");
    assert.strictEqual(cs.left, undefined);
    assert.strictEqual(cs.right, undefined);
    assert.strictEqual(cs.outline, undefined);
});

test("byKind: partitions the collection", () => {
    const s = new ShapeSet();
    s.add({ name: "V1", left: [1], right: [] });
    s.add({ kind: "sulcus", name: "CS", bezier: {} });
    s.add({ kind: "sulcus", name: "CS", bezier: {} });   // duplicate names are legal
    assert.strictEqual(s.byKind("roi").length, 1);
    assert.strictEqual(s.byKind("sulcus").length, 2);
    assert.strictEqual(s.length, 3);
});

test("ids stay unique across kinds", () => {
    const s = new ShapeSet();
    const a = s.add({ name: "V1", left: [], right: [] });
    const b = s.add({ kind: "sulcus", name: "CS", bezier: {} });
    assert.notStrictEqual(a.id, b.id);
});

test("toJSON: serializes ROIs only, never sulci", () => {
    const s = new ShapeSet();
    s.add({ name: "V1", left: [1, 2], right: [] });
    s.add({ kind: "sulcus", name: "CS", bezier: { closed: false, anchors: [[0, 0], [1, 1]] } });
    const doc = s.toJSON("subj");
    assert.strictEqual(doc.format, FORMAT);
    assert.strictEqual(doc.rois.length, 1);
    assert.strictEqual(doc.rois[0].name, "V1");
});

test("loadJSON: tags imported entries as ROIs", () => {
    const s = new ShapeSet();
    const added = s.loadJSON({ format: FORMAT, rois: [{ name: "V1", vertices: { left: [1], right: [] } }] });
    assert.strictEqual(added.length, 1);
    assert.strictEqual(added[0].kind, "roi");
});

/*
 * loadJSON must DEEP copy: an imported shape's bezier is mutated in place by the edit overlay, and
 * `outline` entries by nothing today but the model owns them either way. Aliasing the caller's
 * parsed JSON would let an edit reach back into the document the user imported.
 */
test("loadJSON: the model never aliases the parsed document", () => {
    const doc = {
        format: FORMAT,
        rois: [{
            name: "V1",
            vertices: { left: [1, 2], right: [3] },
            outline: [{ h: "left", g: 1 }, { h: "left", g: 2 }, { h: "left", g: 3 }],
            labelVert: { h: "left", g: 2 },
            bezier: {
                closed: true,
                anchors: [[0, 0], [1, 0], [1, 1]],
                inHandles: [[0, 0], [1, 0], [1, 1]],
                outHandles: [[0, 0], [1, 0], [1, 1]],
                smooth: [true, true, false],
            },
        }],
    };
    const src = doc.rois[0];
    const [roi] = new ShapeSet().loadJSON(doc);

    assert.notStrictEqual(roi.bezier, src.bezier);
    assert.notStrictEqual(roi.bezier.anchors, src.bezier.anchors);
    assert.notStrictEqual(roi.bezier.anchors[0], src.bezier.anchors[0]);
    assert.notStrictEqual(roi.bezier.smooth, src.bezier.smooth);
    assert.notStrictEqual(roi.outline, src.outline);
    assert.notStrictEqual(roi.outline[0], src.outline[0]);
    assert.notStrictEqual(roi.labelVert, src.labelVert);
    assert.notStrictEqual(roi.left, src.vertices.left);

    // ...and the copy is faithful, not merely detached.
    assert.deepStrictEqual(roi.bezier, src.bezier);
    assert.deepStrictEqual(roi.outline, src.outline);
    assert.deepStrictEqual(roi.labelVert, src.labelVert);

    // Mutating the model leaves the document untouched.
    roi.bezier.anchors[0][0] = 99;
    roi.outline[0].g = 99;
    assert.strictEqual(doc.rois[0].bezier.anchors[0][0], 0);
    assert.strictEqual(doc.rois[0].outline[0].g, 1);
});

test("loadJSON: a v1 bezier (no `closed`, no `smooth`) keeps its absent keys for cloneBezier", () => {
    const doc = { format: FORMAT, rois: [{ name: "V1", vertices: { left: [], right: [] },
        bezier: { anchors: [[0, 0]], inHandles: [[0, 0]], outHandles: [[0, 0]] } }] };
    const [roi] = new ShapeSet().loadJSON(doc);
    assert.strictEqual("closed" in roi.bezier, false, "absent means closed; don't invent the key");
    assert.strictEqual("smooth" in roi.bezier, false, "cloneBezier back-fills this as all-smooth");
});

test("loadJSON: a garbage bezier field becomes null rather than a half-copied object", () => {
    for (const bad of [42, "nope", {}, { anchors: "no" }, []]) {
        const doc = { format: FORMAT, rois: [{ name: "V1", vertices: { left: [], right: [] }, bezier: bad }] };
        const [roi] = new ShapeSet().loadJSON(doc);
        assert.strictEqual(roi.bezier, null, "unusable bezier: " + JSON.stringify(bad));
    }
});

test("add: an ROI always has membership arrays, even when the caller omits them", () => {
    const roi = new ShapeSet().add({ kind: "roi", name: "V1" });
    assert.deepStrictEqual(roi.left, []);          // callers read roi.left.length unguarded
    assert.deepStrictEqual(roi.right, []);
    const sulcus = new ShapeSet().add({ kind: "sulcus", name: "CS" });
    assert.strictEqual("left" in sulcus, false, "a sulcus has no membership, not empty membership");
});

test("defaultName: numbers per kind, and the import fallback uses the same rule", () => {
    const s = new ShapeSet();
    assert.equal(s.defaultName("roi"), "roi1");
    s.add({ kind: "sulcus", name: "CS", bezier: {} });
    s.add({ kind: "sulcus", name: "CS", bezier: {} });
    assert.equal(s.defaultName("roi"), "roi1");          // sulci don't advance the ROI numbering
    assert.equal(s.defaultName("sulcus"), "sulcus3");
    const [r] = s.loadJSON({ format: FORMAT, rois: [{ vertices: { left: [1], right: [] } }] });
    assert.equal(r.name, "roi1");
    assert.equal(s.defaultName("roi"), "roi2");
});
