// The backup gate of a new wallet: nothing is shown to receive funds until the
// encrypted file was saved, the secret was shown once and parts of it were
// typed back correctly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackupFlow, GROUPS, CHALLENGES, MAX_ATTEMPTS } from "../js/backup.js";

// The groups are drawn by the key worker (the module), not by the page: the
// page only shows them and relays the answer (SEC-01).
test("the groups come from the worker and are checked for shape", () => {
  assert.equal(GROUPS, 16); // 64 hex digits in groups of 4
  assert.equal(CHALLENGES, 3);
  for (const bad of [null, [1, 2], [1, 1, 2], [0, 5, 16], [0, 1, 2.5], ["1", 2, 3]]) {
    const f = createBackupFlow();
    f.passwordSet(); f.fileSaved(); f.secretShown();
    assert.throws(() => f.secretWritten(bad), /groups/, JSON.stringify(bad));
  }
});

test("the happy path, in order", () => {
  const f = createBackupFlow();
  assert.equal(f.state, "password");
  assert.equal(f.addressVisible, false);
  f.passwordSet();
  assert.equal(f.state, "file");
  f.fileSaved();
  assert.equal(f.state, "reveal");
  f.secretShown();
  assert.equal(f.state, "written");
  f.secretWritten([0, 4, 9]);
  assert.equal(f.state, "quiz");
  assert.deepEqual(f.challenges, [0, 4, 9]);
  assert.equal(f.addressVisible, false);
  f.answer({ ok: true, attemptsLeft: 3 });
  assert.equal(f.state, "done");
  assert.equal(f.addressVisible, true);
});

test("steps cannot be skipped or replayed", () => {
  const f = createBackupFlow();
  assert.throws(() => f.fileSaved(), /order/);
  assert.throws(() => f.answer({ ok: true, attemptsLeft: 3 }), /order/);
  f.passwordSet();
  assert.throws(() => f.secretShown(), /order/);
  f.fileSaved();
  f.secretShown();
  assert.throws(() => f.secretShown(), /order/, "the secret is shown once");
  assert.equal(f.state, "written");
});

test("wrong answers: the worker's count of attempts decides, then the wallet must be recreated", () => {
  const f = createBackupFlow();
  f.passwordSet(); f.fileSaved(); f.secretShown(); f.secretWritten([1, 2, 3]);
  for (let k = 1; k < MAX_ATTEMPTS; k++) {
    f.answer({ ok: false, attemptsLeft: MAX_ATTEMPTS - k });
    assert.equal(f.state, "quiz");
    assert.equal(f.attemptsLeft, MAX_ATTEMPTS - k);
  }
  f.answer({ ok: false, attemptsLeft: 0 });
  assert.equal(f.state, "failed");
  assert.equal(f.addressVisible, false);
  assert.throws(() => f.answer({ ok: true, attemptsLeft: 0 }), /order/);
});

test("a count the worker did not lower cannot buy more attempts", () => {
  const f = createBackupFlow();
  f.passwordSet(); f.fileSaved(); f.secretShown(); f.secretWritten([1, 2, 3]);
  f.answer({ ok: false, attemptsLeft: 2 });
  f.answer({ ok: false, attemptsLeft: 7 });
  assert.equal(f.attemptsLeft, 1);
  f.answer({ ok: false, attemptsLeft: "x" });
  assert.equal(f.state, "failed");
});

test("a fresh flow after failure starts from the password again", () => {
  const f = createBackupFlow();
  assert.equal(f.state, "password");
});
