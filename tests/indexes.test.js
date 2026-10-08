// The wallet keeps its own list of address indexes: the node's discovery stops
// at the first empty address, and asking an RPC about 100 addresses at once
// would link them all together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIndexList, MAX_INDEX, SCAN_MAX } from "../js/indexes.js";

test("a new seed wallet has index 0, active", () => {
  const l = createIndexList({ kind: "seed" });
  assert.deepEqual(l.indexes, [0]);
  assert.equal(l.active, 0);
});

test("restoring a saved list keeps only sane, unique, sorted indexes", () => {
  const l = createIndexList({ kind: "seed", saved: { indexes: [3, 0, 3, -1, 1.5, "2", MAX_INDEX + 1, 7], active: 7 } });
  assert.deepEqual(l.indexes, [0, 3, 7]);
  assert.equal(l.active, 7);
  const m = createIndexList({ kind: "seed", saved: { indexes: [2], active: 9 } });
  assert.deepEqual(m.indexes, [2]);
  assert.equal(m.active, 2, "active falls back to a listed index");
  const n = createIndexList({ kind: "seed", saved: "garbage" });
  assert.deepEqual(n.indexes, [0]);
});

test("next() adds the index after the highest one and makes it active", () => {
  const l = createIndexList({ kind: "seed", saved: { indexes: [0, 4], active: 0 } });
  assert.equal(l.next(), 5);
  assert.deepEqual(l.indexes, [0, 4, 5]);
  assert.equal(l.active, 5);
});

test("scan proposes a few indexes past the highest, never more than SCAN_MAX", () => {
  const l = createIndexList({ kind: "seed", saved: { indexes: [0, 1], active: 0 } });
  assert.deepEqual(l.scanCandidates(3), [2, 3, 4]);
  assert.equal(l.scanCandidates(1000).length, SCAN_MAX);
  assert.ok(SCAN_MAX <= 10);
  assert.deepEqual(l.indexes, [0, 1], "proposing does not add");
  l.addFound([3]);
  assert.deepEqual(l.indexes, [0, 1, 3]);
});

test("the top of the range is respected", () => {
  const l = createIndexList({ kind: "seed", saved: { indexes: [MAX_INDEX], active: MAX_INDEX } });
  assert.equal(l.next(), null);
  assert.deepEqual(l.scanCandidates(5), []);
});

test("an imported spend secret has exactly one address", () => {
  const l = createIndexList({ kind: "spend", saved: { indexes: [0, 1, 2], active: 2 } });
  assert.deepEqual(l.indexes, [0]);
  assert.equal(l.active, 0);
  assert.equal(l.next(), null);
  assert.deepEqual(l.scanCandidates(3), []);
});

test("setActive only accepts listed indexes; hide keeps at least one", () => {
  const l = createIndexList({ kind: "seed", saved: { indexes: [0, 1], active: 0 } });
  assert.equal(l.setActive(1), true);
  assert.equal(l.setActive(5), false);
  assert.equal(l.active, 1);
  l.hide(1);
  assert.deepEqual(l.indexes, [0]);
  assert.equal(l.active, 0);
  l.hide(0);
  assert.deepEqual(l.indexes, [0], "the last address cannot be hidden");
  assert.deepEqual(l.toJSON(), { indexes: [0], active: 0 });
});
