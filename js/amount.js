// Amounts are BigInt micro-JTM end to end. 1 JTM = 1_000_000 µJTM
// (jetsam_chain/src/consensus/params.rs, MICRO_PER_JTM).

export const MICRO_PER_JTM = 1_000_000n;
const DECIMALS = 6;

function group(intDigits) {
  let out = "";
  for (let k = intDigits.length; k > 0; k -= 3) {
    out = intDigits.slice(Math.max(0, k - 3), k) + (out ? "," + out : "");
  }
  return out;
}

/**
 * "74,400.000000" — exact, no Number round-trip, no locale.
 * { trim: true } drops trailing zeros down to two decimals ("74,400.00").
 */
export function formatJtm(micro, { trim = false } = {}) {
  if (typeof micro !== "bigint") throw new TypeError("amount must be a BigInt of micro-JTM");
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = (abs / MICRO_PER_JTM).toString();
  let frac = (abs % MICRO_PER_JTM).toString().padStart(DECIMALS, "0");
  if (trim) frac = frac.replace(/0+$/, "").padEnd(2, "0");
  return (neg ? "-" : "") + group(whole) + "." + frac;
}

/** "32,545" — integer (Number or BigInt) with grouped thousands. */
export function formatInt(n) {
  const s = BigInt(n).toString();
  return s.startsWith("-") ? "-" + group(s.slice(1)) : group(s);
}

export function sumMicro(values) {
  let total = 0n;
  for (const v of values) {
    if (typeof v !== "bigint") throw new TypeError("amount must be a BigInt of micro-JTM");
    total += v;
  }
  return total;
}

/** Largest amount a transaction field can hold (u64 micro-JTM). */
export const MAX_MICRO = (1n << 64n) - 1n;

/**
 * Typed JTM text -> exact micro-JTM, never through a float.
 * Accepts "12", "12.5", ".5", "3." (ASCII digits, one dot, at most 6
 * decimals). A comma is refused with its own error: "1,5" and "1,000" mean
 * different things to different readers, so the page never guesses.
 * Returns { ok: true, micro } or { ok: false, error } with error one of
 * empty, zero, format, comma, too_precise, too_large.
 */
export function parseJtm(text) {
  if (typeof text !== "string") return { ok: false, error: "empty" };
  const s = text.trim();
  if (!s) return { ok: false, error: "empty" };
  if (s.includes(",")) return { ok: false, error: "comma" };
  const m = /^([0-9]*)(?:\.([0-9]*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] === undefined || m[2] === ""))) return { ok: false, error: "format" };
  const frac = m[2] || "";
  if (frac.length > DECIMALS) return { ok: false, error: "too_precise" };
  const whole = m[1] || "0";
  if (whole.replace(/^0+/, "").length > 20) return { ok: false, error: "too_large" };
  const micro = BigInt(whole) * MICRO_PER_JTM + BigInt(frac.padEnd(DECIMALS, "0") || "0");
  if (micro > MAX_MICRO) return { ok: false, error: "too_large" };
  if (micro === 0n) return { ok: false, error: "zero" };
  return { ok: true, micro };
}
