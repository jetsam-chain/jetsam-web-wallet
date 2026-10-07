import { test } from "node:test";
import assert from "node:assert/strict";
import { startProgress } from "../js/progress.js";

test("outputs already located (cache) count as done from the start", () => {
  const p = startProgress(5, [10n, 11n, 12n]);
  assert.equal(p.total, 8);
  assert.equal(p.done, 5);
  assert.equal(p.finished, false);
});

test("each id counts once, whatever the order or repetition", () => {
  const p = startProgress(0, [3n, 1n, 3n, 2n]);
  assert.equal(p.total, 3);
  p.resolve(1n);
  p.resolve(1n);
  assert.equal(p.done, 1);
  p.resolve(3n);
  p.resolve(2n);
  assert.equal(p.done, 3);
  assert.equal(p.finished, true);
});

test("an id that could not be located still moves the counter", () => {
  const p = startProgress(0, [7n]);
  p.resolve(7n, null);
  assert.equal(p.done, 1);
  assert.equal(p.finished, true);
});

test("ids that were not asked for are ignored", () => {
  const p = startProgress(1, [7n]);
  p.resolve(99n);
  assert.equal(p.done, 1);
  assert.equal(p.total, 2);
});

test("nothing to look up: finished at once", () => {
  const p = startProgress(4, []);
  assert.equal(p.total, 4);
  assert.equal(p.done, 4);
  assert.equal(p.finished, true);
  assert.equal(p.lookups, 0);
});

test("lookups counts only what still has to be fetched", () => {
  assert.equal(startProgress(30, [1n, 2n, 3n, 4n]).lookups, 4);
});
