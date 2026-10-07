// Jetsam addresses: bech32m (BIP-350) over the 32-byte address hash.
// HRP "j" on mainnet, "tj" on testnet (jetsam_poseidon2b/src/primitives.rs).
// The checksum is the whole job here: a watch-only wallet must never show a
// balance for an address the user mistyped.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export const HRP_NETWORK = Object.freeze({ j: "mainnet", tj: "testnet" });
const ADDRESS_BYTES = 32;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let k = 0; k < 5; k++) if ((top >>> k) & 1) chk = (chk ^ GEN[k]) >>> 0;
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (let k = 0; k < hrp.length; k++) out.push(hrp.charCodeAt(k) >> 5);
  out.push(0);
  for (let k = 0; k < hrp.length; k++) out.push(hrp.charCodeAt(k) & 31);
  return out;
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || ((acc << (to - bits)) & max)) {
    return null;
  }
  return out;
}

/** Encode raw bytes as a bech32m string. `constant` exists for tests only. */
export function encodeAddress(hrp, bytes, { constant = BECH32M_CONST } = {}) {
  const data = convertBits(Array.from(bytes), 8, 5, true);
  const mod = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ constant;
  let out = hrp + "1";
  for (const d of data) out += CHARSET[d];
  for (let k = 0; k < 6; k++) out += CHARSET[(mod >>> (5 * (5 - k))) & 31];
  return out;
}

/**
 * Decode and check an address.
 * Returns { ok: true, address, hrp, network, bytes } or { ok: false, error }.
 * error is one of: empty, mixed_case, format, checksum, unknown_prefix, length.
 */
export function decodeAddress(input) {
  if (typeof input !== "string") return { ok: false, error: "empty" };
  const s = input.trim();
  if (!s) return { ok: false, error: "empty" };
  if (s.length > 90) return { ok: false, error: "format" };
  const lower = s.toLowerCase();
  if (s !== lower && s !== s.toUpperCase()) return { ok: false, error: "mixed_case" };
  for (let k = 0; k < lower.length; k++) {
    const c = lower.charCodeAt(k);
    if (c < 33 || c > 126) return { ok: false, error: "format" };
  }
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return { ok: false, error: "format" };
  const hrp = lower.slice(0, sep);
  const data = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) return { ok: false, error: "format" };
    data.push(v);
  }
  if (polymod(hrpExpand(hrp).concat(data)) !== BECH32M_CONST) return { ok: false, error: "checksum" };
  if (!Object.prototype.hasOwnProperty.call(HRP_NETWORK, hrp)) return { ok: false, error: "unknown_prefix" };
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  if (!bytes || bytes.length !== ADDRESS_BYTES) return { ok: false, error: "length" };
  return { ok: true, address: lower, hrp, network: HRP_NETWORK[hrp], bytes: Uint8Array.from(bytes) };
}
