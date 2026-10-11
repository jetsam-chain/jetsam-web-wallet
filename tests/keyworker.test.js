// The key worker as shipped (worker/keyworker.js + wasm/), run in a VM
// context with the page's view of it: messages in, messages out. Whatever
// code runs in the page can post these messages too (an XSS, an extension),
// so no command may let the secret out without the password (SEC-01).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const SEED = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const PASSWORD = "tide gauge harbour 7";

export async function loadWorker() {
  const posted = [];
  const ctx = {
    crypto: globalThis.crypto, performance, TextEncoder, TextDecoder, WebAssembly, URL,
    postMessage: (m) => posted.push(m),
    importScripts: () => { throw new Error("no importScripts here"); },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("wasm/jetsam_wallet_wasm.js", root), "utf8"), ctx);
  vm.runInContext(readFileSync(new URL("worker/keyworker.js", root), "utf8"), ctx);
  let id = 0;
  const call = async (cmd, arg) => {
    const my = ++id;
    await ctx.onmessage({ data: { id: my, cmd, arg } });
    const m = posted.find((p) => p.id === my);
    if (!m.ok) throw new Error(m.error);
    return structuredClone(m.result); // what postMessage hands the page
  };
  // Bytes are made in the worker's realm, as a structured clone would be.
  const bytes = vm.runInContext("(src) => Uint8Array.from(src)", ctx);
  call.bytes = bytes;
  await call("init", { wasm: bytes(readFileSync(new URL("wasm/jetsam_wallet_wasm_bg.wasm", root))).buffer });
  return call;
}

const hexOf = (bytes) => String.fromCharCode(...bytes);

test("no command compares guesses with the secret (the fragment oracle is gone)", async () => {
  const call = await loadWorker();
  await call("importHex", { text: SEED, kind: "seed", password: PASSWORD });
  // The audit's attack: try every 4-digit value of group 0.
  let found = null;
  for (let v = 0; v < 65536 && found === null; v++) {
    const text = v.toString(16).padStart(4, "0");
    let ok = false;
    try {
      ok = await call("checkGroups", { items: [{ group: 0, text }] });
    } catch (_) {
      break; // refused: no oracle
    }
    if (ok === true) found = text;
  }
  assert.equal(found, null, "group 0 of the secret recovered through checkGroups");
  for (const cmd of ["checkGroups", "checkHexFragment", "seal"]) {
    await assert.rejects(call(cmd, { items: [{ group: 0, text: "0001" }], password: "x" }), /unknown command/, cmd);
  }
});

test("an unlocked wallet cannot be re-sealed under a password chosen by page code", async () => {
  const call = await loadWorker();
  const created = await call("importHex", { text: SEED, kind: "seed", password: PASSWORD });
  assert.ok(ArrayBuffer.isView(created.sealed) && created.sealed.length === 105);
  const call2 = await loadWorker();
  const opened = await call2("openFile", { bytes: call2.bytes(created.sealed), password: PASSWORD });
  assert.equal(opened.sealed, undefined, "unlocking returns no sealed copy");
  await assert.rejects(call2("seal", { password: "attacker" }), /unknown command/);
});

test("backup check: only for a generated seed, 3 groups drawn by the worker, 3 attempts, then the key is dropped", async () => {
  const call = await loadWorker();
  const g = await call("generate", { password: PASSWORD });
  assert.equal(g.kind, "seed");
  assert.equal(g.sealed.length, 105);
  const groups = await call("quizStart", {});
  assert.equal(groups.length, 3);
  assert.ok(groups.every((n) => Number.isInteger(n) && n >= 0 && n < 16));
  await assert.rejects(call("quizStart", {}), /backup check/);
  for (let left = 2; left >= 0; left--) {
    const r = await call("quizAnswer", { answers: ["zzzz", "zzzz", "zzzz"] });
    assert.deepEqual(r, { ok: false, attemptsLeft: left });
  }
  await assert.rejects(call("addresses", { network: "mainnet", start: 0, count: 1 }), /locked/, "dropped after 3 failures");

  const imported = await loadWorker();
  await imported("importHex", { text: SEED, kind: "seed", password: PASSWORD });
  await assert.rejects(imported("quizStart", {}), /backup check/);
});

test("backup check: the right groups pass once, then the check is closed", async () => {
  const call = await loadWorker();
  await call("generate", { password: PASSWORD });
  const secret = hexOf(await call("reveal", {}));
  const groups = await call("quizStart", {});
  const answers = groups.map((n) => secret.slice(4 * n, 4 * n + 4).toUpperCase());
  assert.deepEqual(await call("quizAnswer", { answers }), { ok: true, attemptsLeft: 3 });
  await assert.rejects(call("quizAnswer", { answers }), /backup check/);
  await assert.rejects(call("reveal", {}), /password/, "shown once; the password is needed again");
  assert.equal((await call("addresses", { network: "mainnet", start: 0, count: 1 })).length, 1);
});

// SEC-06: the record of payments sent is stored sealed by the wallet key.
test("metadata: sealed by the wallet key, opened only by the same wallet and network", async () => {
  const call = await loadWorker();
  const created = await call("importHex", { text: SEED, kind: "seed", password: PASSWORD });
  const text = JSON.stringify({ pending: [{ to: "j1recipientaddress", txid: "ab".repeat(32) }] });
  const sealed = await call("sealMeta", { network: "mainnet", text });
  assert.ok(ArrayBuffer.isView(sealed));
  assert.ok(!Buffer.from(sealed).toString("latin1").includes("j1recipientaddress"));
  assert.equal(await call("openMeta", { network: "mainnet", bytes: call.bytes(sealed) }), text);
  await assert.rejects(call("openMeta", { network: "testnet", bytes: call.bytes(sealed) }));
  // Another session of the same wallet opens it; another wallet does not.
  const again = await loadWorker();
  await again("openFile", { bytes: again.bytes(created.sealed), password: PASSWORD });
  assert.equal(await again("openMeta", { network: "mainnet", bytes: again.bytes(sealed) }), text);
  const other = await loadWorker();
  await other("importHex", { text: "22".repeat(32), kind: "seed", password: PASSWORD });
  await assert.rejects(other("openMeta", { network: "mainnet", bytes: other.bytes(sealed) }));
  // Locked: nothing to seal with.
  await call("lock", {});
  await assert.rejects(call("sealMeta", { network: "mainnet", text }), /locked/);
});

// SEC-07: the shipped module refuses a plan offering the same slot twice.
test("plan: the same slot twice is refused", async () => {
  const call = await loadWorker();
  const u = { slot_index: 5, value: "600000", creation_id: "7" };
  const json = JSON.stringify({ utxos: [u, u], amount: "100000", fee: null, active_slot_count: "100", log_slots: 24, relay_floor: "0" });
  await assert.rejects(call("plan", { json }), /twice/);
});
