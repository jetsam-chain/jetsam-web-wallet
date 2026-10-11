// Live outputs of an address, as returned by getSlotsByOwner, made safe to use.

import { sumMicro } from "./amount.js";

/** params.rs COINBASE_CREATION_TAG: a coinbase output's creation_id is TAG | height. */
export const COINBASE_TAG = 1n << 63n;
/** params.rs CONSENSUS_FINALITY_DEPTH. */
export const FINALITY_DEPTH = 8;

const isBig = (v) => typeof v === "bigint";

function toSafeNumber(v, what) {
  if (!isBig(v) || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("bad " + what);
  return Number(v);
}

/**
 * Validate the raw rows (parsed by bigjson, so integers are BigInt) and keep
 * what the wallet needs. Every row must belong to `owner`; a row that does not
 * means the RPC answered something else, and nothing from it is shown.
 *
 * Coinbase rows get their height decoded here from the exact creation_id. The
 * public proxy also adds `creation_height`; when present it must agree.
 * Received rows carry the chain-wide allocation counter instead, and get their
 * height later (mintheight.js).
 */
export function normalizeSlots(raw, owner) {
  if (!Array.isArray(raw)) throw new Error("expected a list of outputs");
  // A slot holds one output: a slot listed twice means the answer is wrong
  // (it would count twice in the balance and be spent twice), so nothing
  // from it is used (SEC-07).
  const seen = new Set();
  return raw.map((r) => {
    if (!r || typeof r !== "object") throw new Error("bad output row");
    if (r.owner !== owner) throw new Error("output owner does not match the address");
    if (r.empty !== false) throw new Error("empty slot in the output list");
    if (!isBig(r.value) || r.value <= 0n) throw new Error("bad output value");
    if (!isBig(r.creation_id) || r.creation_id < 0n || r.creation_id >= 1n << 64n) throw new Error("bad creation_id");
    const slot = toSafeNumber(r.slot_index, "slot_index");
    if (seen.has(slot)) throw new Error("slot " + slot + " listed twice in the output list");
    seen.add(slot);
    const coinbase = (r.creation_id & COINBASE_TAG) !== 0n;
    const height = coinbase ? toSafeNumber(r.creation_id & ~COINBASE_TAG, "coinbase height") : null;
    if (r.creation_height !== undefined && r.creation_height !== null) {
      if (!coinbase || r.creation_height !== BigInt(height)) {
        throw new Error("creation_height from the RPC disagrees with creation_id");
      }
    }
    return { slot, value: r.value, creationId: r.creation_id, coinbase, height };
  });
}

/** Blocks on top of and including the output's block. */
export function confirmations(tip, height) {
  if (height === null || height === undefined) return null;
  return Math.max(0, tip - height + 1);
}

/** Mirrors consensus/header.rs `is_final`: final once tip >= height + FINALITY_DEPTH. */
export function isProvisional(height, tip) {
  if (height === null || height === undefined) return false;
  return tip < height + FINALITY_DEPTH;
}

/**
 * The rows behind the total at the top, from the address entries
 * ({ status, rows, known }). An address read before and being read again
 * counts with its last read, so a refresh does not drop the total to 0; one
 * never read (`known` false) adds nothing. Both count in `reading`. An
 * address whose last read failed counts in `failed` only.
 */
export function heroRows(entries) {
  const rows = [];
  let failed = 0;
  let reading = 0;
  for (const e of entries) {
    if (e.status === "ok") rows.push(...e.rows);
    else if (e.status === "error") failed++;
    else {
      reading++;
      if (e.status === "loading" && e.known === true) rows.push(...e.rows);
    }
  }
  return { rows, failed, reading };
}

export function summarize(rows, tip) {
  return {
    total: sumMicro(rows.map((r) => r.value)),
    provisional: sumMicro(rows.filter((r) => isProvisional(r.height, tip)).map((r) => r.value)),
    count: rows.length,
    coinbaseCount: rows.filter((r) => r.coinbase).length,
  };
}
