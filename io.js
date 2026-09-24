/*
 * io.js — the browser file I/O behind the drawer's Export and Import: download a text document,
 * and read a picked file as text. The document formats themselves live in core/ (shape-model.js,
 * svg-export.js); the export/import flows and their panel messages stay in index.js.
 */

// Firefox writes a 0-byte file if the anchor is removed / the object URL revoked before the
// download starts, so both are deferred well past the click.
const DOWNLOAD_TEARDOWN_MS = 4000;

/* Byte length of a string once encoded, which is what a downloaded file actually weighs.
 * `str.length` counts UTF-16 code units and undercounts every non-ASCII character in a shape name. */
export const byteLength = (s) => new TextEncoder().encode(s).length;

/* Save `text` as a download named `filename`. The deferred teardown runs on `timers` (a TimerSet),
 * so the owner's destroy() cancels it. */
export function downloadText(text, filename, mime, timers) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    timers.later(() => { a.remove(); URL.revokeObjectURL(url); }, DOWNLOAD_TEARDOWN_MS);
}

/* Read `file` as text: onText(text) on success, onError() if it can't be read. Returns the
 * FileReader, so the caller can abort() a read still in flight. */
export function readTextFile(file, { onText, onError }) {
    const reader = new FileReader();
    reader.onload = () => onText(reader.result);
    reader.onerror = () => onError();
    reader.readAsText(file);
    return reader;
}
