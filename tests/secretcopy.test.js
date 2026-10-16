import test from "node:test";
import assert from "node:assert/strict";
import { createSecretCopy } from "../js/secretcopy.js";

const SECRET = "0123456789abcdef".repeat(4);
// As on screen: 4 lines of 4 numbered groups.
const SHOWN = [0, 4, 8, 12]
  .map((r) => Array.from({ length: 4 }, (_, k) => String(r + k + 1).padStart(2, "0") + " " + SECRET.slice((r + k) * 4, (r + k) * 4 + 4)).join(" "))
  .join("\n");
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function rig({ focus = true, secure = true, refuse = false } = {}) {
  const r = { clip: "sentinel", writes: [], clock: 1_000_000, focus, ticks: [], ends: [], fns: new Map(), next: 1 };
  r.clipboard = {
    async writeText(s) {
      if (refuse) throw new Error("NotAllowedError");
      r.writes.push(s);
      r.clip = s;
    },
  };
  r.copy = createSecretCopy({
    clipboard: r.clipboard,
    secure,
    hasFocus: () => r.focus,
    now: () => r.clock,
    every: (fn) => { const id = r.next++; r.fns.set(id, fn); return id; },
    stopEvery: (id) => r.fns.delete(id),
    onTick: (n) => r.ticks.push(n),
    onEnd: (x) => r.ends.push(x),
  });
  // Advance the clock one second at a time, running the interval callbacks.
  r.advance = async (sec) => {
    for (let k = 0; k < sec; k++) {
      r.clock += 1000;
      for (const fn of [...r.fns.values()]) fn();
      await new Promise((res) => setImmediate(res));
    }
  };
  return r;
}

test("copies the 64 hex digits laid out as on screen (4 numbered lines), then empties the clipboard after 30 s", async () => {
  const r = rig();
  const bytes = ascii(SECRET);
  assert.equal(await r.copy.copy(bytes), true);
  assert.equal(r.clip, SHOWN);
  assert.equal(r.copy.pending, true);
  assert.deepEqual(r.ticks, [30]);
  await r.advance(29);
  assert.equal(r.clip, SHOWN, "still there at 29 s");
  assert.deepEqual(r.ends, []);
  await r.advance(1);
  assert.equal(r.clip, "", "emptied at 30 s");
  assert.deepEqual(r.ends, ["cleared"]);
  assert.equal(r.copy.pending, false);
  assert.equal(r.fns.size, 0, "no timer left");
  assert.ok(r.ticks.includes(1) && r.ticks[r.ticks.length - 1] === 1, "visible countdown down to 1");
});

test("the countdown follows the clock, not the number of ticks (a frozen tab)", async () => {
  const r = rig();
  await r.copy.copy(ascii(SECRET));
  r.clock += 45_000; // the tab slept: one late tick is enough
  for (const fn of [...r.fns.values()]) fn();
  await new Promise((res) => setImmediate(res));
  assert.equal(r.clip, "");
  assert.deepEqual(r.ends, ["cleared"]);
});

test("best effort: without the focus the clipboard is not emptied, and that is reported", async () => {
  const r = rig();
  await r.copy.copy(ascii(SECRET));
  r.focus = false;
  await r.advance(30);
  assert.equal(r.clip, SHOWN);
  assert.deepEqual(r.ends, ["not_cleared"]);
  assert.equal(r.fns.size, 0);
});

test("stop() (leaving the step, Home, the page) empties it at once and cancels the timer", async () => {
  const r = rig();
  await r.copy.copy(ascii(SECRET));
  await r.advance(5);
  assert.equal(await r.copy.stop(), "cleared");
  assert.equal(r.clip, "");
  assert.equal(r.fns.size, 0);
  assert.equal(await r.copy.stop(), null, "nothing pending: no second write");
  assert.deepEqual(r.writes, [SHOWN, ""]);
});

test("a second copy restarts the 30 s, with one timer", async () => {
  const r = rig();
  await r.copy.copy(ascii(SECRET));
  await r.advance(20);
  await r.copy.copy(ascii(SECRET));
  assert.equal(r.fns.size, 1);
  await r.advance(20);
  assert.equal(r.clip, SHOWN);
  await r.advance(10);
  assert.equal(r.clip, "");
});

test("no secure context or no clipboard API: nothing is written (no fallback through the page)", async () => {
  const r = rig({ secure: false });
  assert.equal(r.copy.available(), false);
  assert.equal(await r.copy.copy(ascii(SECRET)), false);
  assert.deepEqual(r.writes, []);
  const none = createSecretCopy({ clipboard: undefined, secure: true });
  assert.equal(none.available(), false);
});

test("refused by the browser: throws, no timer armed", async () => {
  const r = rig({ refuse: true });
  await assert.rejects(r.copy.copy(ascii(SECRET)));
  assert.equal(r.copy.pending, false);
  assert.equal(r.fns.size, 0);
});

test("anything but 64 lowercase hex ASCII bytes is refused", async () => {
  const r = rig();
  for (const bad of [ascii(SECRET.slice(0, 63)), ascii(SECRET.toUpperCase()), ascii(SECRET.slice(0, 63) + "g"), SECRET]) {
    await assert.rejects(r.copy.copy(bad));
  }
  assert.deepEqual(r.writes, []);
});
