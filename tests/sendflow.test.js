// Pure parts of a send: which outputs may be spent, output slots when the RPC
// gives no hints, fee sanity against a lying RPC, the request handed to the
// key worker, and what a node refusal means for the user.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  spendable, drawSlots, feeCheck, sendRequestJson, classifySubmitError, reviewStillHolds,
  afterRefusal, reproofUtxos, locateReceived, fundsMessage, FEE_HARD_CAP, FEE_WARN_FACTOR,
} from "../js/sendflow.js";
import { RpcError } from "../js/rpc.js";
import { FINALITY_DEPTH } from "../js/utxo.js";
import { t } from "../js/i18n.js";

const CB = 1n << 63n;
const rows = [
  { slot: 10, value: 5_000_000n, creationId: CB | 100n, coinbase: true, height: 100 },
  { slot: 11, value: 2_000_000n, creationId: CB | 195n, coinbase: true, height: 195 },
  { slot: 12, value: 1_000_000n, creationId: 4242n, coinbase: false, height: null },
  { slot: 13, value: 700_000n, creationId: 4243n, coinbase: false, height: 150 },
];

test("spendable: pending inputs, provisional outputs and unknown heights are held back", () => {
  const s = spendable(rows, { tip: 200, pendingInputs: new Set([13]) });
  assert.deepEqual(s.utxos.map((u) => u.slot_index), [10]);
  assert.equal(s.total, 5_000_000n);
  assert.equal(s.provisional, 2_000_000n, "coinbase at 195 has 6 confirmations at tip 200");
  assert.equal(s.pending, 700_000n);
  assert.equal(s.unknown, 1_000_000n, "a received output whose block is not known is not spent");
  // u64 travel as decimal strings to the worker
  assert.deepEqual(s.utxos[0], { slot_index: 10, value: "5000000", creation_id: (CB | 100n).toString() });
});

test("spendable: final once tip >= height + 8 (consensus is_final)", () => {
  assert.equal(spendable(rows, { tip: 202, pendingInputs: new Set() }).provisional, 2_000_000n);
  const s = spendable(rows, { tip: 203, pendingInputs: new Set() });
  assert.equal(s.provisional, 0n);
  assert.deepEqual(s.utxos.map((u) => u.slot_index), [10, 11, 13]);
});

// A received output re-read by the review has its height looked up; the
// boundary is the same as for a coinbase.
test("spendable: a received output still provisional is excluded, a final one included", () => {
  const tip = 1000;
  const recv = (slot, height) => ({ slot, value: 50_000_000n, creationId: BigInt(slot), coinbase: false, height });
  const young = spendable([recv(1, tip - FINALITY_DEPTH + 1)], { tip, pendingInputs: new Set() });
  assert.equal(young.utxos.length, 0);
  assert.equal(young.total, 0n);
  assert.equal(young.provisional, 50_000_000n);
  const old = spendable([recv(2, tip - FINALITY_DEPTH)], { tip, pendingInputs: new Set() });
  assert.deepEqual(old.utxos.map((u) => u.slot_index), [2]);
  assert.equal(old.total, 50_000_000n);
  assert.equal(old.provisional, 0n);
});

test("spendable: unknown height fails closed", () => {
  const s = spendable([{ slot: 7, value: 50_000_000n, creationId: 99n, coinbase: false, height: null }], { tip: 1000, pendingInputs: new Set() });
  assert.equal(s.utxos.length, 0);
  assert.equal(s.total, 0n);
  assert.equal(s.unknown, 50_000_000n);
  const u = spendable([{ slot: 8, value: 5n, creationId: 98n, coinbase: false, height: undefined }], { tip: 1000, pendingInputs: new Set() });
  assert.equal(u.utxos.length, 0);
});

// The counter after each height of a small chain: ids 101..103 at 40, 104 at 41, 105 at 50.
function chainCounter(tip) {
  const at = (h) => (h < 40 ? 100n : h < 41 ? 103n : h < 50 ? 104n : 105n);
  const reads = [];
  return {
    reads,
    allocAt: async (h) => {
      if (h > tip) throw new Error("beyond the tip");
      reads.push(h);
      return at(h);
    },
  };
}

test("locateReceived: heights of received outputs come from the headers", async () => {
  const c = chainCounter(60);
  const rs = [
    { slot: 1, value: 1n, creationId: 102n, coinbase: false, height: null },
    { slot: 2, value: 1n, creationId: 105n, coinbase: false, height: null },
    { slot: 3, value: 1n, creationId: CB | 30n, coinbase: true, height: 30 },
  ];
  await locateReceived(rs, 60, { cache: new Map(), allocAt: c.allocAt });
  assert.deepEqual(rs.map((r) => r.height), [40, 50, 30]);
});

test("locateReceived: a cached height is used only once final; otherwise it is read again", async () => {
  const c = chainCounter(60);
  const rs = [
    { slot: 1, value: 1n, creationId: 102n, coinbase: false, height: null },
    { slot: 2, value: 1n, creationId: 105n, coinbase: false, height: null },
  ];
  // 102 cached at 40 (final at tip 60): no lookup. 105 cached at 57 (wrong, and
  // provisional at tip 60): looked up again, the header says 50.
  const cache = new Map([["102", 40], ["105", 57]]);
  await locateReceived(rs, 60, { cache, allocAt: c.allocAt });
  assert.deepEqual(rs.map((r) => r.height), [40, 50]);
});

test("locateReceived: an output whose block cannot be found keeps no height", async () => {
  const failing = async () => {
    throw new Error("no header");
  };
  const rs = [{ slot: 1, value: 1n, creationId: 102n, coinbase: false, height: null }];
  await locateReceived(rs, 60, { cache: new Map(), allocAt: failing });
  assert.equal(rs[0].height, null);
  // An id above the counter at the tip: the RPC lists an output the chain has not made.
  const c = chainCounter(60);
  const ghost = [{ slot: 2, value: 1n, creationId: 999n, coinbase: false, height: null }];
  await locateReceived(ghost, 60, { cache: new Map(), allocAt: c.allocAt });
  assert.equal(ghost[0].height, null);
});

test("not enough funds: says what is spendable now and what waits", () => {
  // The case reported: 50 JTM received a block ago, 1,000 JTM asked.
  const sp = { total: 0n, provisional: 50_000_000n, pending: 0n, unknown: 0n };
  assert.equal(
    fundsMessage(t, 1_000_009_000n, sp),
    "Not enough spendable now on this address: the payment and its fee need 1,000.009 JTM, 0.00 JTM is spendable now. 50.00 JTM waits for 8 confirmations.",
  );
  const all = { total: 1_500_000n, provisional: 2_000_000n, pending: 700_000n, unknown: 1_000_000n };
  assert.equal(
    fundsMessage(t, 5_000_000n, all),
    "Not enough spendable now on this address: the payment and its fee need 5.00 JTM, 1.50 JTM is spendable now. 2.00 JTM waits for 8 confirmations. 0.70 JTM is in a payment not yet final. 1.00 JTM is in outputs whose block is not found yet.",
  );
  assert.equal(
    fundsMessage(t, null, { total: 0n, provisional: 0n, pending: 0n, unknown: 0n }),
    "Not enough spendable now on this address: the payment and its fee need ? JTM, 0.00 JTM is spendable now.",
  );
});

function counterRandom(values) {
  let i = 0;
  return (arr) => {
    for (let k = 0; k < arr.length; k++) arr[k] = values[i++ % values.length];
    return arr;
  };
}

test("drawSlots: distinct, in range, avoiding known occupied slots", () => {
  const got = drawSlots(2, 4, new Set([3]), counterRandom([3, 3, 19, 5, 7]));
  // 3 avoided, 19 % 16 = 3 avoided again, then 5 and 7
  assert.equal(got.length, 2);
  assert.equal(new Set(got).size, 2);
  assert.ok(got.every((s) => s >= 0 && s < 16 && s !== 3));
  assert.throws(() => drawSlots(2, 1, new Set([0, 1]), counterRandom([0, 1])), /slot/);
  assert.throws(() => drawSlots(1, 33, new Set(), counterRandom([1])));
});

test("drawSlots uses the full 32-bit range for log_slots up to 32", () => {
  const got = drawSlots(1, 32, new Set(), counterRandom([0xfffffff0]));
  assert.deepEqual(got, [0xfffffff0]);
});

test("feeCheck: hard cap and a warning far above the local minimum", () => {
  assert.deepEqual(feeCheck(9_000n, 9_000n), { ok: true, warn: false });
  assert.deepEqual(feeCheck(9_000n * FEE_WARN_FACTOR + 1n, 9_000n), { ok: true, warn: true });
  assert.deepEqual(feeCheck(FEE_HARD_CAP + 1n, 9_000n), { ok: false, warn: true });
  assert.deepEqual(feeCheck(8_999n, 9_000n), { ok: false, warn: false, below: true });
  assert.ok(FEE_HARD_CAP <= 1_000_000n, "at most 1 JTM");
});

// SEC-05: the audit's RPC charged 150 000 µJTM (16.7x the 9 000 minimum)
// without any warning. Warn as soon as the fee exceeds twice the minimum.
test("feeCheck: warns above twice the minimum, refuses above the cap", () => {
  assert.equal(FEE_WARN_FACTOR, 2n);
  assert.deepEqual(feeCheck(18_000n, 9_000n), { ok: true, warn: false });
  assert.deepEqual(feeCheck(18_001n, 9_000n), { ok: true, warn: true });
  assert.deepEqual(feeCheck(150_000n, 9_000n), { ok: true, warn: true });
  assert.deepEqual(feeCheck(FEE_HARD_CAP, 9_000n), { ok: true, warn: true });
  assert.deepEqual(feeCheck(FEE_HARD_CAP + 1n, 9_000n), { ok: false, warn: true });
});

test("the worker request carries no secret and only strings for u64", () => {
  const text = sendRequestJson({
    index: 2, network: "mainnet", utxos: [{ slot_index: 1, value: "5", creation_id: "7" }],
    to: "j1x", amount: 10n, fee: 9000n, anchor: "11".repeat(32), slotHints: [4, 5], pendingOutputSlots: [9],
  });
  const o = JSON.parse(text);
  assert.deepEqual(Object.keys(o).sort(), ["amount", "epoch_anchor", "fee", "index", "network", "pending_output_slots", "slot_hints", "to", "utxos"]);
  assert.equal(o.amount, "10");
  assert.equal(o.fee, "9000");
  assert.throws(() => sendRequestJson({ index: 2, network: "mainnet", utxos: [], to: "j1x", amount: 10, fee: 9000n, anchor: "11".repeat(32), slotHints: [], pendingOutputSlots: [] }));
});

test("node refusals are named", () => {
  const m = (msg, code = -32000) => new RpcError("method", msg, { code });
  assert.deepEqual(classifySubmitError(m("method not allowed: submitTxIntent", -32601)), { kind: "not_enabled" });
  assert.deepEqual(classifySubmitError(new RpcError("http", "x", { status: 413 })), { kind: "not_enabled" });
  assert.deepEqual(classifySubmitError(m("consensus: BelowMinFee: required=12000 actual=9000")), { kind: "fee_too_low", required: 12000n });
  assert.deepEqual(classifySubmitError(m("consensus: BadEpochAnchor")), { kind: "stale_anchor" });
  assert.deepEqual(classifySubmitError(m("consensus: SlotConflict")), { kind: "slot_conflict" });
  assert.deepEqual(classifySubmitError(m("consensus: BadStateRoot")), { kind: "inputs_changed" });
  assert.deepEqual(classifySubmitError(m("already admitted: TxBodyHash(...)")), { kind: "already" });
  assert.deepEqual(classifySubmitError(m("invalid auth authorization: x")), { kind: "rejected" });
  assert.deepEqual(classifySubmitError(new RpcError("timeout", "t")), { kind: "unknown_outcome" });
  assert.deepEqual(classifySubmitError(new RpcError("network", "n")), { kind: "unknown_outcome" });
});

// SEC-02/SEC-03: "refused" only when the answer is an explicit refusal the
// wallet recognizes. Anything else after the request left may hide an
// admitted payment: the outcome is unknown, never "nothing was sent".
test("submission outcome: refused only on a recognized refusal, otherwise unknown", () => {
  const m = (msg, code = -32000) => new RpcError("method", msg, { code });
  const unknown = { kind: "unknown_outcome" };
  for (const text of [
    "consensus: BadAuthorization", "malformed intent: bad page", "tx intent too large: 9 bytes (max 1)",
    "tx intent hex decode: Odd number of digits", "tx intent: empty hex", "decode: Truncated",
    "missing auth authorization for non-coinbase transaction", "auth authorization too large: 9 bytes (max 1)",
    "invalid auth authorization: owner", "mempool full (capacity 10)", "mempool byte cap exceeded: 9 bytes (max 1)",
  ]) {
    assert.deepEqual(classifySubmitError(m(text)), { kind: "rejected" }, text);
  }
  assert.deepEqual(classifySubmitError(m("bad params", -32602)), { kind: "rejected" });
  assert.deepEqual(classifySubmitError(new RpcError("http", "x", { status: 400 })), { kind: "rejected" });
  // Unknown outcomes.
  assert.deepEqual(classifySubmitError(m("internal: storage")), unknown);
  assert.deepEqual(classifySubmitError(m("Wallet version expired, re-enter your secret")), unknown);
  for (const status of [500, 502, 503, 504]) {
    assert.deepEqual(classifySubmitError(new RpcError("http", "x", { status })), unknown, String(status));
  }
  assert.deepEqual(classifySubmitError(new RpcError("parse", "not JSON")), unknown);
  assert.deepEqual(classifySubmitError(new RpcError("too_large", "The RPC answer is too large")), unknown);
  const txid = new Error("unexpected RPC answer: the node reports a different transaction id");
  txid.name = "RpcShapeError";
  assert.deepEqual(classifySubmitError(txid), unknown);
  assert.deepEqual(classifySubmitError(new Error("boom")), unknown);
  // Not sent at all: certain.
  assert.deepEqual(classifySubmitError(new RpcError("too_large", "The request is too large to send", { sent: false })), { kind: "not_enabled" });
});

// SEC3-05: bigjson parses every JSON integer as a BigInt, so a JSON-RPC code
// is -32602n, never -32602: the code must be compared whatever its type.
test("JSON-RPC codes are compared whatever their type (BigInt from bigjson, number, string)", () => {
  const m = (code) => new RpcError("method", "x", { code });
  for (const code of [-32602n, -32602, "-32602"]) {
    assert.deepEqual(classifySubmitError(m(code)), { kind: "rejected" }, typeof code);
  }
  for (const code of [-32601n, -32601, "-32601"]) {
    assert.deepEqual(classifySubmitError(m(code)), { kind: "not_enabled" }, typeof code);
  }
  for (const code of [-32000n, 32602n, "-32602x", "", null, undefined, -32602.5, 1e400, {}, (1n << 80n)]) {
    assert.deepEqual(classifySubmitError(m(code)), { kind: "unknown_outcome" }, String(code));
  }
});

// SEC-11: a payment reviewed against one RPC is never proven or sent through
// another, nor before the new RPC's genesis was checked.
test("reviewStillHolds: same RPC and a checked genesis, or the review is void", () => {
  const plan = { rpcUrl: "https://rpc.jetsamchain.com", network: "mainnet" };
  assert.equal(reviewStillHolds(plan, { rpcUrl: "https://rpc.jetsamchain.com", network: "mainnet", genesis: "ok" }), true);
  assert.equal(reviewStillHolds(plan, { rpcUrl: "http://127.0.0.1:9", network: "mainnet", genesis: "ok" }), false);
  assert.equal(reviewStillHolds(plan, { rpcUrl: "https://rpc.jetsamchain.com", network: "mainnet", genesis: null }), false);
  assert.equal(reviewStillHolds(plan, { rpcUrl: "https://rpc.jetsamchain.com", network: "testnet", genesis: "ok" }), false);
  assert.equal(reviewStillHolds(null, { rpcUrl: "x", network: "mainnet", genesis: "ok" }), false);
});

// SEC2-01: after an explicit refusal the wallet looks the txid up itself
// (getMempoolEntry, getTx). Found: admitted, whatever the RPC said. A new proof
// only when the lookup worked and found nothing, the inputs are still listed
// live, and the refusal is one a new proof can cure; otherwise the payment
// stays held (inputs reserved) until its anchor expires.
test("afterRefusal: the RPC's refusal is checked by txid before anything else", () => {
  const absent = { mempool: false, height: null };
  const go = (kind, lookup, inputsLive, attempt = 1) => afterRefusal({ kind, lookup, inputsLive, attempt, max: 3 });
  assert.equal(go("slot_conflict", { mempool: true, height: null }, true), "admitted");
  assert.equal(go("rejected", { mempool: false, height: 1200 }, true), "admitted");
  assert.equal(go("slot_conflict", null, true), "held", "the lookup failed: no new proof");
  assert.equal(go("slot_conflict", absent, true), "reprove");
  assert.equal(go("stale_anchor", absent, true), "reprove");
  assert.equal(go("slot_conflict", absent, false), "held", "inputs no longer listed live");
  assert.equal(go("slot_conflict", absent, null), "held", "inputs not re-read");
  assert.equal(go("slot_conflict", absent, true, 3), "held", "no attempt left");
  for (const kind of ["fee_too_low", "inputs_changed", "rejected", "not_enabled"]) {
    assert.equal(go(kind, absent, true), "held", kind);
  }
});

test("reproofUtxos: a new proof may spend only the first proof's inputs", () => {
  const utxos = [
    { slot_index: 10, value: "5", creation_id: "1" },
    { slot_index: 11, value: "6", creation_id: "2" },
    { slot_index: 12, value: "7", creation_id: "3" },
  ];
  assert.deepEqual(reproofUtxos(utxos, [12, 10]).map((u) => u.slot_index), [10, 12]);
  assert.throws(() => reproofUtxos(utxos, [10, 99]), /not among/);
  assert.throws(() => reproofUtxos(utxos, []), /no input/);
});
