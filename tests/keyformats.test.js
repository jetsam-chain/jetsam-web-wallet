// What the user hands the "Open a wallet" form, classified before anything is
// sent to the key worker. The worker (the node's own parsers, in wasm) is the
// authority; this only gives clear words for common mistakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySecretText, classifyKeyFile, FILE_SIZES, secretInputMode } from "../js/keyformats.js";

const HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const enc = (s) => new TextEncoder().encode(s);
function file(magic, total) {
  const b = new Uint8Array(total);
  b.set(enc(magic));
  return b;
}

test("64 hex digits, spaces and case ignored", () => {
  assert.deepEqual(classifySecretText(HEX), { ok: true });
  assert.deepEqual(classifySecretText(" " + HEX.toUpperCase().replace(/(.{8})/g, "$1 ") + "\n"), { ok: true });
});

test("common mistakes get their own words", () => {
  assert.equal(classifySecretText("").error, "empty");
  assert.equal(classifySecretText(HEX.slice(2)).error, "length");
  assert.equal(classifySecretText(HEX + "00").error, "length");
  assert.equal(classifySecretText("0x" + HEX).error, "prefix");
  assert.equal(classifySecretText(HEX.slice(0, 63) + "g").error, "not_hex");
  assert.equal(classifySecretText("j1ca4rzck28wced44tv0h997sppv48s2849akx6ml7j8fwexv6k9lqarhc9j").error, "address");
  assert.equal(classifySecretText("tj1ca4rzck28wced44tv0h997sppv48s2849akx6ml7j8fwexv6k9lqarhc9j").error, "address");
  const words = "abandon ability able about above absent absorb abstract absurd abuse access accident";
  assert.equal(classifySecretText(words).error, "mnemonic");
});

test("key files: sizes and magics of the node", () => {
  assert.deepEqual(FILE_SIZES, { plain: 48, sealed: 105 });
  assert.deepEqual(classifyKeyFile(file("jetsam_plainkey1", 48)), { ok: true, format: "plain", kind: "seed" });
  assert.deepEqual(classifyKeyFile(file("jetsam_spendkey1", 48)), { ok: true, format: "plain", kind: "spend" });
  assert.deepEqual(classifyKeyFile(file("jetsam_aead_key1", 105)), { ok: true, format: "sealed", kind: "seed" });
  assert.deepEqual(classifyKeyFile(file("jetsam_aeadspnd1", 105)), { ok: true, format: "sealed", kind: "spend" });
});

test("anything else is refused before it reaches the worker", () => {
  assert.equal(classifyKeyFile(file("jetsam_aead_key1", 104)).error, "size");
  assert.equal(classifyKeyFile(file("jetsam_plainkey1", 105)).error, "size");
  assert.equal(classifyKeyFile(file("noid_plainkey01", 48)).error, "magic");
  assert.equal(classifyKeyFile(new Uint8Array(0)).error, "size");
  assert.equal(classifyKeyFile(new Uint8Array(5_000_000)).error, "size");
  assert.equal(classifyKeyFile(enc(HEX)).error, "hex_text", "a text file with the hex export");
  assert.equal(classifyKeyFile(enc(HEX + "\n")).error, "hex_text");
  assert.equal(classifyKeyFile("not bytes").error, "size");
});

// SEC-09: the pasted secret is masked by CSS (-webkit-text-security) where
// the engine supports it, so password managers ignore it; elsewhere the
// field becomes a password field: never readable on screen.
test("secret field: masked text only where the engine can mask it, else a password field", () => {
  assert.equal(secretInputMode({ supports: (p, v) => p === "-webkit-text-security" && v === "disc" }), "masked");
  assert.equal(secretInputMode({ supports: () => false }), "password");
  assert.equal(secretInputMode(undefined), "password");
  assert.equal(secretInputMode({}), "password");
  assert.equal(secretInputMode({ supports: () => { throw new Error("no"); } }), "password");
});

test("the numbered layout of the backup step is read back as the plain 64 digits", async () => {
  const { plainSecretText } = await import("../js/keyformats.js");
  const shown = [0, 4, 8, 12]
    .map((r) => Array.from({ length: 4 }, (_, k) => String(r + k + 1).padStart(2, "0") + " " + HEX.slice((r + k) * 4, (r + k) * 4 + 4)).join(" "))
    .join("\n");
  assert.equal(plainSecretText(shown), HEX);
  assert.equal(plainSecretText("  " + shown.replace(/\n/g, "\r\n") + "\n"), HEX);
  assert.equal(classifySecretText(shown).ok, true);
  assert.equal(plainSecretText(HEX), HEX);
  // wrong order, a missing label or a changed group is not accepted as numbered text
  assert.equal(classifySecretText(shown.replace("02 ", "03 ")).ok, false);
  assert.equal(classifySecretText(shown.replace("16 ", "")).ok, false);
  assert.equal(classifySecretText(shown.slice(0, -1)).ok, false);
});
