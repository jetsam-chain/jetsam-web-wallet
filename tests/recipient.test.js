// Recipient checks before anything is proven: strict bech32m, right network,
// and a clear word when the text hides look-alike or invisible characters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRecipient, groupAddress, encodeAddress } from "../js/bech32m.js";

const MAIN = "j1ca4rzck28wced44tv0h997sppv48s2849akx6ml7j8fwexv6k9lqarhc9j";
// the same 32 bytes under the testnet prefix (a different, valid checksum)
const TEST = encodeAddress("tj", checkRecipient(MAIN, "mainnet").bytes);

test("a valid address of the selected network passes", () => {
  const r = checkRecipient(MAIN, "mainnet");
  assert.equal(r.ok, true);
  assert.equal(r.address, MAIN);
  assert.equal(r.bytes.length, 32);
  assert.equal(checkRecipient("  " + MAIN.toUpperCase() + "\n", "mainnet").address, MAIN);
});

test("the other network is refused, never converted", () => {
  assert.deepEqual(checkRecipient(TEST, "mainnet"), { ok: false, error: "other_network", network: "testnet" });
  assert.deepEqual(checkRecipient(MAIN, "testnet"), { ok: false, error: "other_network", network: "mainnet" });
});

test("look-alike and invisible characters are named as such", () => {
  // Cyrillic 'а' (U+0430) in place of Latin 'a'
  assert.equal(checkRecipient(MAIN.replace("a", "а"), "mainnet").error, "lookalike");
  // zero-width space inside
  assert.equal(checkRecipient(MAIN.slice(0, 10) + "​" + MAIN.slice(10), "mainnet").error, "lookalike");
  // a space in the middle is not a look-alike, just not an address
  assert.equal(checkRecipient(MAIN.slice(0, 10) + " " + MAIN.slice(10), "mainnet").error, "format");
});

test("one changed character fails the checksum", () => {
  const altered = MAIN.slice(0, 20) + (MAIN[20] === "q" ? "p" : "q") + MAIN.slice(21);
  assert.equal(checkRecipient(altered, "mainnet").error, "checksum");
});

test("bech32 (not bech32m) checksums are refused", () => {
  const bytes = checkRecipient(MAIN, "mainnet").bytes;
  const bech32 = encodeAddress("j", bytes, { constant: 1 });
  assert.equal(checkRecipient(bech32, "mainnet").error, "checksum");
});

test("unknown network argument is a programming error", () => {
  assert.throws(() => checkRecipient(MAIN, "devnet"));
});

test("groupAddress splits for reading, in fours", () => {
  const g = groupAddress(MAIN);
  assert.equal(g.join(""), MAIN);
  assert.ok(g.every((p, i) => p.length === 4 || i === g.length - 1));
});
