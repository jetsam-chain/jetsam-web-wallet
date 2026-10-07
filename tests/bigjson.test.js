import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJson } from "../js/bigjson.js";

const fixture = (name) =>
  readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");

test("integers become BigInt, exactly, even above 2^53", () => {
  const v = parseJson('{"a": 9223372036854775809, "b": 0, "c": -42}');
  assert.equal(v.a, 9223372036854775809n);
  assert.equal(v.b, 0n);
  assert.equal(v.c, -42n);
});

test("JSON.parse really does destroy the coinbase creation_id (the reason this exists)", () => {
  const text = '{"creation_id": 9223372036854775809}';
  assert.notEqual(BigInt(JSON.parse(text).creation_id), 9223372036854775809n);
  assert.equal(parseJson(text).creation_id, 9223372036854775809n);
});

test("fractions and exponents stay Numbers", () => {
  const v = parseJson('[1.5, -0.25, 1e3, 2E-2, 7]');
  assert.deepEqual(v, [1.5, -0.25, 1000, 0.02, 7n]);
});

test("strings, escapes and literals", () => {
  const v = parseJson('{"s":"a\\"b\\\\c\\/d\\n\\t","u":"j1qpj4\\u2026jssq","t":true,"f":false,"n":null,"e":[],"o":{}}');
  assert.equal(v.s, 'a"b\\c/d\n\t');
  assert.equal(v.u, "j1qpj4…jssq");
  assert.equal(v.t, true);
  assert.equal(v.f, false);
  assert.equal(v.n, null);
  assert.deepEqual(v.e, []);
  assert.deepEqual(v.o, {});
});

test("surrogate pairs decode", () => {
  assert.equal(parseJson('"\\ud83d\\ude00"'), "\u{1F600}");
});

test("digits inside strings are never touched", () => {
  assert.equal(parseJson('{"h":"9223372036854775809"}').h, "9223372036854775809");
});

test("malformed input throws", () => {
  for (const bad of ["", "{", '{"a":}', "[1,]", "01", "-", '"abc', "tru", "{} x", "1.", "NaN", '{"a" 1}']) {
    assert.throws(() => parseJson(bad), SyntaxError, bad);
  }
});

test("__proto__ keys cannot pollute prototypes", () => {
  const v = parseJson('{"__proto__": {"polluted": 1}}');
  assert.equal({}.polluted, undefined);
  assert.equal(v.polluted, undefined);
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.ok(Object.prototype.hasOwnProperty.call(v, "__proto__"));
});

test("real getSlotsByOwner response with coinbases (mainnet, 2026-10-07)", () => {
  const body = parseJson(fixture("slots-coinbase-sample.raw.json"));
  const ids = body.result.map((s) => s.creation_id);
  assert.deepEqual(ids, [
    9223372036854775809n,
    9223372036854776018n,
    9223372036854777538n,
    9223372036854781331n,
  ]);
  // The proxy's own decoding agrees with the exact integer.
  for (const s of body.result) {
    assert.equal(s.creation_id & ~(1n << 63n), s.creation_height);
  }
});

test("real getSlotsByOwner response of the fund-network address", () => {
  const body = parseJson(fixture("slots-fund-network.raw.json"));
  assert.equal(body.result.length, 33);
  const total = body.result.reduce((a, s) => a + s.value, 0n);
  assert.equal(total, 74_400_000_000n);
});
