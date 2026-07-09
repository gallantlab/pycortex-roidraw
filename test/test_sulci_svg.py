#!/usr/bin/env python3
"""Parse roidraw's exported sulci SVG the way cortex/svgoverlay.py parses an overlays.svg.

Every other test of core/svg-export.js matches strings, which is how a fragment that no XML parser
would accept (the `inkscape:` prefix with no namespace declaration) survived to a release. This test
generates the real output with node and drives Python's XML parser over it, reusing svgoverlay.py's
own namespaces and ElementTree queries. It needs neither pycortex nor a subject.

What it pins, and the pycortex code each line stands in for:

  * The document parses at all.                     etree.parse(svgfile) in SVGOverlay.__init__
  * The `sulci` layer is found by inkscape:label.   _find_layer_names / SVGOverlay.__init__
  * `shapes` and `labels` sublayers exist.          _find_layer(layer, "shapes" | "labels")
      Labels.__init__ raises ValueError without a labels layer, so an empty one is mandatory.
  * The labels layer holds no <text>.               Labels.__init__ does an unguarded
      float(text.get('x')) over every <text>, so a label carrying only data-ptidx (all a vertex
      index can express) raises TypeError. pycortex derives sulcus labels from path geometry.
  * Each named sulcus is a <g inkscape:label=…>     Overlay.__init__ -> Shape(layer_)
      of <path> children, and same-named strokes    Shape.name / Shape.paths; pycortex's own CaS
      (one per hemisphere) share one group.         has one path per hemisphere.
  * No path's `d` closes with Z.                    The only on-disk marker of a sulcus vs an ROI.
"""
import json
import os
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET

# Verbatim from cortex/svgoverlay.py.
SVGNS = "http://www.w3.org/2000/svg"
INKNS = "http://www.inkscape.org/namespaces/inkscape"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Two same-named curves (as if traced one per hemisphere), one differently named, one hostile name.
SULCI = [
    {"name": "CS", "bezier": {"closed": False}},
    {"name": "CS", "bezier": {"closed": False}},
    {"name": "STS", "bezier": {"closed": False}},
    {"name": 'a&b<c>"d', "bezier": {"closed": False}},
]

GENERATE = """
import {{ exportSulciSvg }} from './core/svg-export.js';
const sulci = {sulci};
// Stand in for the adapter's uv -> viewBox-px cubic path. Never closes.
const pathFor = () => 'M10.00,20.00 C11.00,21.00 12.00,22.00 13.00,23.00';
process.stdout.write(exportSulciSvg(sulci, {{ pathFor, width: 1024, height: 768 }}));
"""


def export_sulci_svg(sulci):
    """Run core/svg-export.js under node and return its output. The JS is the source of truth."""
    script = GENERATE.format(sulci=json.dumps(sulci))
    proc = subprocess.run(
        [_node(), "--input-type=module", "-e", script],
        cwd=ROOT, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise AssertionError("node failed to generate the SVG:\n" + proc.stderr)
    return proc.stdout


def _node():
    node = os.environ.get("NODE", "node")
    if subprocess.run([node, "--version"], capture_output=True).returncode != 0:
        raise unittest.SkipTest("node is not on PATH")
    return node


def ink(tag):
    return "{%s}%s" % (INKNS, tag)


def svg(tag):
    return "{%s}%s" % (SVGNS, tag)


def find_layer(parent, label):
    """cortex/svgoverlay.py's _find_layer, verbatim in behavior."""
    layers = [l for l in parent.findall("{%s}g[@{%s}label]" % (SVGNS, INKNS))
              if l.get(ink("label")) == label]
    if not layers:
        raise ValueError("Cannot find layer %s" % label)
    return layers[0]


class TestSulciSvg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.xml = export_sulci_svg(SULCI)
        # This is the assertion that a fragment with an undeclared `inkscape:` prefix fails.
        cls.root = ET.fromstring(cls.xml)

    def test_root_is_an_svg_element(self):
        self.assertEqual(self.root.tag, svg("svg"))

    def test_sulci_layer_is_found_by_its_inkscape_label(self):
        layer = find_layer(self.root, "sulci")
        self.assertEqual(layer.get("id"), "sulci")

    def test_shapes_and_labels_sublayers_both_exist(self):
        layer = find_layer(self.root, "sulci")
        # Labels.__init__ calls _find_layer(layer, "labels") and raises ValueError without it.
        self.assertIsNotNone(find_layer(layer, "shapes"))
        self.assertIsNotNone(find_layer(layer, "labels"))

    def test_labels_layer_is_empty(self):
        """A <text> without x/y makes Labels.__init__ raise TypeError on float(text.get('x'))."""
        labels = find_layer(find_layer(self.root, "sulci"), "labels")
        self.assertEqual(labels.findall(".//" + svg("text")), [])
        self.assertNotIn("data-ptidx", self.xml)

    def test_one_group_per_distinct_name_with_a_path_each(self):
        shapes = find_layer(find_layer(self.root, "sulci"), "shapes")
        groups = shapes.findall(svg("g"))
        by_name = {g.get(ink("label")): g.findall(svg("path")) for g in groups}
        self.assertEqual(len(groups), 3, "same-named curves must share one group")
        self.assertEqual(len(by_name["CS"]), 2, "one path per hemisphere, as pycortex's own CaS has")
        self.assertEqual(len(by_name["STS"]), 1)
        # Round-tripped through the parser, so the escaping was correct, not merely present.
        self.assertEqual(len(by_name['a&b<c>"d']), 1)

    def test_no_path_closes(self):
        """The missing trailing Z is the only thing separating a sulcus from an ROI on disk."""
        for path in self.root.iter(svg("path")):
            d = path.get("d").strip()
            self.assertFalse(d.endswith(("Z", "z")), "sulcus path must stay open: " + d)

    def test_every_path_carries_the_sulcal_style(self):
        for path in self.root.iter(svg("path")):
            style = path.get("style")
            self.assertIn("stroke-linecap:round", style)
            self.assertIn("fill:none", style)

    def test_empty_input_writes_nothing(self):
        self.assertEqual(export_sulci_svg([]), "")


if __name__ == "__main__":
    unittest.main(verbosity=2) if sys.argv[1:] else unittest.main()
