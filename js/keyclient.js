// The page's side of the key worker (worker/keyworker.js).
//
// One worker per unlocked session. Requests are promises; terminating the
// worker (lock, cancel of a proof) rejects whatever is pending and drops the
// secret with the worker's whole memory.
//
// Single-file edition: the worker source (wasm glue + worker) and the module
// bytes are embedded in non-executing <script type="application/octet-stream">
// blocks; the worker starts from a blob: URL (CSP worker-src blob:) and gets
// the module bytes in its init message. Multi-file page: the worker is
// worker/keyworker.js and fetches ../wasm/ itself.

export class KeyWorkerError extends Error {
  constructor(message, { cancelled = false } = {}) {
    super(message);
    this.name = "KeyWorkerError";
    this.cancelled = cancelled;
  }
}

function base64Bytes(text) {
  const bin = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

function spawn() {
  const src = document.getElementById("jww-worker-src");
  const bytes = document.getElementById("jww-wasm-b64");
  if (src && bytes) {
    const url = URL.createObjectURL(new Blob([src.textContent], { type: "text/javascript" }));
    const worker = new Worker(url, { name: "jetsam-key" });
    return { worker, url, wasm: base64Bytes(bytes.textContent).buffer };
  }
  return { worker: new Worker("worker/keyworker.js", { name: "jetsam-key" }), url: null, wasm: null };
}

export function createKeyClient() {
  let seq = 0;
  let dead = false;
  const waiting = new Map();
  const { worker, url, wasm } = spawn();

  worker.onmessage = (event) => {
    const { id, ok, result, error } = event.data || {};
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    if (ok) w.resolve(result);
    else w.reject(new KeyWorkerError(String(error || "key worker error")));
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fail(new KeyWorkerError("The key worker stopped unexpectedly"));
  };

  function fail(err) {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  }

  function call(cmd, arg, transfer) {
    if (dead) return Promise.reject(new KeyWorkerError("The wallet is locked", { cancelled: true }));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, arg }, transfer || []);
    });
  }

  function terminate(reason) {
    if (dead) return;
    dead = true;
    worker.terminate();
    if (url) URL.revokeObjectURL(url);
    fail(new KeyWorkerError(reason || "The wallet is locked", { cancelled: true }));
  }

  const ready = call("init", wasm ? { wasm } : {}, wasm ? [wasm] : []);

  return {
    ready,
    get alive() { return !dead; },
    call: (cmd, arg, transfer) => ready.then(() => call(cmd, arg, transfer)),
    /** Zeroize in the worker (best effort, 500 ms), then end it. */
    async lock() {
      if (dead) return;
      const timer = new Promise((r) => setTimeout(r, 500));
      await Promise.race([call("lock", {}).catch(() => {}), timer]);
      terminate("The wallet is locked");
    },
    /** End now: the only way to stop a proof in progress. */
    terminate,
  };
}
