import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../js/storage.js";
import { qrPath } from "../js/qr.js";

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test("store round-trips JSON values", () => {
  const s = createStore(memoryStorage());
  assert.equal(s.available, true);
  s.set("a", { x: [1, 2] });
  assert.deepEqual(s.get("a", null), { x: [1, 2] });
  s.remove("a");
  assert.equal(s.get("a", "dflt"), "dflt");
});

test("store survives a storage that throws (private mode, blocked site data)", () => {
  const hostile = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  const s = createStore(hostile);
  assert.equal(s.available, false);
  assert.equal(s.get("a", 7), 7);
  assert.doesNotThrow(() => s.set("a", 1));
  assert.doesNotThrow(() => s.remove("a"));
});

test("store survives no storage at all and corrupt values", () => {
  assert.equal(createStore(undefined).get("a", 1), 1);
  const raw = memoryStorage();
  raw.setItem("jww.v1.a", "{not json");
  assert.equal(createStore(raw).get("a", "fallback"), "fallback");
});

test("qrPath draws one unit square per dark module, offset by the quiet zone", () => {
  const p = qrPath([[true, false], [false, true]], 4);
  assert.equal(p, "M4 4h1v1h-1zM5 5h1v1h-1z");
});

test("qrPath merges horizontal runs", () => {
  assert.equal(qrPath([[true, true, true]], 0), "M0 0h3v1h-3z");
});
