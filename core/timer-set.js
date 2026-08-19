/*
 * timer-set.js — a set of pending setTimeout handles that one destroy() can cancel together.
 *
 * Both the controller and the pycortex adapter run polls and deferred teardowns (frame-on-load,
 * overlay-sync retries, the download teardown, the control-panel re-collapse schedule). autoAttach
 * destroys a prior drawer before attaching a new one, so an untracked timer would keep calling a
 * dead adapter. Each used to carry its own copy of this bookkeeping; this is the one copy.
 *
 * Pure logic over the host's setTimeout/clearTimeout (present in browsers and node alike).
 */
export class TimerSet {
    constructor() { this._ids = new Set(); }

    /* setTimeout, remembered. The handle forgets itself once it fires. Returns the timer id. */
    later(fn, ms) {
        const id = setTimeout(() => { this._ids.delete(id); fn(); }, ms);
        this._ids.add(id);
        return id;
    }

    /* Cancel one pending timer (a no-op for an id that already fired or was never ours). */
    cancel(id) { if (this._ids.delete(id)) clearTimeout(id); }

    /* Cancel everything still pending. */
    clear() {
        for (const id of this._ids) clearTimeout(id);
        this._ids.clear();
    }

    get size() { return this._ids.size; }
}
