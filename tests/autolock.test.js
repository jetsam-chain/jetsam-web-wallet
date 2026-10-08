// Inactivity lock: any activity pushes the deadline; a proof in progress
// holds it; the lock fires once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutoLock, LOCK_CHOICES } from "../js/autolock.js";

test("locks after the chosen idle time, once", () => {
  let now = 0;
  let locked = 0;
  const a = createAutoLock({ minutes: 5, now: () => now, onLock: () => locked++ });
  now = 4 * 60_000;
  a.tick();
  assert.equal(locked, 0);
  a.touch();
  now = 8 * 60_000;
  a.tick();
  assert.equal(locked, 0, "activity at 4 min pushed the deadline to 9 min");
  now = 9 * 60_000;
  a.tick();
  a.tick();
  assert.equal(locked, 1);
});

test("a hold (proof running) postpones the lock until released", () => {
  let now = 0;
  let locked = 0;
  const a = createAutoLock({ minutes: 1, now: () => now, onLock: () => locked++ });
  a.hold(true);
  now = 10 * 60_000;
  a.tick();
  assert.equal(locked, 0);
  a.hold(false); // releasing counts as activity
  now += 59_000;
  a.tick();
  assert.equal(locked, 0);
  now += 1_000;
  a.tick();
  assert.equal(locked, 1);
});

test("choices are bounded; unknown values fall back to 5 minutes", () => {
  assert.deepEqual(LOCK_CHOICES, [1, 5, 15, 30]);
  let now = 0;
  let locked = 0;
  const a = createAutoLock({ minutes: 999, now: () => now, onLock: () => locked++ });
  assert.equal(a.minutes, 5);
  a.setMinutes(1);
  now = 60_000;
  a.tick();
  assert.equal(locked, 1);
});
