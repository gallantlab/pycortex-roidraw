/*
 * svg-export.js — write drawn sulci as a standalone SVG whose `sulci` layer is exactly what
 * pycortex's `cortex/svgoverlay.py` expects. Pure (no DOM, no host): the caller injects the
 * geometry via `pathFor` and the overlay's pixel size.
 *
 * This is pycortex's OWN storage format for sulci, not a roidraw invention. From
 * cortex/svgoverlay.py + a real fixture (filestore/db/S1/overlays.svg), a sulcus is:
 *
 *   <g id="sulci" inkscape:label="sulci">
 *     <g id="sulci_shapes" inkscape:label="shapes">
 *       <g inkscape:label="CaS"> <path d="m …"/> <path d="m …"/> </g>
 *     </g>
 *     <g id="sulci_labels" inkscape:label="labels"/>
 *   </g>
 *
 * Four facts from that parser drive this module:
 *
 *  1. Sulcus paths are OPEN — no trailing `z`. That is the only on-disk marker separating a
 *     sulcus from an ROI (both are fill:none). `pathFor` must not emit one.
 *
 *  2. One named sulcus commonly holds SEVERAL <path> children — pycortex's own `CaS` has two,
 *     one per hemisphere. So same-named curves merge into a single group rather than colliding.
 *
 *  3. WE WRITE NO LABELS, and the `labels` layer must exist but stay EMPTY.
 *     pycortex derives a sulcus's label position from its path geometry at load time
 *     (`Shape.get_labelpos`, one label per path — so a two-hemisphere sulcus gets two labels for
 *     free) and *writes* `data-ptidx` itself from each label's x/y via a kd-tree
 *     (`SVGOverlay.set_coords`). `data-ptidx` is pycortex's OUTPUT, never its input. A real
 *     `overlays.svg` contains zero <text> elements. Worse, `Labels.__init__` does an unguarded
 *     `float(text.get('x'))` over every <text> in the layer, so emitting a <text> without x/y —
 *     which a vertex-index label has no way to supply — makes `db.get_overlay(subject)` raise
 *     TypeError before it renders a thing. The layer itself is still mandatory: `Labels.__init__`
 *     calls `_find_layer(layer, "labels")`, which raises ValueError when it is absent.
 *     roidraw's own live overlay does use `data-ptidx` (that is the WebGL viewer's convention,
 *     see adapter/pycortex-adapter.js) — but that convention stops at the browser.
 *
 *  4. The document must be well-formed XML. The `inkscape:` prefix is meaningless without its
 *     namespace declaration, so the fragment is wrapped in a real <svg> root; ElementTree, lxml,
 *     browsers, and Inkscape all reject it otherwise. Merge by copying the `<g>` children of
 *     `sulci_shapes` into the subject's EXISTING `sulci_shapes` group — appending a second
 *     `inkscape:label="sulci"` layer silently replaces the first in `SVGOverlay.layers`.
 *
 * Style: cortex/defaults.cfg [sulci_paths] has ten keys. We emit the five that carry visual
 * meaning for a standalone open stroke:
 *   - stroke:white, stroke-width:6, stroke-opacity:0.6, fill:none — the base look.
 *   - stroke-linecap:round — a sulcus is an OPEN stroke, so its end caps are visible geometry,
 *     and this is the one [sulci_paths] key that [rois_paths] lacks.
 * We deliberately omit the other five:
 *   - display:inline, filter:url(#dropshadow) — a dangling filter reference if this fragment is
 *     pasted into a document that lacks the #dropshadow def.
 *   - stroke-dashoffset / stroke-dasharray — their config value is the literal string "None".
 *   - fill-opacity:0 — redundant with fill:none.
 * Note this on-disk style governs raw/Inkscape rendering only. pycortex overwrites every path's
 * `style` attribute at load: `Shape.__init__` seeds it from [overlay_paths] (NOT [sulci_paths] —
 * that section is read in exactly one place, quickflat/composite.py, and applied at render time)
 * and `Shape.set()` writes it back over every path.
 */

export const SULCI_STROKE_WIDTH = 6;      // px, in overlay viewBox units; cortex defaults.cfg [sulci_paths]
export const SULCI_STROKE_OPACITY = 0.6;  // ...and its stroke-opacity

export const SULCI_PATH_STYLE =
    `fill:none;stroke:white;stroke-width:${SULCI_STROKE_WIDTH};` +
    `stroke-opacity:${SULCI_STROKE_OPACITY};stroke-linecap:round`;

const SVGNS = "http://www.w3.org/2000/svg";
const INKNS = "http://www.inkscape.org/namespaces/inkscape";

// Told to whoever opens the downloaded file. Appending our <g id="sulci"> wholesale into a subject's
// overlays.svg would shadow that subject's own sulci layer (see the module header, fact 4).
const MERGE_HELP =
    " Drawn with pycortex-roidraw. To install these sulci into a subject's overlays.svg, copy the\n" +
    "     <g inkscape:label=\"…\"> children of #sulci_shapes below into that file's EXISTING\n" +
    "     #sulci_shapes group. Do NOT paste the whole <g id=\"sulci\"> layer: a second layer with\n" +
    "     inkscape:label=\"sulci\" silently replaces the subject's own in SVGOverlay.layers.\n" +
    "     Leave #sulci_labels empty — pycortex derives sulcus labels from the path geometry. ";

/* A shape name is user input and lands in both an attribute value and a text node. */
export function escapeXml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/* An XML comment can contain neither "--" nor a trailing "-". */
function xmlComment(text) { return "<!--" + text.replace(/-{2,}/g, "-").replace(/-$/, "- ") + "-->"; }

/*
 * sulci   : [{ name, bezier }]           (labelVert is deliberately ignored — see header, fact 3)
 * pathFor : (bezier) -> `d` string or null   (must NOT close the path)
 * width   : overlay viewBox width in px  (the space `pathFor`'s coords live in)
 * height  : overlay viewBox height in px
 *
 * Returns a standalone, well-formed SVG document whose `sulci` layer drops straight into a
 * subject's overlays.svg, or "" when no sulcus yields a path.
 */
export function exportSulciSvg(sulci, { pathFor, width, height }) {
    if (!sulci || !sulci.length) return "";

    // group by name, preserving first-seen order — a named sulcus may span both hemispheres
    const groups = new Map();
    for (const s of sulci) {
        if (!groups.has(s.name)) groups.set(s.name, []);
        const d = pathFor(s.bezier);
        if (d) groups.get(s.name).push(d);
    }

    const shapes = [];
    for (const [name, ds] of groups) {
        if (!ds.length) continue;
        const label = escapeXml(name);
        const paths = ds.map((d) => `        <path style="${SULCI_PATH_STYLE}" d="${escapeXml(d)}" />`);
        shapes.push(`      <g inkscape:groupmode="layer" inkscape:label="${label}">\n${paths.join("\n")}\n      </g>`);
    }
    if (!shapes.length) return "";

    const size = (width > 0 && height > 0) ? ` width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"` : "";
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<svg xmlns="${SVGNS}" xmlns:inkscape="${INKNS}" version="1.1"${size}>`,
        "  " + xmlComment(MERGE_HELP),
        '  <g inkscape:groupmode="layer" id="sulci" inkscape:label="sulci" style="display:inline">',
        '    <g inkscape:groupmode="layer" id="sulci_shapes" inkscape:label="shapes">',
        shapes.join("\n"),
        "    </g>",
        // Mandatory but EMPTY: _find_layer(layer, "labels") raises without it, and pycortex fills
        // it from the path geometry. Any <text> we wrote here would crash Labels.__init__.
        '    <g inkscape:groupmode="layer" id="sulci_labels" inkscape:label="labels" />',
        "  </g>",
        "</svg>",
        "",
    ].join("\n");
}
