// Sends made from this browser. Their inputs stay reserved (the wallet will
// not try to spend them again) until the send is final, or until its anchor
// can no longer be accepted and it is known to be dropped.
//
// A send is recorded *before* it is submitted, as "unknown": if the tab is
// closed, the answer lost or unreadable, the inputs stay reserved and the
// wallet asks the RPC about the txid it computed itself until the doubt is
// lifted (in the mempool, on the chain, or expired).
//
// An explicit refusal is only what the RPC says (SEC2-01): a lying RPC can
// admit a payment and answer "refused". So a refused send is kept, its inputs
// stay reserved, and it is tracked like an unknown one; if it shows up in the
// mempool or on the chain anyway, it is marked `contradicted: "refused"`.

import { isProvisional } from "./utxo.js";
import { TX_EPOCH_BLOCKS } from "./epoch.js";

/** A send dies at anchor + 2 * TX_EPOCH_BLOCKS + 1 (two accepted anchors). */
export const EXPIRY_BLOCKS = 2 * TX_EPOCH_BLOCKS + 1;

const STATUSES = new Set(["unknown", "refused", "submitted", "mempool", "confirmed", "final", "dropped"]);
const TXID_RE = /^[0-9a-f]{64}$/;
const isSlot = (v) => Number.isInteger(v) && v >= 0 && v < 2 ** 32;
const isHeight = (v) => Number.isSafeInteger(v) && v >= 0;

function clean(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.txid !== "string" || !TXID_RE.test(e.txid)) return null;
  if (!Array.isArray(e.inputs) || !e.inputs.every(isSlot)) return null;
  if (!Array.isArray(e.outputs) || !e.outputs.every(isSlot)) return null;
  if (!isHeight(e.anchorHeight) || !Number.isInteger(e.fromIndex) || e.fromIndex < 0) return null;
  let amount, fee;
  try {
    amount = BigInt(e.amount);
    fee = BigInt(e.fee);
  } catch (_) {
    return null;
  }
  if (amount <= 0n || fee < 0n) return null;
  return {
    txid: e.txid,
    fromIndex: e.fromIndex,
    to: typeof e.to === "string" ? e.to.slice(0, 100) : "",
    amount,
    fee,
    inputs: e.inputs.slice(),
    outputs: e.outputs.slice(),
    anchorHeight: e.anchorHeight,
    submittedAt: Number.isSafeInteger(e.submittedAt) ? e.submittedAt : 0,
    status: STATUSES.has(e.status) ? e.status : "submitted",
    height: isHeight(e.height) ? e.height : null,
    // What the RPC said that the chain later proved false: "refused" | null.
    contradicted: e.contradicted === "refused" ? e.contradicted : null,
  };
}

export function createPendingBook(saved = []) {
  const entries = [];
  for (const raw of Array.isArray(saved) ? saved : []) {
    const e = clean(raw);
    if (e && !entries.some((x) => x.txid === e.txid)) entries.push(e);
  }
  const holding = (e) => e.status === "unknown" || e.status === "refused" || e.status === "submitted" || e.status === "mempool" || e.status === "confirmed";
  return {
    /** Record a send about to be submitted: outcome unknown until answered. */
    add(entry) {
      const e = clean({ ...entry, amount: String(entry.amount), fee: String(entry.fee), status: "unknown", height: null });
      if (!e) throw new Error("bad pending entry");
      if (!entries.some((x) => x.txid === e.txid)) entries.push(e);
    },
    /** The node answered with this very txid. */
    admitted(txid) {
      const e = entries.find((x) => x.txid === txid);
      if (e && e.status === "unknown") e.status = "submitted";
    },
    /**
     * The RPC answered with an explicit refusal. That is its word, not a
     * proof (SEC2-01): the entry stays, inputs reserved, tracked by txid.
     */
    refused(txid) {
      const e = entries.find((x) => x.txid === txid);
      if (e && e.status === "unknown") e.status = "refused";
    },
    /** The intent never left this browser (recording it failed first). */
    remove(txid) {
      const k = entries.findIndex((x) => x.txid === txid);
      if (k >= 0) entries.splice(k, 1);
    },
    /** Facts from the RPC: in mempool?, confirmed height (or null), tip. */
    update(txid, { mempool, height, tip }) {
      const e = entries.find((x) => x.txid === txid);
      if (!e || e.status === "final" || e.status === "dropped") return;
      const seen = (height !== null && height !== undefined) || mempool;
      if (seen && e.status === "refused") e.contradicted = "refused";
      if (height !== null && height !== undefined) {
        e.height = height;
        e.status = isProvisional(height, tip) ? "confirmed" : "final";
      } else if (mempool) {
        e.height = null;
        e.status = "mempool";
      } else {
        e.height = null;
        const waiting = e.status === "unknown" || e.status === "refused" ? e.status : "submitted";
        e.status = tip >= e.anchorHeight + EXPIRY_BLOCKS ? "dropped" : waiting;
      }
    },
    reservedInputs() {
      return new Set(entries.filter(holding).flatMap((e) => e.inputs));
    },
    reservedOutputs() {
      return new Set(entries.filter(holding).flatMap((e) => e.outputs));
    },
    list() {
      return entries.map((e) => ({ ...e, inputs: e.inputs.slice(), outputs: e.outputs.slice() }));
    },
    open() {
      return this.list().filter(holding);
    },
    toJSON() {
      return entries.map((e) => ({ ...e, amount: e.amount.toString(), fee: e.fee.toString() }));
    },
  };
}
