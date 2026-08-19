/*
 * build.mjs — bundle the ES modules into one browser script for injection into a pycortex
 * viewer (make_static). CSS is imported as text and injected at runtime by index.js, so the
 * whole feature ships as a single self-contained file: dist/roidraw.bundle.js.
 */
import { build } from "esbuild";

await build({
    entryPoints: ["index.js"],
    bundle: true,
    format: "iife",
    // Global name `roidraw`, lowercase, matching pycortex's own module globals (mriview,
    // svgoverlay, ...) so the file reads native inside a pycortex viewer. index.js also sets
    // window.ROIDraw — the documented public API (README, bake.py, pycortex docs/roidraw.rst).
    globalName: "roidraw",
    outfile: "dist/roidraw.bundle.js",
    loader: { ".css": "text" },
    target: ["es2018"],
    legalComments: "none",
});

console.log("built dist/roidraw.bundle.js");
