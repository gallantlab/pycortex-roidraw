/*
 * timer-set.test.js — TimerSet, the one bookkeeping for every poll and deferred teardown the
 * controller and the pycortex adapter schedule. The guarantee under test is destroy()'s: after
 * clear(), nothing scheduled through the set (a later() or any retry of a poll()) ever runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TimerSet } from "../core/timer-set.js";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("TimerSet.later: fires once and forgets itself", async () => {
    const t = new TimerSet();
    let n = 0;
    t.later(() => n++, 1);
    assert.equal(t._ids.size, 1);
    await tick(15);
    assert.equal(n, 1);
    assert.equal(t._ids.size, 0);
});

test("TimerSet.clear: cancels everything pending — the destroy() guarantee", async () => {
    const t = new TimerSet();
    let n = 0;
    t.later(() => n++, 1);
    t.later(() => n++, 2);
    t.later(() => n++, 3);
    t.clear();
    await tick(20);
    assert.equal(n, 0);
});

test("TimerSet.poll: an immediate success calls fn once and schedules nothing", async () => {
    const t = new TimerSet();
    let calls = 0, gaveUp = false;
    t.poll(() => { calls++; return true; }, { tries: 5, ms: 1, onGiveUp: () => { gaveUp = true; } });
    assert.equal(calls, 1, "the first attempt is synchronous");
    assert.equal(t._ids.size, 0);
    await tick(20);
    assert.equal(calls, 1);
    assert.equal(gaveUp, false);
});

test("TimerSet.poll: retries until fn succeeds, then stops", async () => {
    const t = new TimerSet();
    let calls = 0, gaveUp = false;
    t.poll(() => ++calls === 3, { tries: 10, ms: 1, onGiveUp: () => { gaveUp = true; } });
    await tick(40);
    assert.equal(calls, 3);
    assert.equal(gaveUp, false);
});

test("TimerSet.poll: gives up after `tries` total attempts and calls onGiveUp once", async () => {
    const t = new TimerSet();
    let calls = 0, gaveUp = 0;
    t.poll(() => { calls++; return false; }, { tries: 4, ms: 1, onGiveUp: () => { gaveUp++; } });
    await tick(40);
    assert.equal(calls, 4, "tries counts the first attempt");
    assert.equal(gaveUp, 1);
    // onGiveUp is optional
    let n = 0;
    t.poll(() => { n++; return 0; }, { tries: 2, ms: 1 });
    await tick(20);
    assert.equal(n, 2);
});

test("TimerSet.poll: clear() stops a poll in flight (no further attempts, no onGiveUp)", async () => {
    const t = new TimerSet();
    let calls = 0, gaveUp = false;
    t.poll(() => { calls++; return false; }, { tries: 100, ms: 2, onGiveUp: () => { gaveUp = true; } });
    await tick(5);
    t.clear();
    const seen = calls;
    await tick(20);
    assert.equal(calls, seen, "a canceled poll must not keep calling fn");
    assert.equal(gaveUp, false);
});
