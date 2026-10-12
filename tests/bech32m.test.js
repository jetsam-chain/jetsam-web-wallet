import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAddress, encodeAddress } from "../js/bech32m.js";

// Vectors checked against the nodes themselves on 2026-10-07:
// jetsam_validateAddress on rpc.jetsamchain.com (mainnet) and
// rpc-testnet.jetsamchain.com (testnet) both returned this hex.
const FUND_HEX = "77ca540bbf9e017b3e8a139fe91366bd00db8ca0518d113a4206664d29f044f0";
const MAIN = "j1wl99gzalncqhk052zw07jymxh5qdhr9q2xx3zwjzqeny620sgncqkfyv2z";
const TEST = "tj1wl99gzalncqhk052zw07jymxh5qdhr9q2xx3zwjzqeny620sgncqr6m6y3";

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));

test("decodes a mainnet address to the 32 bytes the node reports", () => {
  const r = decodeAddress(MAIN);
  assert.equal(r.ok, true);
  assert.equal(r.hrp, "j");
  assert.equal(r.network, "mainnet");
  assert.equal(hex(r.bytes), FUND_HEX);
  assert.equal(r.address, MAIN);
});

// The wallet is mainnet only: a testnet address (valid checksum) is named
// as such and refused, never decoded as a mainnet one.
test("a testnet address is refused, and named as such", () => {
  assert.deepEqual(decodeAddress(TEST), { ok: false, error: "testnet" });
  assert.deepEqual(decodeAddress(TEST.toUpperCase()), { ok: false, error: "testnet" });
});

test("encodes any prefix (the tests build testnet addresses with it)", () => {
  assert.equal(encodeAddress("j", unhex(FUND_HEX)), MAIN);
  assert.equal(encodeAddress("tj", unhex(FUND_HEX)), TEST);
});

test("all-uppercase is accepted and normalised to lowercase (the node does the same)", () => {
  const r = decodeAddress(MAIN.toUpperCase());
  assert.equal(r.ok, true);
  assert.equal(r.address, MAIN);
});

test("surrounding whitespace is ignored", () => {
  assert.equal(decodeAddress("  " + MAIN + "\n").ok, true);
});

test("mixed case is refused", () => {
  const mixed = "J" + MAIN.slice(1);
  assert.equal(decodeAddress(mixed).ok, false);
  assert.equal(decodeAddress(mixed).error, "mixed_case");
});

test("one changed character breaks the checksum", () => {
  const bad = MAIN.slice(0, -1) + "y";
  const r = decodeAddress(bad);
  assert.equal(r.ok, false);
  assert.equal(r.error, "checksum");
});

test("every single-character substitution is detected", () => {
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  for (let i = 2; i < MAIN.length; i++) {
    for (const c of charset) {
      if (c === MAIN[i]) continue;
      const mutated = MAIN.slice(0, i) + c + MAIN.slice(i + 1);
      assert.equal(decodeAddress(mutated).ok, false, mutated);
    }
  }
});

test("a bech32 (not bech32m) checksum is refused", () => {
  // Same payload, checksum computed with constant 1 instead of 0x2bc830a3.
  const r = decodeAddress(encodeAddress("j", unhex(FUND_HEX), { constant: 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "checksum");
});

test("unknown prefix is refused", () => {
  const r = decodeAddress(encodeAddress("bc", unhex(FUND_HEX)));
  assert.equal(r.ok, false);
  assert.equal(r.error, "unknown_prefix");
});

test("wrong payload length is refused", () => {
  const r = decodeAddress(encodeAddress("j", unhex(FUND_HEX).slice(0, 31)));
  assert.equal(r.ok, false);
  assert.equal(r.error, "length");
});

test("garbage is refused without throwing", () => {
  for (const s of ["", "j1", "hello", "j1" + "b".repeat(58), "j1wl99gzalncqhk052zw07jymxh5qdhr9q2xx3zwjzqeny620sgncqkfyv2", null, undefined, 42]) {
    const r = decodeAddress(s);
    assert.equal(r.ok, false, String(s));
    assert.equal(typeof r.error, "string");
  }
});
