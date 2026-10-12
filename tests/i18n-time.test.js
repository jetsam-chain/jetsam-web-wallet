import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { STRINGS, t, tp } from "../js/i18n.js";
import { formatUtc, formatAge } from "../js/timefmt.js";

test("formatUtc is UTC whatever the machine's zone", () => {
  assert.equal(formatUtc(1791350190), "2026-10-07 05:16:30 UTC");
  assert.equal(formatUtc(0), "1970-01-01 00:00:00 UTC");
});

test("formatUtc accepts BigInt seconds", () => {
  assert.equal(formatUtc(1791350190n), "2026-10-07 05:16:30 UTC");
});

test("formatAge: short, English, never negative", () => {
  assert.equal(formatAge(30), "30 s");
  assert.equal(formatAge(90), "1 min");
  assert.equal(formatAge(7200), "2 h");
  assert.equal(formatAge(3 * 86400 + 5), "3 d");
  assert.equal(formatAge(-5), "0 s");
});

test("t() interpolates and falls back to the key", () => {
  assert.equal(t("chain.height", { height: "3" }), STRINGS.en["chain.height"].replace("{height}", "3"));
  assert.equal(t("no.such.key"), "no.such.key");
});

test("tp() picks the plural form", () => {
  assert.equal(tp("utxo.count", 1), "1 output");
  assert.equal(tp("utxo.count", 2472, { n: "2,472" }), "2,472 outputs");
  assert.equal(tp("utxo.count", 0), "0 outputs");
});

test("only English ships for now", () => {
  assert.deepEqual(Object.keys(STRINGS), ["en"]);
});

test("every t('...') key used in the app exists in the dictionary", () => {
  const dir = new URL("../js/", import.meta.url);
  const used = new Set();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/\bt\("([a-z0-9_.]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/\btp\("([a-z0-9_.]+)"/g)) used.add(m[1] + ".one").add(m[1] + ".other");
  }
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([a-z0-9_.]+)"/g)) used.add(m[1]);
  // Keys built at run time ("addr.err." + code) are checked by prefix.
  const missing = [...used].filter((k) =>
    k.endsWith(".") ? !Object.keys(STRINGS.en).some((s) => s.startsWith(k)) : !(k in STRINGS.en));
  for (const code of ["empty", "mixed_case", "format", "checksum", "unknown_prefix", "length", "testnet", "lookalike"]) {
    assert.ok("addr.err." + code in STRINGS.en, "addr.err." + code);
  }
  for (const code of ["rpc.url_invalid", "rpc.url_scheme", "rpc.url_credentials", "net.mainnet"]) {
    assert.ok(code in STRINGS.en, code);
  }
  for (const code of ["net.testnet", "addr.err.other_network", "send.err.other_network"]) {
    assert.ok(!(code in STRINGS.en), code + " is gone with the testnet");
  }
  assert.deepEqual(missing, []);
  assert.ok(used.size > 20, "found " + used.size + " keys");
});

test("no locale-dependent time or number APIs anywhere in the app", () => {
  const dir = new URL("../js/", import.meta.url);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /toLocale|getHours\(|getMinutes\(|getDate\(|getMonth\(|getFullYear\(|Intl\./, f);
  }
});
