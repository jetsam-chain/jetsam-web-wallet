// What the user hands the "Open a wallet" form, classified before anything is
// sent to the key worker. The worker (the node's own parsers, in wasm) is the
// authority; this only gives clear words for common mistakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySecretText, classifyKeyFile, FILE_SIZES } from "../js/keyformats.js";

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
