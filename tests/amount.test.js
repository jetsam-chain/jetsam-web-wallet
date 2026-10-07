import { test } from "node:test";
import assert from "node:assert/strict";
import { MICRO_PER_JTM, formatJtm, formatInt, sumMicro } from "../js/amount.js";

// 1 JTM = 1_000_000 µJTM — jetsam_chain/src/consensus/params.rs
// (MICRO_PER_JTM, line 1327 at tag v1.4.3, line 1612 on the v1.5 line).
test("unit is micro-JTM", () => {
  assert.equal(MICRO_PER_JTM, 1_000_000n);
});

test("six decimals, grouped thousands", () => {
  assert.equal(formatJtm(74_400_000_000n), "74,400.000000");
  assert.equal(formatJtm(17_421_029n), "17.421029");
  assert.equal(formatJtm(1n), "0.000001");
  assert.equal(formatJtm(0n), "0.000000");
  assert.equal(formatJtm(21_000_000_000_000n), "21,000,000.000000");
});

test("trim drops trailing zeros but keeps at least two decimals", () => {
  assert.equal(formatJtm(74_400_000_000n, { trim: true }), "74,400.00");
  assert.equal(formatJtm(45_000_000n, { trim: true }), "45.00");
  assert.equal(formatJtm(17_421_029n, { trim: true }), "17.421029");
  assert.equal(formatJtm(9_000n, { trim: true }), "0.009");
});

test("exact above 2^53 micro-units (no Number round-trip)", () => {
  assert.equal(formatJtm(9_007_199_254_740_993n), "9,007,199,254.740993");
});

test("negative values keep their sign", () => {
  assert.equal(formatJtm(-1_500_000n), "-1.500000");
});

test("refuses non-BigInt input instead of guessing", () => {
  assert.throws(() => formatJtm(1.5), TypeError);
  assert.throws(() => formatJtm("100"), TypeError);
});

test("sumMicro adds BigInts exactly", () => {
  assert.equal(sumMicro([]), 0n);
  assert.equal(sumMicro([2_400_000_000n, 1_200_000_000n]), 3_600_000_000n);
  assert.equal(sumMicro([9_007_199_254_740_993n, 1n]), 9_007_199_254_740_994n);
  assert.throws(() => sumMicro([1n, 2]), TypeError);
});

test("formatInt groups digits without locale APIs", () => {
  assert.equal(formatInt(0), "0");
  assert.equal(formatInt(999), "999");
  assert.equal(formatInt(32545), "32,545");
  assert.equal(formatInt(1234567n), "1,234,567");
  assert.equal(formatInt(-1200), "-1,200");
});
