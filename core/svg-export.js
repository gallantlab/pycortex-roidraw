/*
 * svg-export.js — write drawn sulci as a pycortex `overlays.svg` fragment. Pure (no DOM, no host):
 * the caller injects the geometry via `pathFor` / `ptidxFor`.
 *
 * This is pycortex's OWN storage format for sulci, not a roidraw invention. From
 * cortex/svgoverlay.py + a real fixture (filestore/db/S1/overlays.svg), a sulcus is:
 *
 *   <g id="sulci" inkscape:label="sulci">
 *     <g id="sulci_shapes"> <g inkscape:label="CaS"> <path d="m …"/> <path d="m …"/> </g> </g>
 *     <g id="sulci_labels"> … </g>
 *   </g>
 *
 * Two facts drive this module:
 *  1. Sulcus paths are OPEN — no trailing `z`. That is the only on-disk marker separating a
 *     sulcus from an ROI (both are fill:none). `pathFor` must not emit one.
 *  2. One named sulcus commonly holds SEVERAL <path> children — pycortex's own `CaS` has two,
 *     one per hemisphere. So same-named curves merge into a single group rather than colliding.
 *
 * Style is copied verbatim from cortex/defaults.cfg [sulci_paths]. (That section has no
 * stroke-linecap; don't add one.)
 */

export const SULCI_PATH_STYLE = "fill:none;stroke:white;stroke-width:6;stroke-opacity:0.6";

const LABEL_STYLE = "font-family:Helvetica, sans-serif;font-size:14pt;font-style:italic;" +
                    "fill:white;fill-opacity:1;text-anchor:middle";

/* A shape name is user input and lands in both an attribute value and a text node. */
export function escapeXml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/*
 * sulci     : [{ name, bezier, labelVert }]
 * pathFor   : (bezier) -> `d` string or null   (must NOT close the path)
 * ptidxFor  : (labelVert) -> integer or null   (the flat vertex index pycortex labels use)
 * Returns an overlays.svg-compatible fragment, or "" when there is nothing to write.
 */
export function exportSulciSvg(sulci, { pathFor, ptidxFor }) {
    if (!sulci || !sulci.length) return "";

    // group by name, preserving first-seen order — a named sulcus may span both hemispheres
    const groups = new Map();
    for (const s of sulci) {
        if (!groups.has(s.name)) groups.set(s.name, { name: s.name, ds: [], labelVert: null });
        const g = groups.get(s.name);
        const d = pathFor(s.bezier);
        if (d) g.ds.push(d);
        if (!g.labelVert && s.labelVert) g.labelVert = s.labelVert;
    }

    const shapes = [], labels = [];
    for (const g of groups.values()) {
        if (!g.ds.length) continue;
        const name = escapeXml(g.name);
        const paths = g.ds.map((d) => `        <path style="${SULCI_PATH_STYLE}" d="${escapeXml(d)}" />`);
        shapes.push(`      <g inkscape:groupmode="layer" inkscape:label="${name}">\n${paths.join("\n")}\n      </g>`);
        const ptidx = g.labelVert ? ptidxFor(g.labelVert) : null;
        if (ptidx != null) labels.push(`      <text data-ptidx="${ptidx}" style="${LABEL_STYLE}">${name}</text>`);
    }
    if (!shapes.length) return "";

    return [
        '<g inkscape:groupmode="layer" id="sulci" inkscape:label="sulci" style="display:inline">',
        '    <g inkscape:groupmode="layer" id="sulci_shapes" inkscape:label="shapes">',
        shapes.join("\n"),
        "    </g>",
        '    <g inkscape:groupmode="layer" id="sulci_labels" inkscape:label="labels">',
        labels.join("\n"),
        "    </g>",
        "</g>",
        "",
    ].join("\n");
}
