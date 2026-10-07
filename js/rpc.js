// JSON-RPC client for the public Jetsam RPC proxy.
//
// - Responses are parsed as text by bigjson (exact integers).
// - Requests go out one at a time, spaced by `minGapMs`: a watch-only wallet
//   has no reason to hammer a shared public endpoint.
// - No cookies, no referrer.
// The node itself refuses any request carrying an Origin header, so a browser
// can only talk to a proxy (rpc.jetsamchain.com), never to a bare node.

import { parseJson } from "./bigjson.js";

export class RpcError extends Error {
  /** kind: "network" | "http" | "parse" | "method" | "timeout" */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Accept https anywhere, plain http only for this machine. */
export function checkRpcUrl(input) {
  let u;
  try {
    u = new URL(String(input || "").trim());
  } catch (_) {
    return { ok: false, error: "rpc.url_invalid" };
  }
  if (u.username || u.password) return { ok: false, error: "rpc.url_credentials" };
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return { ok: true, url: u.protocol + "//" + u.host + path };
  }
  return { ok: false, error: "rpc.url_scheme" };
}

export function createRpc({
  url,
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  minGapMs = 200,
  timeoutMs = 20000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let seq = 0;
  let lastStart = -Infinity;
  let chain = Promise.resolve();

  async function send(method, params) {
    const wait = lastStart + minGapMs - now();
    if (wait > 0) await sleep(wait);
    lastStart = now();
    const id = ++seq;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method: "jetsam_" + method, params });
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined,
      });
      text = await res.text();
    } catch (e) {
      if (e && e.name === "AbortError") throw new RpcError("timeout", "The RPC did not answer in time");
      throw new RpcError("network", "The RPC could not be reached", { cause: e });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new RpcError("http", "The RPC answered HTTP " + res.status, { status: res.status });
    let msg;
    try {
      msg = parseJson(text);
    } catch (e) {
      throw new RpcError("parse", "The RPC answer is not valid JSON", { cause: e });
    }
    if (!msg || typeof msg !== "object") throw new RpcError("parse", "Unexpected RPC answer");
    if (msg.error) {
      throw new RpcError("method", String(msg.error.message || "RPC error"), { code: msg.error.code });
    }
    if (!("result" in msg)) throw new RpcError("parse", "RPC answer without a result");
    return msg.result;
  }

  let count = 0;
  return {
    url,
    call(method, params = []) {
      count++;
      const p = chain.then(() => send(method, params));
      chain = p.catch(() => {}); // a failure must not jam the queue
      return p;
    },
    count: () => count,
  };
}
