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
