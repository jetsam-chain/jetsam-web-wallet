// Sends made from this browser. Their inputs stay reserved (the wallet will
// not try to spend them again) until the send is final, or until its anchor
// can no longer be accepted and it is believed dropped.
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
//
// The expiry, too, is the RPC's word: its tip (blockCount) can be inflated
// while it hides the mempool (SEC2-02). An expiry is believed only when it is
// consistent: the RPC serves the block at the expiry height, two reads at
// least EXPIRY_CONFIRM_MS apart agree, the tip never moved faster than one
// block per MIN_BLOCK_MS between them, and enough wall-clock time has passed
// since the submission for the chain to reach that height at that pace.
// Until then the entry shows the doubt (`expiring`: "may still be mined")
// and keeps its inputs. Even then "dropped" is not final: the txid is still
// looked up for RECHECK_BLOCKS, and a send found later is put back
// (`contradicted: "expired"`).

import { isProvisional } from "./utxo.js";
import { TX_EPOCH_BLOCKS } from "./epoch.js";

/** A send dies at anchor + 2 * TX_EPOCH_BLOCKS + 1 (two accepted anchors). */
export const EXPIRY_BLOCKS = 2 * TX_EPOCH_BLOCKS + 1;
/** A send reported expired is still looked up for this many blocks (about a day). */
export const RECHECK_BLOCKS = 1440;
/** Two reads showing the expiry must be at least this far apart. */
export const EXPIRY_CONFIRM_MS = 60_000;
/** Faster than this per block is not believed (the chain targets 60 s). */
export const MIN_BLOCK_MS = 15_000;
/** Finished entries kept (oldest dropped first); held ones are never dropped. */
export const MAX_FINISHED = 100;
/** Payments in flight at once; one more is refused before it is proven. */
export const MAX_OPEN = 50;

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
    // Tip when it was submitted (null for records written before SEC2-02).
    submitTip: isHeight(e.submitTip) ? e.submitTip : null,
    // The RPC's tip says the anchor expired, not believed yet ("may still be mined").
    expiring: e.expiring === true,
    // First consistent read reporting the anchor expired: { tip, at } or null.
    expiry: e.expiry && isHeight(e.expiry.tip) && Number.isSafeInteger(e.expiry.at) ? { tip: e.expiry.tip, at: e.expiry.at } : null,
    // What the RPC said that the chain later proved false: "refused" | "expired" | null.
    contradicted: e.contradicted === "refused" || e.contradicted === "expired" ? e.contradicted : null,
  };
}

export function createPendingBook(saved = []) {
  const entries = [];
  for (const raw of Array.isArray(saved) ? saved : []) {
    const e = clean(raw);
    if (e && !entries.some((x) => x.txid === e.txid)) entries.push(e);
  }
  const holding = (e) => e.status === "unknown" || e.status === "refused" || e.status === "submitted" || e.status === "mempool" || e.status === "confirmed";
  let lastTip = null; // the tip of the last update (memory only)
  const watched = (e) => e.status === "dropped" && (lastTip === null || lastTip < e.anchorHeight + EXPIRY_BLOCKS + RECHECK_BLOCKS);

  /** Keep at most MAX_FINISHED finished entries, dropping the oldest (SEC2-08). */
  function prune() {
    const finished = entries.filter((e) => !holding(e) && !watched(e));
    for (const e of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) entries.splice(entries.indexOf(e), 1);
  }

  /** Is the expiry reported at (tip, now) believable for e? Updates e.expiry. */
  function expiryHolds(e, tip, now, expiryBlock) {
    const prev = e.expiry;
    if (!expiryBlock) {
      e.expiry = null; // no block at that height: not even a first read
      return false;
    }
    if (!prev || tip < prev.tip || tip - prev.tip > Math.floor((now - prev.at) / MIN_BLOCK_MS) + 1) {
      e.expiry = { tip, at: now }; // first read, or inconsistent with the previous one: start over
      return false;
    }
    if (now - prev.at < EXPIRY_CONFIRM_MS) return false;
    const from = e.submitTip !== null ? e.submitTip : e.anchorHeight;
    const blocks = Math.max(0, e.anchorHeight + EXPIRY_BLOCKS - from);
    return now - e.submittedAt >= blocks * MIN_BLOCK_MS;
  }
  return {
    /** Record a send about to be submitted: outcome unknown until answered. */
    add(entry) {
      const e = clean({ ...entry, amount: String(entry.amount), fee: String(entry.fee), status: "unknown", height: null });
      if (!e) throw new Error("bad pending entry");
      if (entries.some((x) => x.txid === e.txid)) return;
      if (this.full()) throw new Error("too many payments in flight");
      entries.push(e);
      prune();
    },
    /** MAX_OPEN payments in flight: no new one until one is settled (SEC2-08). */
    full() {
      return entries.filter(holding).length >= MAX_OPEN;
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
    /**
     * Facts from the RPC: in mempool?, confirmed height (or null), tip; `now`
     * (wall clock, ms) and `expiryBlock` (the RPC returned a block at
     * anchorHeight + EXPIRY_BLOCKS) are used to weigh a reported expiry.
     */
    update(txid, { mempool, height, tip, now = Date.now(), expiryBlock = false }) {
      const e = entries.find((x) => x.txid === txid);
      if (Number.isSafeInteger(tip)) lastTip = tip;
      if (!e || e.status === "final") return;
      const seen = (height !== null && height !== undefined) || mempool;
      if (seen) {
        if (e.status === "refused") e.contradicted = "refused";
        if (e.status === "dropped") e.contradicted = "expired";
        e.expiry = null;
        e.expiring = false;
      }
      if (height !== null && height !== undefined) {
        e.height = height;
        e.status = isProvisional(height, tip) ? "confirmed" : "final";
      } else if (mempool) {
        e.height = null;
        e.status = "mempool";
      } else if (e.status !== "dropped") {
        e.height = null;
        const waiting = e.status === "unknown" || e.status === "refused" ? e.status : "submitted";
        e.expiring = tip >= e.anchorHeight + EXPIRY_BLOCKS;
        if (!e.expiring) {
          e.expiry = null;
          e.status = waiting;
        } else if (expiryHolds(e, tip, now, expiryBlock)) {
          e.status = "dropped";
          e.expiring = false;
        } else {
          e.status = waiting;
        }
      }
      prune();
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
    /** What tracking looks up: the open sends and the recently dropped ones. */
    tracked() {
      return this.list().filter((e) => holding(e) || watched(e));
    },
    toJSON() {
      return entries.map((e) => ({ ...e, amount: e.amount.toString(), fee: e.fee.toString() }));
    },
  };
}
