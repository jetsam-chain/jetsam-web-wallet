// JSON-RPC client for the public Jetsam RPC proxy.
//
// - Responses are parsed as text by bigjson (exact integers).
// - Requests go out one at a time, spaced by `minGapMs`: a watch-only wallet
//   has no reason to hammer a shared public endpoint.
// - No cookies, no referrer.
// The node itself refuses any request carrying an Origin header, so a browser
// can only talk to a proxy (rpc.jetsamchain.com), never to a bare node.

import { parseJson } from "./bigjson.js";

/** Largest answer the page reads (a wallet with thousands of outputs fits). */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class RpcError extends Error {
  /** kind: "network" | "http" | "parse" | "method" | "timeout" | "too_large" */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/**
 * What the page says about an RPC failure, through `t` (i18n). Never the
 * RPC's own words: its error text can be anything, including a phishing
 * instruction shown with the wallet's authority (SEC-08). A JSON-RPC error is
 * named by its numeric code only. null when `e` is not an RpcError.
 */
export function describeRpcError(e, t) {
  if (!(e instanceof RpcError)) return null;
  // Answers are parsed by bigjson, so a JSON-RPC code is a BigInt.
  const int = (v) => (typeof v === "bigint" && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
  if (e.kind === "network") return t("error.network");
  if (e.kind === "timeout") return t("error.timeout");
  if (e.kind === "http") return t("error.http", { status: Number.isSafeInteger(e.status) ? e.status : "?" });
  if (e.kind === "parse") return t("error.parse");
  if (e.kind === "too_large") return t("error.too_large");
  const code = int(e.code);
  return t("error.method", { code: Number.isSafeInteger(code) ? code : "?" });
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

  // Read the body with a hard cap: a hostile RPC cannot make the page buffer
  // an unbounded answer. Streams when the platform allows it.
  async function readCapped(res) {
    const declared = res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : null;
    if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
      throw new RpcError("too_large", "The RPC answer is too large");
    }
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch (_) { /* ignore */ }
          throw new RpcError("too_large", "The RPC answer is too large");
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new RpcError("too_large", "The RPC answer is too large");
    return text;
  }

  async function send(method, params, maxBodyBytes) {
    const wait = lastStart + minGapMs - now();
    if (wait > 0) await sleep(wait);
    lastStart = now();
    const id = ++seq;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method: "jetsam_" + method, params });
    if (body.length > maxBodyBytes) throw new RpcError("too_large", "The request is too large to send", { sent: false });
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
      text = await readCapped(res);
    } catch (e) {
      if (e instanceof RpcError) throw e;
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
    /** opts.maxBodyBytes: refuse to send a larger request (default 64 KiB). */
    call(method, params = [], opts = {}) {
      count++;
      const max = opts.maxBodyBytes || 64 * 1024;
      const p = chain.then(() => send(method, params, max));
      chain = p.catch(() => {}); // a failure must not jam the queue
      return p;
    },
    count: () => count,
  };
}
