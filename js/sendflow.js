// Pure parts of a send. The page wires them to the RPC and the key worker.

import { RpcError } from "./rpc.js";
import { isProvisional } from "./utxo.js";

/** Never pay more than this fee, whatever the RPC says (0.5 JTM). */
export const FEE_HARD_CAP = 500_000n;
/** Warn when the fee is this many times the consensus minimum or more. */
export const FEE_WARN_FACTOR = 20n;

/**
 * Outputs of one address that a send may use: not reserved by a send this
 * browser already made, and not provisional (a block fewer than 8 deep can
 * still be undone, and a coinbase with it). Received outputs whose block is
 * not known yet count as spendable: the node checks they are live.
 */
export function spendable(rows, { tip, pendingInputs }) {
  const utxos = [];
  let total = 0n;
  let provisional = 0n;
  let pending = 0n;
  for (const r of rows) {
    if (pendingInputs.has(r.slot)) { pending += r.value; continue; }
    if (r.height !== null && isProvisional(r.height, tip)) { provisional += r.value; continue; }
    total += r.value;
    utxos.push({ slot_index: r.slot, value: r.value.toString(), creation_id: r.creationId.toString() });
  }
  return { utxos, total, provisional, pending };
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
  return { ok: true, warn: fee >= minimum * FEE_WARN_FACTOR };
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

/**
 * What a refused (or unanswered) submitTxIntent means.
 * kind: not_enabled | fee_too_low | stale_anchor | slot_conflict |
 * inputs_changed | already | unknown_outcome | rejected
 */
export function classifySubmitError(e) {
  if (e instanceof RpcError) {
    if (e.kind === "http" && (e.status === 413 || e.status === 405 || e.status === 403)) return { kind: "not_enabled" };
    if (e.kind === "too_large") return { kind: "not_enabled" };
    if (e.kind === "timeout" || e.kind === "network") return { kind: "unknown_outcome" };
    if (e.kind === "method") {
      const m = String(e.message);
      if (e.code === -32601 || /method not (allowed|found)/i.test(m)) return { kind: "not_enabled" };
      const fee = /BelowMinFee: required=(\d{1,20}) actual=\d+/.exec(m);
      if (fee) return { kind: "fee_too_low", required: BigInt(fee[1]) };
      if (/BadEpochAnchor/.test(m)) return { kind: "stale_anchor" };
      if (/SlotConflict/.test(m)) return { kind: "slot_conflict" };
      if (/BadStateRoot/.test(m)) return { kind: "inputs_changed" };
      if (/already admitted/i.test(m)) return { kind: "already" };
    }
  }
  return { kind: "rejected" };
}
