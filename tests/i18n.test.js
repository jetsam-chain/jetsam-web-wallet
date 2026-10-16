// The five languages: same keys, same placeholders, plain text only, and no
// key the page uses missing from any of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { STRINGS, LANGS, LANG_NAMES, t, tp, setLang, getLang, pickLang } from "../js/i18n.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const EN = STRINGS.en;
const placeholders = (s) => (s.match(/\{[a-z_]+\}/g) || []).slice().sort();

test("five languages ship, English first, each named in itself", () => {
  assert.deepEqual(LANGS, ["en", "fr", "es", "ru", "zh"]);
  assert.deepEqual(Object.keys(STRINGS).sort(), LANGS.slice().sort());
  assert.deepEqual(Object.keys(LANG_NAMES), LANGS);
  for (const l of LANGS) assert.ok(LANG_NAMES[l].length > 1, l);
});

test("strict key parity: every language has exactly the English keys", () => {
  const want = Object.keys(EN).sort();
  assert.ok(want.length > 300, "found " + want.length + " English keys");
  for (const l of LANGS) {
    const have = Object.keys(STRINGS[l]).sort();
    const missing = want.filter((k) => !(k in STRINGS[l]));
    const extra = have.filter((k) => !(k in EN));
    assert.deepEqual({ lang: l, missing, extra }, { lang: l, missing: [], extra: [] });
  }
});

test("same placeholders in every translation, and no stray brace", () => {
  for (const l of LANGS) {
    for (const [k, v] of Object.entries(STRINGS[l])) {
      assert.deepEqual(placeholders(v), placeholders(EN[k]), l + " " + k);
      assert.doesNotMatch(v.replace(/\{[a-z_]+\}/g, ""), /[{}]/, l + " " + k + ": stray brace");
    }
  }
});

test("no empty string, no text left untrimmed", () => {
  for (const l of LANGS) {
    for (const [k, v] of Object.entries(STRINGS[l])) {
      assert.equal(typeof v, "string", l + " " + k);
      assert.ok(v.trim().length > 0, l + " " + k + " is empty");
      assert.equal(v, v.trim(), l + " " + k + " has leading or trailing space");
    }
  }
});

test("translations are plain text: no HTML, no entity, no script, no URL but the scheme hint", () => {
  for (const l of LANGS) {
    for (const [k, v] of Object.entries(STRINGS[l])) {
      assert.doesNotMatch(v, /[<>]/, l + " " + k + ": angle bracket");
      assert.doesNotMatch(v, /&(#?[a-z0-9]+);/i, l + " " + k + ": HTML entity");
      assert.doesNotMatch(v, /javascript:|data:|\bon[a-z]+\s*=/i, l + " " + k + ": script");
      // The only "://" is the https:// / http:// of the RPC URL hint, as in English.
      assert.equal((v.match(/:\/\//g) || []).length, (EN[k].match(/:\/\//g) || []).length, l + " " + k + ": URL");
    }
  }
});

test("what is not translated stays as it is: addresses, units, commands, file names", () => {
  // Every token of this kind in the English text is in each translation too.
  const keep = /jetsam --export-wallet-secret|wallet\.key|submitTxIntent|connect-src|Content-Security-Policy|README|j1…|tj1…|JTM|µJTM|0x|0-9|a-f|https?:\/\/|127\.0\.0\.1|localhost|12\.5|1234\.5|0\.000001/g;
  for (const [k, en] of Object.entries(EN)) {
    const tokens = (en.match(keep) || []).slice().sort();
    for (const l of LANGS) {
      const got = (STRINGS[l][k].match(keep) || []).slice().sort();
      assert.deepEqual([...new Set(got)], [...new Set(tokens)], l + " " + k);
    }
  }
});

test("security warnings keep their substance in every language", () => {
  // Not a translation check (that is a human's), but nothing may drop the
  // numbers, the 12/24-word line or the clipboard countdown.
  for (const l of LANGS) {
    const s = STRINGS[l];
    assert.match(s["open.hex_help"], /12\/24/, l);
    assert.match(s["open.hex_help_password"], /12\/24/, l);
    assert.match(s["create.canvas_label"], /16/, l);
    assert.match(s["create.canvas_note"], /16/, l);
    assert.match(s["result.refused_held"], /65/, l);
    assert.match(s["history.unreadable"], /\b2\b/, l);
    assert.match(s["history.unreadable"], /64/, l);
    assert.match(s["outputs.provisional_note"], /9/, l);
  }
});

// Every key the page uses, found in the code and the HTML: a call t("…"),
// any key-shaped string literal (keys picked by a condition), a plural base
// of tp(), a prefix completed at run time, or a data-i18n* attribute.
function usedKeys() {
  const used = new Set();
  const storagePrefixes = new Set(["addresses.", "mint.", "jww.v1.", "jww.v1.tablock."]);
  for (const f of readdirSync(new URL("js/", root))) {
    if (!f.endsWith(".js") || f.startsWith("i18n")) continue;
    const src = read("js/" + f);
    for (const m of src.matchAll(/\btp\("([a-z0-9_.]+)"/g)) used.add(m[1] + ".one").add(m[1] + ".other");
    for (const m of src.matchAll(/"([a-z][a-z0-9_]*\.[a-z0-9_.]*)"/g)) {
      const k = m[1];
      if (storagePrefixes.has(k)) continue;
      if (k + ".one" in EN && k + ".other" in EN) continue; // a plural base
      used.add(k);
    }
  }
  const html = read("index.html");
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([a-z0-9_.]+)"/g)) used.add(m[1]);
  return used;
}

test("no key used by the code or the page is missing, in any language", () => {
  const used = usedKeys();
  assert.ok(used.size > 250, "found " + used.size + " keys");
  for (const l of LANGS) {
    const table = STRINGS[l];
    const missing = [...used].filter((k) => (k.endsWith(".") ? !Object.keys(table).some((s) => s.startsWith(k)) : !(k in table)));
    assert.deepEqual({ lang: l, missing }, { lang: l, missing: [] });
  }
});

test("keys completed at run time exist for every value the code can produce", () => {
  const family = {
    "addr.err.": [...read("js/bech32m.js").matchAll(/error: "([a-z_]+)"/g)].map((m) => m[1]),
    "amount.err.": [...read("js/amount.js").matchAll(/error: "([a-z_]+)"/g)].map((m) => m[1]),
    "open.err.": [...read("js/keyformats.js").match(/export function classifySecretText[\s\S]*?\n\}/)[0].matchAll(/error: "([a-z_]+)"/g)].map((m) => m[1]),
    "sent.status.": [...read("js/pending.js").matchAll(/status(?: =|:) "([a-z_]+)"/g)].map((m) => m[1]),
    "sent.contradicted.": [...read("js/pending.js").matchAll(/contradicted(?: =|:) "([a-z_]+)"/g)].map((m) => m[1]),
    "sent.crosscheck.": [...read("js/pending.js").matchAll(/crossCheck(?: =|:) "([a-z_]+)"/g)].map((m) => m[1]),
    "sent.expired.": ["public", "alone"],
    "sent.hold.": [...read("js/pending.js").matchAll(/kind: "([a-z_]+)"/g)].map((m) => m[1]),
    "history.": [...read("js/wallet.js").matchAll(/historyProblem = (?:stored \? null : )?"([a-z_]+)"/g)].map((m) => m[1]),
    "net.": ["mainnet"],
  };
  for (const [prefix, codes] of Object.entries(family)) {
    assert.ok(codes.length > 0, prefix + " codes found");
    for (const code of new Set(codes)) for (const l of LANGS) assert.ok(prefix + code in STRINGS[l], l + " " + prefix + code);
  }
});

test("t() and tp() follow the language set; unknown keys fall back to English, then to the key", () => {
  try {
    setLang("fr");
    assert.equal(getLang(), "fr");
    assert.equal(t("chain.height", { height: "7" }), STRINGS.fr["chain.height"].replace("{height}", "7"));
    assert.equal(tp("utxo.count", 2), STRINGS.fr["utxo.count.other"].replace("{n}", "2"));
    assert.equal(t("no.such.key"), "no.such.key");
    setLang("xx");
    assert.equal(getLang(), "en");
  } finally {
    setLang("en");
  }
});

test("the starting language: the saved choice, else the browser's first that ships, else English", () => {
  assert.equal(pickLang("ru", ["fr-FR"]), "ru");
  assert.equal(pickLang(undefined, ["fr-CA", "en"]), "fr");
  assert.equal(pickLang(null, ["de-DE", "es-MX"]), "es");
  assert.equal(pickLang(null, ["zh-TW"]), "zh");
  assert.equal(pickLang("klingon", ["de-DE", "it"]), "en");
  assert.equal(pickLang(undefined, undefined), "en");
  assert.equal(pickLang(undefined, []), "en");
});

test("the language picker: in the header, a disclosure with one button per language, labelled", () => {
  const html = read("index.html");
  const header = html.match(/<header class="bar">[\s\S]*?<\/header>/)[0];
  const box = header.match(/<details class="langsel" id="langsel">[\s\S]*?<\/details>/);
  assert.ok(box, "picker in the header");
  assert.match(box[0], /<summary [^>]*id="lang-btn"[^>]*data-i18n-title="lang.label"/);
  assert.match(box[0], /data-i18n-aria-label="lang.label"/);
  const langs = [...box[0].matchAll(/<button class="lang-opt" type="button" data-lang="([a-z]+)" lang="([a-zA-Z-]+)">([^<]+)<\/button>/g)];
  assert.deepEqual(langs.map((m) => m[1]), LANGS);
  for (const m of langs) assert.equal(m[3], LANG_NAMES[m[1]]);
  // Remembered in the page's preferences (localStorage, guarded by storage.js),
  // never by the modules that touch the secret.
  const app = read("js/app.js");
  assert.match(app, /setLang\(pickLang\(prefs\.lang, navigator\.languages \|\| \[navigator\.language\]\)\)/);
  assert.match(app, /p\.lang = code;\s*store\.set\("prefs", p\);/);
});
