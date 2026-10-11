// RPC answers are hostile until checked. Values come from bigjson: integers
// are BigInt. Each checker returns plain, typed values or throws.

const isBigInt = (v) => typeof v === "bigint";
const U64_MAX = (1n << 64n) - 1n;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

function shapeError(what) {
  const e = new Error("unexpected RPC answer: " + what);
  e.name = "RpcShapeError";
  return e;
}

function safeInt(v, what) {
  if (!isBigInt(v) || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw shapeError(what);
  return Number(v);
}

function obj(v, what) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw shapeError(what);
  return v;
}

function hex64(v, what) {
  if (typeof v !== "string" || !HEX64_RE.test(v)) throw shapeError(what);
  return v.toLowerCase();
}

export function checkChainInfo(v) {
  obj(v, "getChainInfo");
  const height = safeInt(v.height, "height");
  if (!isBigInt(v.log_slots) || v.log_slots < 1n || v.log_slots > 32n) throw shapeError("log_slots");
  const logSlots = Number(v.log_slots);
  if (!isBigInt(v.active_slot_count) || v.active_slot_count < 0n || v.active_slot_count > 1n << BigInt(logSlots)) {
    throw shapeError("active_slot_count");
  }
  return { height, activeSlotCount: v.active_slot_count, logSlots };
}

export function checkBlockCount(v) {
  return safeInt(v, "blockCount");
}

export function checkAnchor(v) {
  const a = hex64(v, "epoch anchor");
  if (/^0+$/.test(a)) throw shapeError("zero epoch anchor");
  return a;
}

/** A fee in micro-JTM: positive, at most u64. */
export function checkFee(v) {
  if (!isBigInt(v) || v <= 0n || v > U64_MAX) throw shapeError("fee");
  return v;
}

export function checkSlotHints(v, count, logSlots) {
  if (!Array.isArray(v) || v.length > count) throw shapeError("slot hints");
  const limit = 2 ** logSlots;
  const out = v.map((s) => {
    const n = safeInt(s, "slot hint");
    if (n >= limit) throw shapeError("slot hint out of range");
    return n;
  });
  if (new Set(out).size !== out.length) throw shapeError("repeated slot hint");
  return out;
}

/** submitTxIntent answers the logical txid: it must be the one we computed. */
export function checkTxid(v, expected) {
  const t = hex64(v, "txid");
  if (t !== expected) throw shapeError("the node reports a different transaction id");
  return t;
}

export function checkMempoolEntry(v, txid) {
  if (v === null) return null;
  obj(v, "mempool entry");
  if (hex64(v.tx_hash, "tx_hash") !== txid) throw shapeError("mempool entry for another transaction");
  return {
    fee: checkFee(v.fee_micro_jtm),
    admittedHeight: safeInt(v.admitted_height, "admitted_height"),
    requiresB255: v.requires_b255_miner === true,
  };
}

export function checkTxInfo(v, txid, tip) {
  if (v === null) return null;
  obj(v, "getTx");
  if (hex64(v.tx_hash, "tx_hash") !== txid) throw shapeError("getTx for another transaction");
  const height = safeInt(v.height, "height");
  if (tip !== null && tip !== undefined && height > tip + 1) throw shapeError("confirmation height in the future");
  // The block's id, checked against getBlockHash(height) before "final" (SEC3-02).
  const blockHash = typeof v.block_hash === "string" && HEX64_RE.test(v.block_hash) ? v.block_hash.toLowerCase() : null;
  return { height, blockHash };
}
