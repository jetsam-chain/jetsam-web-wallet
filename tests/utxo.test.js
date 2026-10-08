import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJson } from "../js/bigjson.js";
import {
  COINBASE_TAG,
  FINALITY_DEPTH,
  normalizeSlots,
  confirmations,
  isProvisional,
  summarize,
} from "../js/utxo.js";

const FUND = "j1wl99gzalncqhk052zw07jymxh5qdhr9q2xx3zwjzqeny620sgncqkfyv2z";
const fixture = (name) =>
  parseJson(readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8")).result;

test("constants match the chain", () => {
  // params.rs: COINBASE_CREATION_TAG = 1 << 63; CONSENSUS_FINALITY_DEPTH = 8.
  assert.equal(COINBASE_TAG, 1n << 63n);
  assert.equal(FINALITY_DEPTH, 8);
});

test("coinbase outputs carry their height in creation_id", () => {
  const rows = normalizeSlots(fixture("slots-coinbase-sample.raw.json"), "REDACTED");
  assert.deepEqual(rows.map((r) => r.height), [1, 210, 1730, 5523]);
  assert.ok(rows.every((r) => r.coinbase));
  assert.equal(rows[0].creationId, 9223372036854775809n);
  assert.equal(rows[0].value, 45_000_000n);
  assert.equal(rows[0].slot, 9699328);
});

test("received outputs carry an allocation counter, not a height", () => {
  const rows = normalizeSlots(fixture("slots-fund-network.raw.json"), FUND);
  assert.equal(rows.length, 33);
  assert.ok(rows.every((r) => !r.coinbase && r.height === null));
  assert.equal(rows[0].creationId, 18471n);
});

test("the proxy's creation_height is cross-checked, never trusted alone", () => {
  const raw = [{ slot_index: 1n, value: 5n, creation_id: (1n << 63n) | 10n, owner: FUND, empty: false, creation_height: 11n }];
  assert.throws(() => normalizeSlots(raw, FUND), /creation_height/);
});

test("rows owned by another address are refused", () => {
  const raw = [{ slot_index: 1n, value: 5n, creation_id: 3n, owner: "j1other", empty: false }];
  assert.throws(() => normalizeSlots(raw, FUND), /owner/);
});

test("empty slots and malformed rows are refused", () => {
  assert.throws(() => normalizeSlots([{ slot_index: 1n, value: 5n, creation_id: 3n, owner: FUND, empty: true }], FUND), /empty/);
  assert.throws(() => normalizeSlots([{ slot_index: 1n, value: 5, creation_id: 3n, owner: FUND, empty: false }], FUND), /value/);
  assert.throws(() => normalizeSlots([{ slot_index: 1n, value: -5n, creation_id: 3n, owner: FUND, empty: false }], FUND), /value/);
  assert.throws(() => normalizeSlots(null, FUND), /list/);
});

test("confirmations count the block itself", () => {
  assert.equal(confirmations(100, 100), 1);
  assert.equal(confirmations(100, 91), 10);
  assert.equal(confirmations(100, null), null);
  assert.equal(confirmations(100, 101), 0); // tip read before the output's block
});

test("provisional until below the finality depth", () => {
  // Mirrors consensus/header.rs `is_final`: tip_height >= block_height + 8.
  assert.equal(isProvisional(100, 100), true);
  assert.equal(isProvisional(93, 100), true);
  assert.equal(isProvisional(92, 100), false); // tip - h == 8 -> final
  assert.equal(isProvisional(92, 99), true);
  assert.equal(isProvisional(91, 100), false);
  assert.equal(isProvisional(null, 100), false);
});

test("summarize: total, provisional part, counts", () => {
  const rows = [
    { value: 10n, height: 50, coinbase: true },
    { value: 20n, height: 99, coinbase: true },
    { value: 30n, height: 98, coinbase: false },
    { value: 40n, height: null, coinbase: false },
  ];
  const s = summarize(rows, 100);
  assert.equal(s.total, 100n);
  assert.equal(s.provisional, 50n);
  assert.equal(s.count, 4);
  assert.equal(s.coinbaseCount, 2);
});

test("summarize the real fund-network response: 33 outputs, 74,400 JTM", () => {
  const rows = normalizeSlots(fixture("slots-fund-network.raw.json"), FUND);
  const s = summarize(rows, 32545);
  assert.equal(s.total, 74_400_000_000n);
  assert.equal(s.count, 33);
});

// SEC-07: a slot holds one output. The audit's RPC repeated every row: the
// balance doubled and a plan could select the same input twice.
test("a slot listed twice is refused, not counted twice", () => {
  const raw = fixture("slots-fund-network.raw.json");
  assert.ok(raw.length >= 1);
  assert.throws(() => normalizeSlots([...raw, raw[0]], FUND), /twice|duplicate/);
  assert.throws(() => normalizeSlots([raw[0], { ...raw[0], value: 1n }], FUND), /twice|duplicate/);
});
