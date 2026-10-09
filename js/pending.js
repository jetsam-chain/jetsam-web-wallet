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
//
// Proofs of one payment share inputs: once one of them is final, the others
// held can never be accepted and are marked `superseded` (SEC3-04).
//
// Hiding a mined payment costs an RPC nothing and passes all of the above
// (SEC3-01). So when the configured RPC is not the network's public one, an
// expiry is believed only if the public RPC, asked about the txid alone, does
// not see the payment either and is past the expiry height (`reference`).
// If it sees the payment, or cannot be reached, or is behind, the payment
// stays held (`crossCheck`: "seen" | "unconfirmed"). An expiry decided by one
// RPC alone (the public one, or the check turned off) is noted `checked:
// "alone"`; one the public RPC agreed with, `checked: "public"`.
//
// "Final" is the RPC's word as well (SEC3-02): it takes two reads at least
// FINAL_CONFIRM_MS apart, both FINALITY_DEPTH deep, with the block checked by
// the caller (`finalBlock`), and it is not terminal: a final payment is still
// looked up for RECHECK_BLOCKS; seen shallower it is only confirmed again,
// and gone it is waiting again (`contradicted: "final"`).

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
/** Tracking rounds without the block at the expiry height before the page says so (SEC3-03). */
export const NO_BLOCK_ROUNDS = 8;
/** Two reads showing a payment final must be at least this far apart (SEC3-02). */
export const FINAL_CONFIRM_MS = 60_000;

const STATUSES = new Set(["unknown", "refused", "submitted", "mempool", "confirmed", "final", "dropped", "superseded"]);
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
    // What the RPC said that it later contradicted: "refused" | "expired" | "final" | null.
    contradicted: ["refused", "expired", "final"].includes(e.contradicted) ? e.contradicted : null,
    // The public RPC sees it while the configured one does not, or could not
    // confirm a reported expiry (SEC3-01): "seen" | "unconfirmed" | null.
    crossCheck: e.crossCheck === "seen" || e.crossCheck === "unconfirmed" ? e.crossCheck : null,
    // How an expiry was decided (SEC3-01): "public" (cross-checked) | "alone" | null.
    checked: e.checked === "public" || e.checked === "alone" ? e.checked : null,
    // First read showing it final (SEC3-02): { height, tip, at } or null.
    deep: e.deep && isHeight(e.deep.height) && isHeight(e.deep.tip) && Number.isSafeInteger(e.deep.at) ? { height: e.deep.height, tip: e.deep.tip, at: e.deep.at } : null,
    // Rounds in a row where the tip was past the expiry height without the
    // block at that height served (SEC3-03).
    noBlock: Number.isSafeInteger(e.noBlock) && e.noBlock > 0 ? Math.min(e.noBlock, 1_000_000) : 0,
    // "superseded": another proof spending one of its inputs is final (SEC3-04).
    supersededBy: typeof e.supersededBy === "string" && TXID_RE.test(e.supersededBy) ? e.supersededBy : null,
  };
}

/**
 * What to say about a payment's held inputs (SEC3-03), or null:
 * { kind: "no_block", height } when the RPC has not served the block at the
 * expiry height for NO_BLOCK_ROUNDS rounds (switching RPC settles it);
 * { kind: "until", height, blocks } for a refused or unknown payment before
 * its anchor expires (an honest refusal holds them that long too).
 */
export function holdInfo(e, tip) {
  const height = e.anchorHeight + EXPIRY_BLOCKS;
  if (e.noBlock >= NO_BLOCK_ROUNDS) return { kind: "no_block", height };
  if ((e.status === "refused" || e.status === "unknown") && Number.isSafeInteger(tip) && tip < height) {
    return { kind: "until", height, blocks: height - tip };
  }
  return null;
}

export function createPendingBook(saved = []) {
  const entries = [];
  for (const raw of Array.isArray(saved) ? saved : []) {
    const e = clean(raw);
    if (e && !entries.some((x) => x.txid === e.txid)) entries.push(e);
  }
  const holding = (e) => e.status === "unknown" || e.status === "refused" || e.status === "submitted" || e.status === "mempool" || e.status === "confirmed";
  let lastTip = null; // the tip of the last update (memory only)
  const watched = (e) => {
    if (e.status === "final") return e.height !== null && (lastTip === null || lastTip < e.height + RECHECK_BLOCKS);
    return (e.status === "dropped" || e.status === "superseded") && (lastTip === null || lastTip < e.anchorHeight + EXPIRY_BLOCKS + RECHECK_BLOCKS);
  };

  /**
   * Keep at most MAX_FINISHED finished entries, dropping the oldest (SEC2-08).
   * A final one may go while still looked up: its inputs are spent by its own
   * transaction, so forgetting it cannot pay twice.
   */
  function prune() {
    const finished = entries.filter((e) => !holding(e) && (e.status === "final" || !watched(e)));
    for (const e of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) entries.splice(entries.indexOf(e), 1);
  }

  /**
   * `e` is final: a proof sharing an input with it can never be accepted, so
   * one still held is superseded, not "refused: checking…" (SEC3-04). It is
   * still looked up like a dropped one, and seen wins as always.
   */
  function supersede(e) {
    const spent = new Set(e.inputs);
    for (const x of entries) {
      if (x === e || !(x.status === "refused" || x.status === "unknown" || x.status === "submitted")) continue;
      if (!x.inputs.some((i) => spent.has(i))) continue;
      x.status = "superseded";
      x.supersededBy = e.txid;
      x.expiring = false;
      x.expiry = null;
      x.noBlock = 0;
    }
  }

  /** `e` is no longer final: the proofs it had superseded are held again. */
  function unsupersede(e) {
    for (const x of entries) {
      if (x.status === "superseded" && x.supersededBy === e.txid) {
        x.status = "unknown";
        x.supersededBy = null;
      }
    }
  }

  /**
   * Is `e` final at (height, tip, now)? Two reads at least FINAL_CONFIRM_MS
   * apart at the same height, both deep enough, the block checked by the
   * caller each time (SEC3-02). Updates e.deep.
   */
  function finalHolds(e, height, tip, now, finalBlock, reference) {
    const prev = e.deep;
    // The public RPC, when it answers, must have it in a block too (SEC3-01).
    const refMisses = reference !== null && typeof reference === "object" && !isHeight(reference.height);
    if (!finalBlock || refMisses) {
      e.deep = null;
      return false;
    }
    if (!prev || prev.height !== height || tip < prev.tip || now < prev.at) {
      e.deep = { height, tip, at: now };
      return false;
    }
    return now - prev.at >= FINAL_CONFIRM_MS;
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
     * anchorHeight + EXPIRY_BLOCKS) are used to weigh a reported expiry;
     * `finalBlock` (the block of the transaction is the one served at its
     * height, and the block FINALITY_DEPTH above is served) to weigh "final".
     */
    update(txid, { mempool, height, tip, now = Date.now(), expiryBlock = false, finalBlock = false, reference = null }) {
      const e = entries.find((x) => x.txid === txid);
      if (Number.isSafeInteger(tip)) lastTip = tip;
      if (!e) return;
      const was = e.status;
      const onChain = height !== null && height !== undefined;
      const seen = onChain || mempool;
      if (seen) {
        if (e.status === "refused") e.contradicted = "refused";
        if (e.status === "dropped") e.contradicted = "expired";
        e.expiry = null;
        e.expiring = false;
        e.noBlock = 0;
        e.crossCheck = null;
      }
      if (onChain) {
        const sameBlock = e.height === height;
        e.height = height;
        if (isProvisional(height, tip)) {
          e.deep = null;
          e.status = "confirmed";
        } else if (was === "final" && sameBlock) {
          e.status = "final"; // still there, still deep
        } else if (finalHolds(e, height, tip, now, finalBlock, reference)) {
          e.deep = null;
          e.status = "final";
          supersede(e);
        } else {
          e.status = "confirmed";
        }
      } else if (mempool) {
        e.height = null;
        e.deep = null;
        e.status = "mempool";
      } else if (e.status !== "dropped" && e.status !== "superseded") {
        e.height = null;
        e.deep = null;
        const waiting = e.status === "unknown" || e.status === "refused" ? e.status : "submitted";
        const expiryAt = e.anchorHeight + EXPIRY_BLOCKS;
        e.expiring = tip >= expiryAt;
        e.noBlock = e.expiring && !expiryBlock ? Math.min(e.noBlock + 1, 1_000_000) : 0;
        const answered = reference !== null && typeof reference === "object";
        if (answered && (reference.mempool === true || isHeight(reference.height))) {
          // The public RPC sees it: whatever this RPC says, it may be mined.
          e.crossCheck = "seen";
          e.expiry = null;
          e.status = waiting;
        } else if (!e.expiring) {
          e.expiry = null;
          if (reference !== "skipped") e.crossCheck = null;
          e.status = waiting;
        } else if (expiryHolds(e, tip, now, expiryBlock)) {
          if (reference === null || (answered && isHeight(reference.tip) && reference.tip >= expiryAt)) {
            e.status = "dropped";
            e.expiring = false;
            e.crossCheck = null;
            e.checked = reference === null ? "alone" : "public";
          } else {
            // Consistent on this RPC, but not confirmed by the public one
            // (unreachable, behind, or not asked this round): held.
            if (reference !== "skipped") e.crossCheck = "unconfirmed";
            e.status = waiting;
          }
        } else {
          if (answered) e.crossCheck = null;
          e.status = waiting;
        }
      }
      if (was === "final" && e.status !== "final") {
        // Final no more: seen shallower, or gone (a reorganisation, or a lie
        // either time). The proofs it had superseded are held again.
        if (!onChain) e.contradicted = "final";
        unsupersede(e);
      }
      prune();
    },
    /**
     * Payments to `to` of about `amount` (within 10 %) that may still be
     * mined although nothing confirms it: refused, unknown, expired within
     * the last RECHECK_BLOCKS, or whose expiry is in doubt (SEC3-01). Paying
     * that recipient again can pay twice.
     */
    earlierTo(to, amount) {
      const a = BigInt(amount);
      const near = (x) => (x > a ? x - a : a - x) * 10n <= (x > a ? x : a);
      const doubtful = (e) => e.status === "refused" || e.status === "unknown" || e.expiring || e.crossCheck !== null || (e.status === "dropped" && watched(e));
      return this.list().filter((e) => e.to === to && near(e.amount, a) && doubtful(e));
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
