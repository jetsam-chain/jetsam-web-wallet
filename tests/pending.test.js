// Sends this browser made: their inputs stay reserved (no double spend from
// here) until they are confirmed, or until their anchor can no longer be
// accepted and the node has dropped them.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPendingBook, holdInfo, EXPIRY_BLOCKS, RECHECK_BLOCKS, MAX_FINISHED, MAX_OPEN, NO_BLOCK_ROUNDS, FINAL_CONFIRM_MS,
  WATCH_EVERY, MAX_PER_ROUND,
} from "../js/pending.js";

const TX = (c) => c.repeat(64);
const base = {
  txid: TX("a"), fromIndex: 0, to: "j1dest", amount: 1_000_000n, fee: 9_000n,
  inputs: [10, 11], outputs: [900, 901], anchorHeight: 320, submittedAt: 1_700_000_000_000,
};
const T0 = base.submittedAt;
const MIN = 60_000;
/** Two consistent reads of `height` at 9 confirmations, two minutes apart: final (SEC3-02). */
const finalize = (b, txid, height, at = T0 + 200 * MIN) => {
  b.update(txid, { mempool: false, height, tip: height + 8, now: at, finalBlock: true });
  b.update(txid, { mempool: false, height, tip: height + 9, now: at + 2 * MIN, finalBlock: true });
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
  assert.equal(b.list()[0].status, "confirmed", "8 confirmations: not final yet (final at 9, tip >= height + 8)");
  b.update(TX("a"), { mempool: false, height: 331, tip: 339, now: T0 + 20 * MIN, finalBlock: true });
  assert.equal(b.list()[0].status, "confirmed", "one deep read is not enough (SEC3-02)");
  b.update(TX("a"), { mempool: false, height: 331, tip: 340, now: T0 + 21 * MIN, finalBlock: true });
  assert.equal(b.list()[0].status, "final");
  assert.equal(b.reservedInputs().size, 0);
});

// SEC2-02: the expiry comes from the RPC's tip, which it can inflate while
// hiding the mempool. It is believed only when consistent: the block at the
// expiry height is served, two reads at least a minute apart agree, the tip
// never moved faster than one block per 15 s, and enough wall-clock time has
// passed since the submission for the chain to get there.
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
  finalize(b, TX("b"), 300);
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

// SEC2-08: the sealed list is capped (1 MiB). Finished entries beyond
// MAX_FINISHED are dropped oldest first; payments still held are never
// dropped, and a new one is refused (not silently lost) past MAX_OPEN.
const txn = (n) => n.toString(16).padStart(64, "0");
const entry = (n) => ({ ...base, txid: txn(n), inputs: [10_000 + n], outputs: [20_000 + 2 * n, 20_001 + 2 * n] });

test("finished entries are pruned oldest first; held ones never", () => {
  const b = createPendingBook();
  b.add(entry(1)); // stays held
  for (let n = 2; n <= MAX_FINISHED + 31; n++) {
    b.add(entry(n));
    finalize(b, txn(n), 300);
  }
  const list = b.list();
  assert.equal(list.filter((e) => e.status === "final").length, MAX_FINISHED);
  assert.ok(list.some((e) => e.txid === txn(1)), "the held one is kept");
  assert.ok(!list.some((e) => e.txid === txn(2)), "the oldest finished one went first");
  assert.ok(list.some((e) => e.txid === txn(MAX_FINISHED + 31)));
  assert.ok(JSON.stringify(b.toJSON()).length < 200_000, "far below the 1 MiB sealing cap");
});

test("past MAX_OPEN payments in flight a new one is refused, loudly", () => {
  const b = createPendingBook();
  for (let n = 1; n <= MAX_OPEN; n++) b.add(entry(n));
  assert.equal(b.full(), true);
  assert.throws(() => b.add(entry(MAX_OPEN + 1)), /too many payments/);
  assert.equal(b.open().length, MAX_OPEN, "nothing held was dropped");
  finalize(b, txn(1), 300);
  assert.equal(b.full(), false);
});

// SEC3-03: an RPC that never serves the block at the expiry height keeps the
// payment "may still be mined" for ever; after NO_BLOCK_ROUNDS rounds the
// page says why and what to do. A refusal (even an honest one) holds the
// inputs until the anchor expires: the page says until which block.
test("no block served at the expiry height: counted, and said after NO_BLOCK_ROUNDS rounds", () => {
  assert.ok(NO_BLOCK_ROUNDS >= 4 && NO_BLOCK_ROUNDS <= 20);
  const b = createPendingBook();
  b.add({ ...base, submitTip: 322 });
  b.refused(TX("a"));
  for (let k = 1; k < NO_BLOCK_ROUNDS; k++) b.update(TX("a"), gone(400, T0 + (100 + k) * MIN, false));
  const e = b.list()[0];
  assert.equal(e.status, "refused");
  assert.equal(e.noBlock, NO_BLOCK_ROUNDS - 1);
  assert.notEqual((holdInfo(e, 400) || {}).kind, "no_block", "not yet");
  b.update(TX("a"), gone(400, T0 + 200 * MIN, false));
  assert.deepEqual(holdInfo(b.list()[0], 400), { kind: "no_block", height: 320 + EXPIRY_BLOCKS });
  assert.equal(createPendingBook(JSON.parse(JSON.stringify(b.toJSON()))).list()[0].noBlock, NO_BLOCK_ROUNDS, "kept across a lock");
  b.update(TX("a"), gone(401, T0 + 201 * MIN, true));
  assert.equal(b.list()[0].noBlock, 0, "the block is served: the count starts over");
  assert.equal(holdInfo(b.list()[0], 401), null);
});

test("a refused or unknown payment says until which block its inputs are held", () => {
  const b = createPendingBook();
  b.add({ ...base, submitTip: 322 });
  b.refused(TX("a"));
  b.update(TX("a"), gone(330, T0 + MIN, false));
  assert.deepEqual(holdInfo(b.list()[0], 330), { kind: "until", height: 385, blocks: 55 });
  assert.equal(holdInfo(b.list()[0], null), null, "no tip known: nothing said");
  const c = createPendingBook();
  c.add(base);
  c.admitted(TX("a"));
  assert.equal(holdInfo(c.list()[0], 330), null, "an accepted payment waiting for a block is not 'held until'");
});

// SEC3-04: proofs of one payment share inputs, so once one of them is final
// the others can never be accepted: they are no longer shown as "refused by
// the RPC: checking…", hold nothing, and say which proof replaced them.

test("a final payment supersedes the held proofs that share an input with it", () => {
  const b = createPendingBook();
  const proof = (c, inputs, outputs) => b.add({ ...base, txid: TX(c), inputs, outputs, submitTip: 322 });
  proof("a", [10, 11], [900, 901]); b.refused(TX("a"));
  proof("b", [10], [902, 903]); b.refused(TX("b"));
  proof("c", [10, 11], [904, 905]); b.admitted(TX("c"));
  proof("d", [12], [906, 907]); b.refused(TX("d")); // another payment
  proof("e", [11], [908, 909]); // outcome unknown, shares input 11
  finalize(b, TX("c"), 330);
  const by = Object.fromEntries(b.list().map((e) => [e.txid[0], e]));
  assert.equal(by.c.status, "final");
  for (const k of ["a", "b", "e"]) {
    assert.equal(by[k].status, "superseded", k);
    assert.equal(by[k].supersededBy, TX("c"), k);
  }
  assert.equal(by.d.status, "refused", "no shared input: untouched");
  assert.deepEqual([...b.reservedInputs()], [12]);
  assert.deepEqual([...b.reservedOutputs()].sort(), [906, 907]);
  assert.deepEqual(b.open().map((e) => e.txid), [TX("d")]);
  const again = createPendingBook(JSON.parse(JSON.stringify(b.toJSON())));
  assert.equal(again.list().find((e) => e.txid === TX("a")).status, "superseded", "survives a lock");
  assert.equal(again.list().find((e) => e.txid === TX("a")).supersededBy, TX("c"));
});

test("a superseded proof is still looked up, and seen wins over 'superseded'", () => {
  const b = createPendingBook();
  b.add({ ...base, txid: TX("a"), submitTip: 322 }); b.refused(TX("a"));
  b.add({ ...base, txid: TX("c"), submitTip: 322 }); b.admitted(TX("c"));
  finalize(b, TX("c"), 330);
  assert.ok(b.tracked().some((e) => e.txid === TX("a")), "still looked up (as a dropped one is)");
  b.update(TX("a"), { mempool: true, height: null, tip: 340, now: T0 + 203 * MIN });
  assert.equal(b.list().find((e) => e.txid === TX("a")).status, "mempool");
});

// SEC3-02: "final" used to be decided from one round's tip (a single inflated
// blockCount sufficed) and was terminal. Now it takes two reads at least
// FINAL_CONFIRM_MS apart, both at 9 confirmations or more, with the block checked
// (finalBlock: getTx's block is the one served at that height, and the block
// 8 above is served); and a final payment is still looked up: one that
// disappears goes back to waiting, flagged.
test("final: two deep reads FINAL_CONFIRM_MS apart with the block checked; one inflated tip is not enough", () => {
  assert.ok(FINAL_CONFIRM_MS >= 30_000);
  const b = createPendingBook();
  b.add(base);
  b.admitted(TX("a"));
  const read = (tip, ms, finalBlock = true) => b.update(TX("a"), { mempool: false, height: 331, tip, now: T0 + ms, finalBlock });
  read(531, 0); // the tip +200 for one round
  assert.equal(b.list()[0].status, "confirmed");
  read(332, 15_000); // honest again
  assert.equal(b.list()[0].status, "confirmed");
  read(339, 30_000);
  read(340, 30_000 + FINAL_CONFIRM_MS - 1);
  assert.equal(b.list()[0].status, "confirmed", "reads too close together");
  read(341, 30_000 + FINAL_CONFIRM_MS, false);
  assert.equal(b.list()[0].status, "confirmed", "the block could not be checked: starts over");
  read(342, 40_000 + FINAL_CONFIRM_MS);
  read(343, 40_000 + 2 * FINAL_CONFIRM_MS);
  assert.equal(b.list()[0].status, "final");
  const moved = createPendingBook();
  moved.add(base);
  moved.update(TX("a"), { mempool: false, height: 331, tip: 340, now: T0, finalBlock: true });
  moved.update(TX("a"), { mempool: false, height: 333, tip: 342, now: T0 + 2 * MIN, finalBlock: true });
  assert.equal(moved.list()[0].status, "confirmed", "another height (reorganised): starts over");
});

test("final is not terminal: still looked up; a payment that disappears goes back to waiting, flagged", () => {
  const b = createPendingBook();
  b.add({ ...base, submitTip: 322 });
  b.admitted(TX("a"));
  b.add({ ...base, txid: TX("b"), submitTip: 322 });
  b.refused(TX("b")); // a sibling proof on the same inputs
  finalize(b, TX("a"), 331);
  assert.equal(b.list()[0].status, "final");
  assert.equal(b.list()[1].status, "superseded");
  assert.ok(b.tracked().some((e) => e.txid === TX("a")), "a final payment is still looked up");
  b.update(TX("a"), { mempool: false, height: 331, tip: 345, now: T0 + 210 * MIN });
  assert.equal(b.list()[0].status, "final", "seen again, still deep: unchanged");
  b.update(TX("a"), { mempool: false, height: null, tip: 346, now: T0 + 211 * MIN });
  const e = b.list()[0];
  assert.equal(e.status, "submitted", "gone: waiting again");
  assert.equal(e.contradicted, "final");
  assert.deepEqual([...b.reservedInputs()].sort(), [10, 11], "its inputs are held again");
  assert.equal(b.list()[1].status, "unknown", "the sibling it had replaced is held again");
  assert.equal(createPendingBook(JSON.parse(JSON.stringify(b.toJSON()))).list()[0].contradicted, "final");
});

test("a final payment seen shallower again (the inflated tip is gone) is only confirmed", () => {
  const b = createPendingBook();
  b.add(base);
  finalize(b, TX("a"), 331);
  b.update(TX("a"), { mempool: false, height: 331, tip: 333, now: T0 + 300 * MIN });
  assert.equal(b.list()[0].status, "confirmed");
  assert.equal(b.reservedInputs().size, 2);
});

test("final payments are looked up for RECHECK_BLOCKS, and pruned like finished ones", () => {
  const b = createPendingBook();
  b.add(base);
  finalize(b, TX("a"), 331);
  b.update(TX("a"), { mempool: false, height: 331, tip: 331 + RECHECK_BLOCKS, now: T0 + 3000 * MIN });
  assert.deepEqual(b.tracked(), [], "a day of blocks later: no longer looked up");
  assert.equal(b.list()[0].status, "final");
});

// SEC3-01: an RPC that simply hides a mined payment (null from getMempoolEntry
// and getTx, honest tip and block ids) passed every consistency check of
// SEC2-02: "Expired", inputs free, and a second payment. Before an expiry is
// believed, the txid is looked up on the network's public RPC as well
// (`reference`): it must not see the payment and be past the expiry height.
// reference: null = no cross-check applies (the configured RPC is the public
// one, or the check is off); "skipped" = applies, not asked this round;
// "unreachable"; or { mempool, height, tip } from the public RPC.
const expire = (b, reference, txid = TX("a")) => {
  b.update(txid, { ...gone(400, T0 + 100 * MIN), reference });
  b.update(txid, { ...gone(401, T0 + 101 * MIN), reference });
  return b.list().find((e) => e.txid === txid);
};
const fresh = () => {
  const b = createPendingBook();
  b.add({ ...base, submitTip: 322 });
  b.admitted(TX("a"));
  return b;
};

test("hidden by the configured RPC, seen by the public one: never 'Expired', inputs held, flagged", () => {
  for (const ref of [{ mempool: false, height: 331, tip: 401 }, { mempool: true, height: null, tip: 401 }]) {
    const b = fresh();
    const e = expire(b, ref);
    assert.equal(e.status, "submitted");
    assert.equal(e.crossCheck, "seen");
    assert.deepEqual([...b.reservedInputs()].sort(), [10, 11]);
    b.update(TX("a"), { ...gone(402, T0 + 110 * MIN), reference: ref });
    assert.equal(b.list()[0].status, "submitted", "for as long as the public RPC sees it");
  }
});

test("public RPC unreachable, behind the expiry height, or not asked: the expiry is not believed", () => {
  for (const ref of ["unreachable", { mempool: false, height: null, tip: 384 }]) {
    const b = fresh();
    const e = expire(b, ref);
    assert.equal(e.status, "submitted", JSON.stringify(ref));
    assert.equal(e.expiring, true);
    assert.equal(e.crossCheck, "unconfirmed");
    assert.equal(b.reservedInputs().size, 2);
  }
  const b = fresh();
  assert.equal(expire(b, "skipped").status, "submitted", "not asked this round: no drop");
});

test("public RPC agrees (does not see it, past the expiry): 'Expired', noted as checked", () => {
  const b = fresh();
  const e = expire(b, { mempool: false, height: null, tip: 401 });
  assert.equal(e.status, "dropped");
  assert.equal(e.checked, "public");
  assert.equal(e.crossCheck, null);
  assert.equal(b.reservedInputs().size, 0);
  assert.equal(createPendingBook(JSON.parse(JSON.stringify(b.toJSON()))).list()[0].checked, "public");
});

test("no cross-check (the configured RPC is the public one, or the check is off): the expiry rests on one RPC, and says so", () => {
  const b = fresh();
  const e = expire(b, null);
  assert.equal(e.status, "dropped");
  assert.equal(e.checked, "alone");
});

test("seen by the configured RPC: the cross-check flag is cleared", () => {
  const b = fresh();
  expire(b, { mempool: true, height: null, tip: 401 });
  b.update(TX("a"), { mempool: false, height: 402, tip: 403, now: T0 + 102 * MIN, reference: "skipped" });
  assert.equal(b.list()[0].status, "confirmed");
  assert.equal(b.list()[0].crossCheck, null);
});

test("final with the public RPC reachable: it must list the payment in a block too (SEC3-02)", () => {
  const read = (b, tip, ms, reference) => b.update(TX("a"), { mempool: false, height: 331, tip, now: T0 + ms, finalBlock: true, reference });
  const notThere = { mempool: false, height: null, tip: 345 };
  const b = fresh();
  read(b, 340, 0, notThere);
  read(b, 341, 2 * MIN, notThere);
  assert.equal(b.list()[0].status, "confirmed", "the public RPC does not have it in a block");
  const c = fresh();
  read(c, 340, 0, { mempool: false, height: 331, tip: 345 });
  read(c, 341, 2 * MIN, "unreachable");
  assert.equal(c.list()[0].status, "final", "unreachable: the two checked reads decide (if available only)");
});

// SEC3-01 (2): paying again the recipient of a payment that may still be
// mined can pay twice. The review asks for an explicit confirmation.
test("earlierTo: recent refused, unknown, expired or doubtful payments to the same address, of about the same amount", () => {
  const b = createPendingBook();
  const pay = (c, amount, to = "j1dest") => b.add({ ...base, txid: TX(c), inputs: [c.charCodeAt(0)], outputs: [1000 + c.charCodeAt(0)], amount, to, submitTip: 322 });
  pay("a", 1_000_000n); b.refused(TX("a"));
  pay("b", 1_050_000n); // unknown
  pay("c", 1_000_000n); b.admitted(TX("c")); expire(b, null, TX("c")); // expired (on one RPC's word)
  pay("d", 1_000_000n); b.admitted(TX("d")); // waiting, no doubt
  pay("e", 5_000_000n); b.refused(TX("e")); // another amount
  pay("f", 1_000_000n, "j1other"); b.refused(TX("f")); // another recipient
  pay("9", 1_000_000n); b.admitted(TX("9")); expire(b, "unreachable", TX("9")); // may still be mined
  const hits = (to, amount) => b.earlierTo(to, amount).map((e) => e.txid[0]).sort().join("");
  assert.equal(hits("j1dest", 1_000_000n), "9abc");
  assert.equal(hits("j1dest", 950_000n), "9abc", "within 10 %");
  assert.equal(hits("j1dest", 2_000_000n), "");
  assert.equal(hits("j1nobody", 1_000_000n), "");
  b.update(TX("c"), gone(320 + EXPIRY_BLOCKS + RECHECK_BLOCKS, T0 + 3000 * MIN));
  assert.ok(!hits("j1dest", 1_000_000n).includes("c"), "an expiry more than a day old is not 'recent'");
});

// SEC3-06: tracking load. Held payments are looked up every round, finished
// ones still watched (expired, final, replaced) one round in WATCH_EVERY; at
// most MAX_PER_ROUND per round, in turn; and the round's own tip decides what
// is still watched (the first round after an unlock used to visit them all).
test("dueIn: held every round, watched ones one round in WATCH_EVERY", () => {
  assert.ok(WATCH_EVERY >= 4 && MAX_PER_ROUND >= 10 && MAX_PER_ROUND < MAX_OPEN);
  const b = createPendingBook();
  b.add({ ...base, submitTip: 322 });
  b.admitted(TX("a"));
  b.add({ ...base, txid: TX("b"), inputs: [12], outputs: [902], submitTip: 322 });
  expire(b, null, TX("b"));
  assert.equal(b.list()[1].status, "dropped");
  const ids = (r) => b.dueIn(r, 402).map((e) => e.txid[0]).join("");
  assert.equal(ids(0), "ab");
  for (let r = 1; r < WATCH_EVERY; r++) assert.equal(ids(r), "a", "round " + r);
  assert.equal(ids(WATCH_EVERY), "ab");
});

test("dueIn: at most MAX_PER_ROUND per round, every held one in turn", () => {
  const b = createPendingBook();
  for (let n = 1; n <= MAX_OPEN; n++) b.add(entry(n));
  const seen = new Set();
  const rounds = Math.ceil(MAX_OPEN / MAX_PER_ROUND);
  for (let r = 1; r <= rounds; r++) {
    const due = b.dueIn(r, 330);
    assert.ok(due.length <= MAX_PER_ROUND);
    for (const e of due) seen.add(e.txid);
  }
  assert.equal(seen.size, MAX_OPEN, "all held payments within " + rounds + " rounds");
});

test("dueIn: the round's tip decides what is still watched (no full sweep after an unlock)", () => {
  const b = createPendingBook();
  b.add({ ...base, submitTip: 322 });
  b.admitted(TX("a"));
  expire(b, null);
  const saved = JSON.parse(JSON.stringify(b.toJSON()));
  const again = createPendingBook(saved); // after a lock: no tip known yet
  assert.equal(again.tracked().length, 1, "without a tip it is still a candidate (tracking starts)");
  assert.deepEqual(again.dueIn(0, 320 + EXPIRY_BLOCKS + RECHECK_BLOCKS + 5), [], "a day old at the tip just read: not looked up");
});
