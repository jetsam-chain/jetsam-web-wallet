// Typed amounts: JTM text -> exact BigInt micro-JTM, never through a float.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJtm, formatJtm, MAX_MICRO } from "../js/amount.js";

const ok = (text, micro) => assert.deepEqual(parseJtm(text), { ok: true, micro }, text);
const bad = (text, error) => assert.deepEqual(parseJtm(text), { ok: false, error }, text);

test("whole and fractional JTM become exact micro-JTM", () => {
  ok("1", 1_000_000n);
  ok("0.000001", 1n);
  ok("12.5", 12_500_000n);
  ok("  7.25 ", 7_250_000n);
  ok(".5", 500_000n);
  ok("3.", 3_000_000n);
  ok("0001.100000", 1_100_000n);
  // a value a float would round: 0.1 + 0.2 style traps do not exist here
  ok("9007199254.740993", 9_007_199_254_740_993n);
});

test("round trip with formatJtm", () => {
  for (const m of [1n, 999_999n, 1_000_000n, 123_456_789_012n]) {
    assert.equal(parseJtm(formatJtm(m).replace(/,/g, "")).micro, m);
  }
});

test("refusals are explicit", () => {
  bad("", "empty");
  bad("   ", "empty");
  bad("0", "zero");
  bad("0.000000", "zero");
  bad("1.0000001", "too_precise");
  bad("-1", "format");
  bad("+1", "format");
  bad("1e3", "format");
  bad("1,5", "comma");
  bad("1,000", "comma");
  bad("1.2.3", "format");
  bad("abc", "format");
  bad(".", "format");
  bad("１", "format"); // full-width digit
  bad("1 000", "format");
  bad("Infinity", "format");
  bad("0x10", "format");
});

test("no amount above the u64 range is accepted", () => {
  assert.equal(MAX_MICRO, (1n << 64n) - 1n);
  bad("18446744073709.551616", "too_large");
  ok("18446744073709.551615", MAX_MICRO);
  bad("9".repeat(40), "too_large");
});

test("non-string input is refused", () => {
  bad(undefined, "empty");
  bad(12, "empty");
});
