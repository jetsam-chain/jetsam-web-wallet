import { test } from "node:test";
import assert from "node:assert/strict";
import { createRpc, checkRpcUrl, RpcError, describeRpcError } from "../js/rpc.js";

function fakeFetch(responder) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (url, init) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ url, init, body: JSON.parse(init.body) });
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return responder(calls.at(-1));
  };
  fn.calls = calls;
  fn.maxInFlight = () => maxInFlight;
  return fn;
}

const ok = (text, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => text });

test("sends a JSON-RPC 2.0 POST with the jetsam_ prefix and no credentials", async () => {
  const f = fakeFetch(() => ok('{"jsonrpc":"2.0","id":1,"result":32545}'));
  const rpc = createRpc({ url: "https://rpc.jetsamchain.com", fetch: f, minGapMs: 0 });
  const r = await rpc.call("blockCount");
  assert.equal(r, 32545n);
  const c = f.calls[0];
  assert.equal(c.url, "https://rpc.jetsamchain.com");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.credentials, "omit");
  assert.equal(c.init.referrerPolicy, "no-referrer");
  assert.equal(c.init.headers["Content-Type"], "application/json");
  assert.deepEqual(c.body, { jsonrpc: "2.0", id: 1, method: "jetsam_blockCount", params: [] });
});

test("big integers in results survive (parsed as text, not JSON.parse)", async () => {
  const f = fakeFetch(() => ok('{"jsonrpc":"2.0","id":1,"result":[{"creation_id":9223372036854775809}]}'));
  const rpc = createRpc({ url: "https://x.example", fetch: f, minGapMs: 0 });
  const r = await rpc.call("getSlotsByOwner", ["j1..."]);
  assert.equal(r[0].creation_id, 9223372036854775809n);
});

test("method errors surface as RpcError kind=method with the server message", async () => {
  const f = fakeFetch(() => ok('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not allowed: getSlot"}}'));
  const rpc = createRpc({ url: "https://x.example", fetch: f, minGapMs: 0 });
  await assert.rejects(rpc.call("getSlot", [1]), (e) => {
    assert.ok(e instanceof RpcError);
    assert.equal(e.kind, "method");
    assert.equal(e.code, -32601n);
    assert.match(e.message, /method not allowed/);
    return true;
  });
});

test("HTTP errors and network errors are told apart", async () => {
  const f413 = fakeFetch(() => ok("error code: 502", 502));
  await assert.rejects(createRpc({ url: "https://x.example", fetch: f413, minGapMs: 0 }).call("a"),
    (e) => e.kind === "http" && e.status === 502);
  const dead = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(createRpc({ url: "https://x.example", fetch: dead, minGapMs: 0 }).call("a"),
    (e) => e.kind === "network");
  const junk = fakeFetch(() => ok("<html>"));
  await assert.rejects(createRpc({ url: "https://x.example", fetch: junk, minGapMs: 0 }).call("a"),
    (e) => e.kind === "parse");
});

test("requests are strictly serial and spaced", async () => {
  const f = fakeFetch((c) => ok('{"jsonrpc":"2.0","id":' + c.body.id + ',"result":null}'));
  const sleeps = [];
  let clock = 0;
  const rpc = createRpc({
    url: "https://x.example",
    fetch: f,
    minGapMs: 250,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  await Promise.all([rpc.call("a"), rpc.call("b"), rpc.call("c")]);
  assert.equal(f.maxInFlight(), 1);
  assert.deepEqual(f.calls.map((c) => c.body.method), ["jetsam_a", "jetsam_b", "jetsam_c"]);
  assert.deepEqual(sleeps, [250, 250]);
  assert.equal(rpc.count(), 3);
});

test("one failure does not jam the queue", async () => {
  let n = 0;
  const f = fakeFetch(() => (++n === 1 ? ok("nope", 500) : ok('{"jsonrpc":"2.0","id":2,"result":7}')));
  const rpc = createRpc({ url: "https://x.example", fetch: f, minGapMs: 0 });
  const [a, b] = await Promise.allSettled([rpc.call("a"), rpc.call("b")]);
  assert.equal(a.status, "rejected");
  assert.equal(b.value, 7n);
});

test("checkRpcUrl: https anywhere, plain http only on this machine", () => {
  assert.deepEqual(checkRpcUrl(" https://rpc.jetsamchain.com/ "), { ok: true, url: "https://rpc.jetsamchain.com" });
  assert.equal(checkRpcUrl("https://node.example:8443/rpc").url, "https://node.example:8443/rpc");
  assert.equal(checkRpcUrl("http://127.0.0.1:9702").ok, true);
  assert.equal(checkRpcUrl("http://localhost:9702").ok, true);
  assert.equal(checkRpcUrl("http://[::1]:9702").ok, true);
  assert.equal(checkRpcUrl("http://node.example").ok, false);
  assert.equal(checkRpcUrl("ftp://x").ok, false);
  assert.equal(checkRpcUrl("javascript:alert(1)").ok, false);
  assert.equal(checkRpcUrl("https://user:pw@node.example").ok, false);
  assert.equal(checkRpcUrl("not a url").ok, false);
});

// SEC-08: an RPC can put any text in an error (the audit's: "Re-enter your
// 64-character secret at https://..."). The page names the kind of error and
// a numeric code, never the RPC's own words.
test("describeRpcError: generic text and code, never the RPC's message", async () => {
  const { t } = await import("../js/i18n.js");
  const phish = "Wallet version expired. Re-enter your 64-character secret at https://jetsam-support.example/recover <b>now</b>";
  const said = describeRpcError(new RpcError("method", phish, { code: -32000 }), t);
  assert.match(said, /-32000/);
  for (const word of ["expired", "secret", "jetsam-support", "https", "<b>"]) assert.ok(!said.includes(word), word + " in: " + said);
  const odd = describeRpcError(new RpcError("method", "x", { code: "Re-enter your secret at evil.example" }), t);
  assert.ok(!odd.includes("evil"), odd);
  assert.match(describeRpcError(new RpcError("http", "x", { status: 502 }), t), /502/);
  assert.equal(describeRpcError(new Error("not an RPC error"), t), null);
});
