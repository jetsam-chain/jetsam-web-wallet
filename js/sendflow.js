// Pure parts of a send. The page wires them to the RPC and the key worker.

import { RpcError } from "./rpc.js";
import { isProvisional } from "./utxo.js";
import { resolveMintHeights } from "./mintheight.js";
import { formatJtm } from "./amount.js";

/** Never pay more than this fee, whatever the RPC says (0.5 JTM). */
export const FEE_HARD_CAP = 500_000n;
/** Warn when the fee is more than this many times the consensus minimum. */
export const FEE_WARN_FACTOR = 2n;

/**
 * Outputs of one address that a send may use: not reserved by a send this
 * browser already made, and not provisional (a block with fewer than 9
 * confirmations can still be undone, and a coinbase with it). An output whose block is not
 * known (a received output not located yet) is not spent either: its depth
 * cannot be checked.
 */
export function spendable(rows, { tip, pendingInputs }) {
  const utxos = [];
  let total = 0n;
  let provisional = 0n;
  let pending = 0n;
  let unknown = 0n;
  for (const r of rows) {
    if (pendingInputs.has(r.slot)) { pending += r.value; continue; }
    if (r.height === null || r.height === undefined) { unknown += r.value; continue; }
    if (isProvisional(r.height, tip)) { provisional += r.value; continue; }
    total += r.value;
    utxos.push({ slot_index: r.slot, value: r.value.toString(), creation_id: r.creationId.toString() });
  }
  return { utxos, total, provisional, pending, unknown };
}

/**
 * Give the received outputs among `rows` their block height (in place), so
 * that `spendable` can hold back the provisional ones. A height in `cache`
 * (creation_id string -> height) is used only when it is final at `tip`: a
 * reorganisation cannot move it any more. The others are looked up in the
 * headers (`allocAt`, mintheight.js). An output that cannot be located keeps
 * no height, and is not spent.
 */
export async function locateReceived(rows, tip, { cache, allocAt }) {
  const ids = [];
  for (const r of rows) {
    if (r.coinbase || r.height !== null) continue;
    const h = cache.get(r.creationId.toString());
    if (Number.isSafeInteger(h) && h >= 0 && h <= tip && !isProvisional(h, tip)) r.height = h;
    else ids.push(r.creationId);
  }
  if (!ids.length) return;
  const found = await resolveMintHeights(ids, tip, allocAt);
  for (const r of rows) {
    if (r.coinbase || r.height !== null) continue;
    const h = found.get(r.creationId);
    if (h !== null && h !== undefined) r.height = h;
  }
}

/**
 * The payment does not fit in what is spendable now: say how much is, and
 * what is held back and why. `need` (micro-JTM) comes from the planner, or
 * null when it did not say.
 */
export function fundsMessage(t, need, sp) {
  const amount = (v) => formatJtm(v, { trim: true });
  const parts = [t("send.err.funds", { need: need === null ? "?" : amount(need), have: amount(sp.total) })];
  if (sp.provisional > 0n) parts.push(t("send.err.funds_provisional", { amount: amount(sp.provisional) }));
  if (sp.pending > 0n) parts.push(t("send.err.funds_pending", { amount: amount(sp.pending) }));
  if (sp.unknown > 0n) parts.push(t("send.err.funds_unknown", { amount: amount(sp.unknown) }));
  return parts.join(" ");
}

/**
 * `count` distinct output slots in [0, 2^logSlots) not in `avoid`, drawn
 * from `random` (crypto.getRandomValues). Used only when the RPC offers no
 * slot hints; a slot that turns out to be occupied makes the node refuse the
 * send, and the wallet proves again with new slots.
 */
export function drawSlots(count, logSlots, avoid, random) {
  if (!Number.isInteger(logSlots) || logSlots < 1 || logSlots > 32) throw new Error("bad log_slots");
  const space = 2 ** logSlots;
  if (space - avoid.size < count) throw new Error("no free output slot to draw");
  const out = [];
  for (let rounds = 0; rounds < 1000 && out.length < count; rounds++) {
    const buf = random(new Uint32Array(count));
    for (const v of buf) {
      const s = v % space; // space is a power of two: no bias
      if (!avoid.has(s) && !out.includes(s) && out.length < count) out.push(s);
    }
  }
  if (out.length < count) throw new Error("could not draw an output slot");
  return out;
}

/** The fee is computed from RPC data: refuse absurd ones, flag high ones. */
export function feeCheck(fee, minimum) {
  if (fee < minimum) return { ok: false, warn: false, below: true };
  if (fee > FEE_HARD_CAP) return { ok: false, warn: true };
  return { ok: true, warn: fee > minimum * FEE_WARN_FACTOR };
}

/**
 * A reviewed payment may be proven and sent only through the RPC it was
 * reviewed against, on the same network, once that RPC's genesis is checked
 * (SEC-11). `state`: { rpcUrl, network, genesis }.
 */
export function reviewStillHolds(plan, state) {
  return Boolean(plan) && plan.rpcUrl === state.rpcUrl && plan.network === state.network && state.genesis === "ok";
}

/** The request the key worker proves. No secret: the worker holds it. */
export function sendRequestJson({ index, network, utxos, to, amount, fee, anchor, slotHints, pendingOutputSlots }) {
  if (typeof amount !== "bigint" || typeof fee !== "bigint") throw new TypeError("amount and fee must be BigInt");
  return JSON.stringify({
    index,
    network,
    utxos,
    to,
    amount: amount.toString(),
    fee: fee.toString(),
    epoch_anchor: anchor,
    slot_hints: slotHints,
    pending_output_slots: pendingOutputSlots,
  });
}

// The node's own refusals of an intent (jetsam_mempool errors and the RPC's
// decoding of the request): explicit, so certainly not admitted.
const NODE_REFUSALS = /^(consensus: |malformed intent: |tx intent[: ]|decode: |missing auth authorization|auth authorization too large|invalid auth authorization: |mempool full|mempool byte cap exceeded)/;

/**
 * A JSON-RPC error code as a BigInt, or null. bigjson parses every integer as
 * a BigInt (SEC3-05: `-32602n === -32602` is false); a number or a decimal
 * string is accepted too.
 */
function codeOf(c) {
  if (typeof c === "bigint") return c;
  if (typeof c === "number" && Number.isSafeInteger(c)) return BigInt(c);
  if (typeof c === "string" && /^-?[0-9]{1,10}$/.test(c)) return BigInt(c);
  return null;
}

/**
 * What a refused (or unanswered) submitTxIntent means.
 * kind: not_enabled | fee_too_low | stale_anchor | slot_conflict |
 * inputs_changed | already | rejected | unknown_outcome
 *
 * Only an explicit refusal the wallet recognizes means "not sent". Once the
 * request has left, anything else (no answer, an HTTP 5xx from a proxy, an
 * unreadable answer, a different txid, an unrecognized error) may hide an
 * admitted payment: unknown_outcome (SEC-02, SEC-03).
 */
export function classifySubmitError(e) {
  if (e instanceof RpcError) {
    if (e.kind === "http" && (e.status === 413 || e.status === 405 || e.status === 403)) return { kind: "not_enabled" };
    if (e.kind === "too_large" && e.sent === false) return { kind: "not_enabled" };
    if (e.kind === "http" && e.status >= 400 && e.status < 500) return { kind: "rejected" };
    if (e.kind === "method") {
      const m = String(e.message);
      const code = codeOf(e.code);
      if (code === -32601n || /method not (allowed|found)/i.test(m)) return { kind: "not_enabled" };
      const fee = /BelowMinFee: required=(\d{1,20}) actual=\d+/.exec(m);
      if (fee) return { kind: "fee_too_low", required: BigInt(fee[1]) };
      if (/BadEpochAnchor/.test(m)) return { kind: "stale_anchor" };
      if (/SlotConflict/.test(m)) return { kind: "slot_conflict" };
      if (/BadStateRoot/.test(m)) return { kind: "inputs_changed" };
      if (/^already admitted/i.test(m)) return { kind: "already" };
      if (code === -32602n || NODE_REFUSALS.test(m)) return { kind: "rejected" };
    }
  }
  return { kind: "unknown_outcome" };
}

/**
 * What to do after the RPC explicitly refused a submitted intent (SEC2-01).
 * The refusal is the RPC's word, so the wallet has looked the txid it
 * computed itself up: `lookup` is { mempool, height } from getMempoolEntry and
 * getTx, or null when that lookup failed. `inputsLive`: the first proof's
 * inputs are all still listed by getSlotsByOwner (null: not read).
 *
 * admitted: the payment is there, whatever the RPC said.
 * reprove: nothing found, inputs still live, and the refusal is one a new
 *   proof can cure (slot taken, anchor moved). The new proof spends only the
 *   first proof's inputs (reproofUtxos), so at most one of them can ever be
 *   accepted.
 * held: anything else. The payment stays recorded with its inputs reserved
 *   until its anchor has expired; nothing is said to be "not sent".
 */
export function afterRefusal({ kind, lookup, inputsLive, attempt, max }) {
  if (lookup && (lookup.mempool || (lookup.height !== null && lookup.height !== undefined))) return "admitted";
  if (!lookup || inputsLive !== true || attempt >= max) return "held";
  return kind === "slot_conflict" || kind === "stale_anchor" ? "reprove" : "held";
}

/**
 * The outputs a new proof of a refused payment may spend: exactly the ones the
 * first proof spent. Two intents sharing an input can never both be accepted,
 * so proving again cannot pay twice even if the first one was admitted.
 */
export function reproofUtxos(utxos, inputSlots) {
  if (!inputSlots.length) throw new Error("no input to prove again with");
  const want = new Set(inputSlots);
  const out = utxos.filter((u) => want.has(u.slot_index));
  if (out.length !== want.size) throw new Error("an input of the first proof is not among the reviewed outputs");
  return out;
}
