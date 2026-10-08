// Sends this browser made: their inputs stay reserved (no double spend from
// here) until they are confirmed, or until their anchor can no longer be
// accepted and the node has dropped them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPendingBook, EXPIRY_BLOCKS, RECHECK_BLOCKS } from "../js/pending.js";

const TX = (c) => c.repeat(64);
const base = {
  txid: TX("a"), fromIndex: 0, to: "j1dest", amount: 1_000_000n, fee: 9_000n,
  inputs: [10, 11], outputs: [900, 901], anchorHeight: 320, submittedAt: 1_700_000_000_000,
};

test("a submitted send reserves its inputs and outputs", () => {
  const b = createPendingBook();
  b.add(base);
  b.admitted(TX("a"));
  assert.deepEqual([...b.reservedInputs()].sort(), [10, 11]);
  assert.deepEqual([...b.reservedOutputs()].sort(), [900, 901]);
  assert.equal(b.list()[0].status, "submitted");
});

test("lifecycle: mempool, confirmed, final", () => {
  const b = createPendingBook();
  b.add(base);
  b.update(TX("a"), { mempool: true, height: null, tip: 330 });
  assert.equal(b.list()[0].status, "mempool");
  b.update(TX("a"), { mempool: false, height: 331, tip: 331 });
  assert.equal(b.list()[0].status, "confirmed");
  assert.equal(b.list()[0].height, 331);
  assert.equal(b.reservedInputs().size, 2, "still reserved until final");
  b.update(TX("a"), { mempool: false, height: 331, tip: 338 });
  assert.equal(b.list()[0].status, "confirmed", "8 confirmations, final at tip >= height + 8");
  b.update(TX("a"), { mempool: false, height: 331, tip: 339 });
  assert.equal(b.list()[0].status, "final");
  assert.equal(b.reservedInputs().size, 0);
});

// SEC2-02: the expiry comes from the RPC's tip, which it can inflate while
// hiding the mempool. It is believed only when consistent: the block at the
// expiry height is served, two reads at least a minute apart agree, the tip
// never moved faster than one block per 15 s, and enough wall-clock time has
// passed since the submission for the chain to get there.
const T0 = base.submittedAt;
const MIN = 60_000;
const gone = (tip, now, expiryBlock = true) => ({ mempool: false, height: null, tip, now, expiryBlock });

test("never seen again after the anchor expired: dropped after two consistent reads, inputs released", () => {
  assert.equal(EXPIRY_BLOCKS, 65); // A + 2 * 32 + 1
  const b = createPendingBook();
  b.add({ ...base, submitTip: 322 });
  b.admitted(TX("a"));
  b.update(TX("a"), gone(320 + 64, T0 + 70 * MIN));
  assert.equal(b.list()[0].status, "submitted");
  assert.equal(b.list()[0].expiring, false);
  b.update(TX("a"), gone(320 + 65, T0 + 70 * MIN));
  assert.equal(b.list()[0].status, "submitted", "one read: may still be mined");
  assert.equal(b.list()[0].expiring, true, "the doubt is shown");
  assert.equal(b.reservedInputs().size, 2);
  b.update(TX("a"), gone(320 + 66, T0 + 70.5 * MIN));
  assert.equal(b.list()[0].status, "submitted", "reads less than a minute apart");
  b.update(TX("a"), gone(320 + 66, T0 + 71 * MIN));
  assert.equal(b.list()[0].status, "dropped");
  assert.equal(b.reservedInputs().size, 0);
});

test("an expiry reported too soon after the submission is not believed (tip +200 in seconds)", () => {
  const b = createPendingBook();
  b.add({ ...base, submitTip: 322 });
  b.admitted(TX("a"));
  // 63 blocks to go from 322 to 385: at least 63 * 15 s = 15.75 min.
  b.update(TX("a"), gone(522, T0 + 15_000));
  b.update(TX("a"), gone(522, T0 + 2 * MIN));
  b.update(TX("a"), gone(522, T0 + 10 * MIN));
  assert.equal(b.list()[0].status, "submitted");
  assert.equal(b.reservedInputs().size, 2);
  b.update(TX("a"), gone(522, T0 + 16 * MIN));
  assert.equal(b.list()[0].status, "dropped", "a lie kept up long enough is believed (documented residual)");
});

test("no block at the expiry height, a tip going back, or a jump between reads: the doubt starts over", () => {
  const b = createPendingBook();
  b.add({ ...base, submitTip: 322 });
  b.update(TX("a"), gone(400, T0 + 100 * MIN, false));
  b.update(TX("a"), gone(400, T0 + 102 * MIN, false));
  assert.equal(b.list()[0].status, "unknown", "the RPC serves no block at the expiry height");
  b.update(TX("a"), gone(400, T0 + 103 * MIN));
  b.update(TX("a"), gone(390, T0 + 105 * MIN));
  assert.equal(b.list()[0].status, "unknown", "the tip went back");
  b.update(TX("a"), gone(395, T0 + 105.5 * MIN));
  b.update(TX("a"), gone(600, T0 + 107 * MIN));
  assert.equal(b.list()[0].status, "unknown", "205 blocks in a minute");
  b.update(TX("a"), gone(602, T0 + 108 * MIN));
  assert.equal(b.list()[0].status, "dropped");
});

test("'dropped' is not final: found mined later -> confirmed, flagged; looked up for RECHECK_BLOCKS", () => {
  const b = createPendingBook();
  b.add({ ...base, submitTip: 322 });
  b.admitted(TX("a"));
  b.update(TX("a"), gone(400, T0 + 100 * MIN));
  b.update(TX("a"), gone(401, T0 + 101 * MIN));
  assert.equal(b.list()[0].status, "dropped");
  assert.deepEqual(b.tracked().map((e) => e.txid), [TX("a")], "still looked up");
  assert.deepEqual(b.open(), [], "but no longer holding");
  b.update(TX("a"), { mempool: false, height: 402, tip: 403, now: T0 + 102 * MIN });
  assert.equal(b.list()[0].status, "confirmed");
  assert.equal(b.list()[0].contradicted, "expired");
  assert.deepEqual([...b.reservedInputs()].sort(), [10, 11]);
  const c = createPendingBook();
  c.add({ ...base, submitTip: 322 });
  c.update(TX("a"), gone(400, T0 + 100 * MIN));
  c.update(TX("a"), gone(401, T0 + 101 * MIN));
  c.update(TX("a"), gone(320 + EXPIRY_BLOCKS + RECHECK_BLOCKS, T0 + 2000 * MIN));
  assert.deepEqual(c.tracked(), [], "a day of blocks later: no longer looked up");
  assert.equal(c.list()[0].status, "dropped");
});

test("a confirmation undone by a reorganisation goes back to waiting", () => {
  const b = createPendingBook();
  b.add(base);
  b.update(TX("a"), { mempool: false, height: 331, tip: 333 });
  b.update(TX("a"), { mempool: true, height: null, tip: 333 });
  assert.equal(b.list()[0].status, "mempool");
});

test("saved books are re-checked on load; junk is dropped", () => {
  const b = createPendingBook();
  b.add(base);
  const saved = JSON.parse(JSON.stringify(b.toJSON()));
  const again = createPendingBook(saved);
  assert.deepEqual(again.list()[0].amount, 1_000_000n);
  assert.deepEqual([...again.reservedInputs()].sort(), [10, 11]);
  const junk = createPendingBook([{ txid: "x" }, null, 5, { ...saved[0], inputs: ["a"] }, saved[0]]);
  assert.equal(junk.list().length, 1);
});

test("duplicate txid is not added twice; open() lists only what is not final/dropped", () => {
  const b = createPendingBook();
  b.add(base);
  b.add(base);
  assert.equal(b.list().length, 1);
  b.add({ ...base, txid: TX("b"), inputs: [12], outputs: [902] });
  b.update(TX("b"), { mempool: false, height: 300, tip: 320 });
  assert.deepEqual(b.open().map((e) => e.txid), [TX("a")]);
});

// SEC-02/SEC-03: recorded before the request leaves, as "unknown", inputs
// reserved; resolved by asking the RPC about the txid computed here.
test("a submission is recorded as unknown before it is sent, inputs reserved", () => {
  const b = createPendingBook();
  b.add(base);
  assert.equal(b.list()[0].status, "unknown");
  assert.deepEqual([...b.reservedInputs()].sort(), [10, 11]);
  assert.deepEqual(b.open().map((e) => e.txid), [TX("a")], "tracked");
  const saved = createPendingBook(JSON.parse(JSON.stringify(b.toJSON())));
  assert.equal(saved.list()[0].status, "unknown", "survives a reload");
});

test("unknown -> admitted; removed only when the intent never left this browser", () => {
  const b = createPendingBook();
  b.add(base);
  b.admitted(TX("a"));
  assert.equal(b.list()[0].status, "submitted");
  b.add({ ...base, txid: TX("b"), inputs: [12], outputs: [902] });
  b.remove(TX("b"));
  assert.deepEqual(b.list().map((e) => e.txid), [TX("a")]);
  assert.ok(!b.reservedInputs().has(12));
});

// SEC2-01: a refusal is only what the RPC says. The entry is kept, its inputs
// stay reserved, and it is tracked like an unknown outcome: if it shows up
// anyway, the RPC lied.
test("a refusal keeps the entry, its inputs reserved, and tracks it", () => {
  const b = createPendingBook();
  b.add(base);
  b.refused(TX("a"));
  assert.equal(b.list()[0].status, "refused");
  assert.deepEqual([...b.reservedInputs()].sort(), [10, 11]);
  assert.deepEqual([...b.reservedOutputs()].sort(), [900, 901]);
  assert.deepEqual(b.open().map((e) => e.txid), [TX("a")]);
  const again = createPendingBook(JSON.parse(JSON.stringify(b.toJSON())));
  assert.equal(again.list()[0].status, "refused", "survives a reload");
  assert.equal(again.reservedInputs().size, 2);
});

test("a 'refused' payment seen in the mempool or on the chain: the RPC lied", () => {
  const b = createPendingBook();
  b.add(base);
  b.refused(TX("a"));
  b.update(TX("a"), { mempool: false, height: null, tip: 330, now: base.submittedAt + 1000 });
  assert.equal(b.list()[0].status, "refused", "not seen: still held");
  assert.equal(b.list()[0].contradicted, null);
  b.update(TX("a"), { mempool: true, height: null, tip: 330, now: base.submittedAt + 2000 });
  assert.equal(b.list()[0].status, "mempool");
  assert.equal(b.list()[0].contradicted, "refused", "the RPC's refusal was false");
  const c = createPendingBook();
  c.add(base);
  c.refused(TX("a"));
  c.update(TX("a"), { mempool: false, height: 331, tip: 332, now: base.submittedAt + 1000 });
  assert.equal(c.list()[0].status, "confirmed");
  assert.equal(c.list()[0].contradicted, "refused");
  assert.equal(createPendingBook(JSON.parse(JSON.stringify(c.toJSON()))).list()[0].contradicted, "refused");
});

test("admitted() never overrides a refusal or a later status", () => {
  const b = createPendingBook();
  b.add(base);
  b.refused(TX("a"));
  b.admitted(TX("a"));
  assert.equal(b.list()[0].status, "refused");
});

test("unknown is resolved by the chain: mempool, confirmed, or expired", () => {
  const seen = createPendingBook();
  seen.add(base);
  seen.update(TX("a"), { mempool: false, height: null, tip: 330 });
  assert.equal(seen.list()[0].status, "unknown", "not seen yet: still unknown, still reserved");
  assert.equal(seen.reservedInputs().size, 2);
  seen.update(TX("a"), { mempool: true, height: null, tip: 331 });
  assert.equal(seen.list()[0].status, "mempool");
  const lost = createPendingBook();
  lost.add(base);
  lost.update(TX("a"), gone(320 + 65, T0 + 100 * MIN));
  assert.equal(lost.list()[0].status, "unknown", "first expired read: still held");
  lost.update(TX("a"), gone(320 + 66, T0 + 101 * MIN));
  assert.equal(lost.list()[0].status, "dropped");
  assert.equal(lost.reservedInputs().size, 0);
});
