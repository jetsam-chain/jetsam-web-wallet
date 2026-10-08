// Sends this browser made: their inputs stay reserved (no double spend from
// here) until they are confirmed, or until their anchor can no longer be
// accepted and the node has dropped them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPendingBook, EXPIRY_BLOCKS } from "../js/pending.js";

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

test("never seen again after the anchor expired: dropped, inputs released", () => {
  assert.equal(EXPIRY_BLOCKS, 65); // A + 2 * 32 + 1
  const b = createPendingBook();
  b.add(base);
  b.admitted(TX("a"));
  b.update(TX("a"), { mempool: false, height: null, tip: 320 + 64 });
  assert.equal(b.list()[0].status, "submitted");
  b.update(TX("a"), { mempool: false, height: null, tip: 320 + 65 });
  assert.equal(b.list()[0].status, "dropped");
  assert.equal(b.reservedInputs().size, 0);
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

test("unknown -> admitted, or removed on a recognized refusal", () => {
  const b = createPendingBook();
  b.add(base);
  b.admitted(TX("a"));
  assert.equal(b.list()[0].status, "submitted");
  b.add({ ...base, txid: TX("b"), inputs: [12], outputs: [902] });
  b.remove(TX("b"));
  assert.deepEqual(b.list().map((e) => e.txid), [TX("a")]);
  assert.ok(!b.reservedInputs().has(12));
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
  lost.update(TX("a"), { mempool: false, height: null, tip: 320 + 65 });
  assert.equal(lost.list()[0].status, "dropped");
  assert.equal(lost.reservedInputs().size, 0);
});
