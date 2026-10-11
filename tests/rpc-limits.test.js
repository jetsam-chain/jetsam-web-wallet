// A hostile RPC cannot make the page swallow an unbounded answer, nest JSON
// until the parser overflows, or send a request body larger than allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRpc, RpcError, MAX_RESPONSE_BYTES } from "../js/rpc.js";
import { parseJson, MAX_DEPTH } from "../js/bigjson.js";

const noSleep = { sleep: async () => {}, minGapMs: 0 };

function streamResponse(chunks, headers = {}) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[i++]) };
            return { done: true, value: undefined };
          },
          async cancel() { i = chunks.length; },
        };
      },
    },
  };
}

test("an oversized answer is refused while streaming", async () => {
  const big = "x".repeat(1024 * 1024);
  const chunks = Array.from({ length: Math.ceil(MAX_RESPONSE_BYTES / big.length) + 2 }, () => big);
  const rpc = createRpc({ url: "https://rpc.example", fetch: async () => streamResponse(chunks), ...noSleep });
  await assert.rejects(rpc.call("getSlotsByOwner", ["j1"]), (e) => e instanceof RpcError && e.kind === "too_large");
});

test("a declared Content-Length over the limit is refused before reading", async () => {
  let read = false;
  const resp = streamResponse(["{}"], { "content-length": String(MAX_RESPONSE_BYTES + 1) });
  const orig = resp.body.getReader;
  resp.body.getReader = () => { read = true; return orig(); };
  const rpc = createRpc({ url: "https://rpc.example", fetch: async () => resp, ...noSleep });
  await assert.rejects(rpc.call("blockCount"), (e) => e.kind === "too_large");
  assert.equal(read, false);
});

test("a normal streamed answer still parses exactly", async () => {
  const rpc = createRpc({
    url: "https://rpc.example",
    fetch: async () => streamResponse(['{"jsonrpc":"2.0","id":1,"result":{"creation_id":922337203', '6854807145}}']),
    ...noSleep,
  });
  const r = await rpc.call("x");
  assert.equal(r.creation_id, 9223372036854807145n);
});

test("deep nesting is refused, not a stack overflow", () => {
  assert.ok(MAX_DEPTH >= 16 && MAX_DEPTH <= 128);
  const deep = "[".repeat(MAX_DEPTH + 1) + "]".repeat(MAX_DEPTH + 1);
  assert.throws(() => parseJson(deep), /deep/);
  const fine = "[".repeat(MAX_DEPTH) + "]".repeat(MAX_DEPTH);
  assert.doesNotThrow(() => parseJson(fine));
});

test("a request body over the caller's limit is not sent", async () => {
  let sent = false;
  const rpc = createRpc({ url: "https://rpc.example", fetch: async () => { sent = true; return streamResponse(["{}"]); }, ...noSleep });
  await assert.rejects(rpc.call("submitTxIntent", ["ab".repeat(400_000)], { maxBodyBytes: 600_000 }), (e) => e.kind === "too_large");
  assert.equal(sent, false);
});
