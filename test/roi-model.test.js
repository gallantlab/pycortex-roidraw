import test from "node:test";
import assert from "node:assert";
import { ROISet, FORMAT } from "../core/roi-model.js";

test("ROISet: add assigns id + palette color; remove; clear", () => {
    const s = new ROISet();
    const a = s.add({ name: "V1", left: [1, 2], right: [] });
    const b = s.add({ name: "V2", left: [], right: [3], color: "#fff" });
    assert.strictEqual(a.id, 1);
    assert.ok(/^#/.test(a.color));        // auto from palette
    assert.strictEqual(b.color, "#fff");  // explicit kept
    assert.strictEqual(s.length, 2);
    s.remove(a.id);
    assert.deepStrictEqual(s.rois.map((r) => r.name), ["V2"]);
    s.clear();
    assert.strictEqual(s.length, 0);
});

test("toJSON/loadJSON round-trips vertices + outline + labelVert", () => {
    const s = new ROISet();
    s.add({
        name: "FFA", left: [10, 11, 12], right: [],
        outline: [{ h: "left", g: 10 }, { h: "left", g: 11 }, { h: "left", g: 12 }],
        labelVert: { h: "left", g: 11 },
    });
    const doc = s.toJSON("fsaverage");
    assert.strictEqual(doc.format, FORMAT);
    assert.strictEqual(doc.surface, "fsaverage");
    assert.deepStrictEqual(doc.rois[0].counts, { left: 3, right: 0 });

    const s2 = new ROISet();
    const added = s2.loadJSON(JSON.parse(JSON.stringify(doc)));
    assert.strictEqual(added.length, 1);
    assert.deepStrictEqual(s2.rois[0].left, [10, 11, 12]);
    assert.deepStrictEqual(s2.rois[0].outline, [{ h: "left", g: 10 }, { h: "left", g: 11 }, { h: "left", g: 12 }]);
    assert.deepStrictEqual(s2.rois[0].labelVert, { h: "left", g: 11 });
});

test("loadJSON: back-fills labelVert from the outline when missing", () => {
    const s = new ROISet();
    const [roi] = s.loadJSON({
        format: FORMAT,
        rois: [{ name: "x", vertices: { left: [1, 2, 3], right: [] },
                 outline: [{ h: "left", g: 1 }, { h: "left", g: 2 }, { h: "left", g: 3 }] }],
    });
    assert.deepStrictEqual(roi.labelVert, { h: "left", g: 2 });
});

test("toJSON/loadJSON round-trips the editable bezier", () => {
    const bezier = {
        closed: true,
        anchors: [[0.4, 0.5], [0.5, 0.42], [0.6, 0.5]],
        inHandles: [[0.38, 0.5], [0.48, 0.42], [0.58, 0.5]],
        outHandles: [[0.42, 0.5], [0.52, 0.42], [0.62, 0.5]],
    };
    const s = new ROISet();
    s.add({ name: "FFA", left: [10], right: [], bezier });
    const doc = s.toJSON("fsaverage");
    assert.strictEqual(doc.format, "pycortex-roidraw/vertexset-v2");
    assert.deepStrictEqual(doc.rois[0].bezier, bezier);

    const s2 = new ROISet();
    s2.loadJSON(JSON.parse(JSON.stringify(doc)));
    assert.deepStrictEqual(s2.rois[0].bezier, bezier);
});

test("loadJSON: a v1 file (no bezier) still loads, with bezier=null", () => {
    const s = new ROISet();
    const [roi] = s.loadJSON({
        format: "pycortex-roidraw/vertexset-v1",
        rois: [{ name: "V1", vertices: { left: [1, 2, 3], right: [] },
                 outline: [{ h: "left", g: 1 }, { h: "left", g: 2 }, { h: "left", g: 3 }] }],
    });
    assert.strictEqual(roi.bezier, null);
    assert.deepStrictEqual(roi.left, [1, 2, 3]);
});

test("loadJSON: rejects an unknown format", () => {
    assert.throws(() => new ROISet().loadJSON({ format: "something-else" }), /unrecognized format/);
});
