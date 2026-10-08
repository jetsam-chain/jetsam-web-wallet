// First look at what the user gives the "Open a wallet" form. The key worker
// (the node's own parsers compiled to wasm) decides; this only names the
// common mistakes. Nothing here keeps or returns the secret.

export const FILE_SIZES = Object.freeze({ plain: 48, sealed: 105 });

const MAGICS = [
  ["jetsam_plainkey1", "plain", "seed"],
  ["jetsam_spendkey1", "plain", "spend"],
  ["jetsam_aead_key1", "sealed", "seed"],
  ["jetsam_aeadspnd1", "sealed", "spend"],
];

/** Text pasted as a secret: { ok } or { ok: false, error }. */
export function classifySecretText(text) {
  if (typeof text !== "string") return { ok: false, error: "empty" };
  const s = text.replace(/\s+/g, "");
  if (!s) return { ok: false, error: "empty" };
  if (/^t?j1[02-9ac-hj-np-z]{20,}$/i.test(s)) return { ok: false, error: "address" };
  if (/^0x/i.test(s)) return { ok: false, error: "prefix" };
  if (/[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/i.test(text.trim()) && !/^[0-9a-f\s]+$/i.test(text)) {
    return { ok: false, error: "mnemonic" };
  }
  if (s.length !== 64) return { ok: false, error: "length" };
  if (!/^[0-9a-fA-F]{64}$/.test(s)) return { ok: false, error: "not_hex" };
  return { ok: true };
}

/** Bytes of a chosen file: { ok, format, kind } or { ok: false, error }. */
export function classifyKeyFile(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 4096) return { ok: false, error: "size" };
  if (bytes.length >= 64 && bytes.length <= 70) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) return { ok: false, error: "hex_text" };
  }
  for (const [magic, format, kind] of MAGICS) {
    let match = bytes.length >= 16;
    for (let k = 0; match && k < 16; k++) if (bytes[k] !== magic.charCodeAt(k)) match = false;
    if (match) {
      return bytes.length === FILE_SIZES[format] ? { ok: true, format, kind } : { ok: false, error: "size" };
    }
  }
  if (bytes.length !== FILE_SIZES.plain && bytes.length !== FILE_SIZES.sealed) return { ok: false, error: "size" };
  return { ok: false, error: "magic" };
}
