/*
 * timer-set.js — a set of pending setTimeout handles that one destroy() can cancel together.
 *
 * Both the controller and the pycortex adapter run polls and deferred teardowns (frame-on-load,
 * overlay-sync retries, the download teardown, the control-panel re-collapse schedule). autoAttach
 * destroys a prior drawer before attaching a new one, so an untracked timer would keep calling a
 * dead adapter.
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

    /* Call `fn()` now; if it returns falsy, retry every `ms` ms until it returns truthy or `tries`
     * attempts (counting the first) have all failed, then call `onGiveUp()` if given. Every retry is
     * a tracked timer, so clear() stops a poll in flight (and onGiveUp is then never called). */
    poll(fn, { tries = 1, ms = 0, onGiveUp } = {}) {
        const attempt = (left) => {
            if (fn()) return;
            if (left > 1) this.later(() => attempt(left - 1), ms);
            else if (onGiveUp) onGiveUp();
        };
        attempt(tries);
    }

    /* Cancel everything still pending. */
    clear() {
        for (const id of this._ids) clearTimeout(id);
        this._ids.clear();
    }
}
