// The backup gate of a new wallet: nothing is shown to receive funds until the
// encrypted file was saved, the secret was shown once and parts of it were
// typed back correctly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackupFlow, pickChallenges, GROUPS, CHALLENGES, MAX_ATTEMPTS } from "../js/backup.js";

// Deterministic stand-in for crypto.getRandomValues in tests only.
function seqRandom(values) {
  let i = 0;
  return (arr) => {
    for (let k = 0; k < arr.length; k++) arr[k] = values[i++ % values.length];
    return arr;
  };
}

test("challenges: distinct groups in range, sorted, from the random source", () => {
  const c = pickChallenges(seqRandom([5, 5, 5, 200, 7, 31]));
  assert.equal(c.length, CHALLENGES);
  assert.equal(new Set(c).size, CHALLENGES);
  assert.ok(c.every((g) => Number.isInteger(g) && g >= 0 && g < GROUPS));
  assert.deepEqual(c, [...c].sort((a, b) => a - b));
  assert.equal(GROUPS, 16); // 64 hex digits in groups of 4
});

test("challenges: rejection sampling, no modulo bias, no endless loop on a stuck source", () => {
  // 255 is rejected (>= 240 = 16 * 15); 0..239 map with % 16
  const c = pickChallenges(seqRandom([255, 255, 1, 17, 2, 3]));
  assert.deepEqual(c, [1, 2, 3]);
  assert.throws(() => pickChallenges(seqRandom([255])), /random/);
});

test("the happy path, in order", () => {
  const f = createBackupFlow({ random: seqRandom([0, 4, 9]) });
  assert.equal(f.state, "password");
  assert.equal(f.addressVisible, false);
  f.passwordSet();
  assert.equal(f.state, "file");
  f.fileSaved();
  assert.equal(f.state, "reveal");
  f.secretShown();
  assert.equal(f.state, "written");
  f.secretWritten();
  assert.equal(f.state, "quiz");
  assert.deepEqual(f.challenges, [0, 4, 9]);
  assert.equal(f.addressVisible, false);
  f.answer(true);
  assert.equal(f.state, "done");
  assert.equal(f.addressVisible, true);
});

test("steps cannot be skipped or replayed", () => {
  const f = createBackupFlow({ random: seqRandom([1, 2, 3]) });
  assert.throws(() => f.fileSaved(), /order/);
  assert.throws(() => f.answer(true), /order/);
  f.passwordSet();
  assert.throws(() => f.secretShown(), /order/);
  f.fileSaved();
  f.secretShown();
  assert.throws(() => f.secretShown(), /order/, "the secret is shown once");
  assert.equal(f.state, "written");
});

test("wrong answers: limited attempts, then the wallet must be recreated", () => {
  const f = createBackupFlow({ random: seqRandom([1, 2, 3, 4, 5, 6]) });
  f.passwordSet(); f.fileSaved(); f.secretShown(); f.secretWritten();
  for (let k = 1; k < MAX_ATTEMPTS; k++) {
    f.answer(false);
    assert.equal(f.state, "quiz");
    assert.equal(f.attemptsLeft, MAX_ATTEMPTS - k);
  }
  f.answer(false);
  assert.equal(f.state, "failed");
  assert.equal(f.addressVisible, false);
  assert.throws(() => f.answer(true), /order/);
});

test("a fresh flow after failure starts from the password again", () => {
  const f = createBackupFlow({ random: seqRandom([1, 2, 3]) });
  assert.equal(f.state, "password");
});
