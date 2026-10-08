// Key worker: the only place the wallet secret exists.
//
// A classic Worker running the wallet core (jetsam_wallet_wasm, the node's
// own code compiled to WebAssembly). The secret is held by a WalletKey handle
// inside the module and never posted back to the page, with two deliberate
// exceptions, both for backups: `seal` (the node's encrypted wallet.key) and
// `reveal` (ASCII hex bytes in a transferred Uint8Array, at most once per
// grant, never a string). Everything else answers with addresses, plans and
// proven intents.
//
// Messages: { id, cmd, arg } -> { id, ok: true, result } | { id, ok: false, error }.
// Errors are the core's own messages; none of them contains a secret.
//
// Proving is synchronous and takes tens of seconds. The page cancels it by
// terminating this worker, which also drops the secret: the wallet locks.

/* global wasm_bindgen, importScripts */
"use strict";

if (typeof wasm_bindgen === "undefined") {
  // Multi-file page: the glue sits next to this file's parent. The
  // single-file edition prepends the glue to this source instead.
  importScripts("../wasm/jetsam_wallet_wasm.js");
}

const NETWORKS = new Set(["mainnet", "testnet"]);
let key = null;
let revealGrants = 0;
let initialized = false;

function need(cond, message) {
  if (!cond) throw new Error(message);
}

function needKey() {
  need(key !== null, "the wallet is locked");
  return key;
}

function str(v, what, max = 4096) {
  need(typeof v === "string" && v.length <= max, "bad " + what);
  return v;
}

function setKey(next) {
  if (key !== null) key.free();
  key = next;
  revealGrants = 0;
}

const handlers = {
  async init(arg) {
    need(!initialized, "already initialized");
    // Single-file edition: module bytes come from the page. Otherwise the
    // glue fetches ../wasm/jetsam_wallet_wasm_bg.wasm itself.
    if (arg && arg.wasm instanceof ArrayBuffer) await wasm_bindgen({ module_or_path: arg.wasm });
    else await wasm_bindgen({ module_or_path: "../wasm/jetsam_wallet_wasm_bg.wasm" });
    initialized = true;
    return { version: wasm_bindgen.version() };
  },

  /** A new seed from crypto.getRandomValues; may be revealed once. */
  generate() {
    setKey(wasm_bindgen.WalletKey.generate());
    revealGrants = 1;
    return { kind: key.kind() };
  },

  importHex(arg) {
    const kind = arg.kind === "spend" ? "spend" : "seed";
    setKey(wasm_bindgen.WalletKey.fromHex(str(arg.text, "secret", 512), kind));
    return { kind: key.kind() };
  },

  openFile(arg) {
    need(arg.bytes instanceof Uint8Array && arg.bytes.length <= 4096, "bad key file");
    const pass = arg.password === undefined || arg.password === null ? undefined : str(arg.password, "password", 1024);
    const next = wasm_bindgen.WalletKey.fromKeyfile(arg.bytes, pass);
    setKey(next);
    return { kind: key.kind() };
  },

  /** The node's encrypted wallet.key under `password` (105 bytes). */
  seal(arg) {
    const sealed = needKey().seal(str(arg.password, "password", 1024));
    return sealed;
  },

  /** 64 ASCII hex bytes, transferred; allowed once per grant. */
  reveal() {
    needKey();
    need(revealGrants > 0, "the secret can only be shown right after it is created, or after the password is entered again");
    revealGrants--;
    return key.revealHex();
  },

  /**
   * Grant one more reveal after the password opens the stored sealed copy and
   * that copy is this very wallet.
   */
  grantReveal(arg) {
    needKey();
    need(arg.sealed instanceof Uint8Array, "bad sealed copy");
    const other = wasm_bindgen.WalletKey.fromKeyfile(arg.sealed, str(arg.password, "password", 1024));
    try {
      need(other.kind() === key.kind(), "that copy is another wallet");
      need(other.addresses(0, 1, "mainnet") === key.addresses(0, 1, "mainnet"), "that copy is another wallet");
    } finally {
      other.free();
    }
    revealGrants = 1;
    return true;
  },

  /** Every item { group, text } must match the secret's 4-digit group. */
  checkGroups(arg) {
    needKey();
    need(Array.isArray(arg.items) && arg.items.length > 0 && arg.items.length <= 16, "bad check");
    let all = true;
    for (const it of arg.items) {
      need(Number.isInteger(it.group) && it.group >= 0 && it.group < 16, "bad group");
      const text = str(it.text, "group", 32);
      // Evaluate every item: no early exit on the first mismatch.
      const okOne = key.checkHexFragment(it.group * 4, text) && text.replace(/\s/g, "").length === 4;
      all = all && okOne;
    }
    return all;
  },

  addresses(arg) {
    need(NETWORKS.has(arg.network), "bad network");
    need(Number.isInteger(arg.start) && arg.start >= 0 && Number.isInteger(arg.count) && arg.count > 0 && arg.count <= 20, "bad range");
    return JSON.parse(needKey().addresses(arg.start, arg.count, arg.network)).addresses;
  },

  /** Free function: plans need no secret. */
  plan(arg) {
    return wasm_bindgen.planSend(str(arg.json, "plan request", 1 << 20));
  },

  /** Prove a send, then verify the intent here before the page submits it. */
  build(arg) {
    const t0 = performance.now();
    const built = JSON.parse(needKey().buildSend(str(arg.json, "send request", 1 << 20)));
    const proveMs = performance.now() - t0;
    const facts = JSON.parse(wasm_bindgen.verifyIntent(built.intent_hex));
    need(facts.logical_txid === built.logical_txid, "the proof does not verify");
    return { built, facts, proveMs };
  },

  /** Drop (and zeroize) the secret. The page terminates the worker next. */
  lock() {
    setKey(null);
    return true;
  },
};

self.onmessage = async (event) => {
  const msg = event.data || {};
  const id = msg.id;
  try {
    const handler = Object.prototype.hasOwnProperty.call(handlers, msg.cmd) ? handlers[msg.cmd] : null;
    need(handler !== null, "unknown command");
    need(msg.cmd === "init" || msg.cmd === "lock" || initialized, "not initialized");
    const result = await handler(msg.arg || {});
    if (result instanceof Uint8Array) self.postMessage({ id, ok: true, result }, [result.buffer]);
    else self.postMessage({ id, ok: true, result });
  } catch (error) {
    const text = error && typeof error.message === "string" ? error.message : String(error);
    self.postMessage({ id, ok: false, error: text.slice(0, 500) });
  }
};
