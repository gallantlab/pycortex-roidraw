import test from "node:test";
import assert from "node:assert/strict";
import { TimerSet } from "../core/timer-set.js";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("TimerSet.later: fires once and forgets itself", async () => {
    const t = new TimerSet();
    let n = 0;
    t.later(() => n++, 1);
    assert.equal(t.size, 1);
    await tick(15);
    assert.equal(n, 1);
    assert.equal(t.size, 0);
});

test("TimerSet.clear: cancels everything pending — the destroy() guarantee", async () => {
    const t = new TimerSet();
    let n = 0;
    t.later(() => n++, 1);
    t.later(() => n++, 2);
    t.later(() => n++, 3);
    t.clear();
    assert.equal(t.size, 0);
    await tick(20);
    assert.equal(n, 0);
});

test("TimerSet.cancel: cancels one, leaves the rest; a foreign/fired id is a no-op", async () => {
    const t = new TimerSet();
    const hits = [];
    const a = t.later(() => hits.push("a"), 1);
    t.later(() => hits.push("b"), 2);
    t.cancel(a);
    t.cancel(987654);            // never ours
    await tick(20);
    assert.deepEqual(hits, ["b"]);
    t.cancel(a);                 // already cancelled: still a no-op
});
