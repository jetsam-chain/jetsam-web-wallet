// Guarantees about what ships, checked on the files themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { NETWORKS, secondSource } from "../js/networks.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
// The public read-only RPCs (mainnet, testnet), then the wallet RPC (sending).
const RPC = ["https://rpc.jetsamchain.com", "https://rpc-testnet.jetsamchain.com", "https://wallet-rpc.jetsamchain.com"];

function codeFiles() {
  const files = ["worker/keyworker.js"];
  for (const f of readdirSync(new URL("js/", root))) if (f.endsWith(".js")) files.push("js/" + f);
  return files;
}

function shippedText() {
  const files = ["index.html", "css/app.css", "wasm/jetsam_wallet_wasm.js", ...codeFiles()];
  return files.map((f) => [f, read(f)]);
}

function cspOf(html) {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, "CSP meta present");
  const out = {};
  for (const part of m[1].split(";")) {
    const [k, ...v] = part.trim().split(/\s+/);
    if (k) out[k] = v;
  }
  return out;
}

test("CSP: nothing allowed by default, the RPC endpoints are the only network peers", () => {
  const csp = cspOf(read("index.html"));
  assert.deepEqual(csp["default-src"], ["'none'"]);
  // 'wasm-unsafe-eval' lets the key worker compile the wallet core; it does
  // not allow eval() or new Function() of JavaScript.
  assert.deepEqual(csp["script-src"], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(csp["worker-src"], ["'self'"]);
  assert.deepEqual(csp["style-src"], ["'self'"]);
  assert.deepEqual(csp["font-src"], ["'self'"]);
  assert.deepEqual(csp["img-src"], ["'self'"]);
  assert.deepEqual(csp["connect-src"], RPC);
  assert.deepEqual(csp["base-uri"], ["'none'"]);
  assert.deepEqual(csp["form-action"], ["'none'"]);
});

test("networks: both send through the wallet RPC and cross-check with their public RPC", () => {
  assert.equal(NETWORKS.testnet.rpc, "https://wallet-rpc.jetsamchain.com");
  assert.equal(NETWORKS.testnet.reference, "https://rpc-testnet.jetsamchain.com");
  assert.equal(NETWORKS.testnet.genesis, "d9d156ee35e725cf6b133216809c1b0f165d1120c9cf42cc2bfeb0ef9031ee85");
  // The wallet RPC serves the mainnet (12/10/2026); payments are looked up
  // on the public RPC too (SEC3-01).
  assert.equal(NETWORKS.mainnet.rpc, "https://wallet-rpc.jetsamchain.com");
  assert.equal(NETWORKS.mainnet.reference, "https://rpc.jetsamchain.com");
  // Every endpoint a network may use is allowed by both CSPs, including the
  // wallet RPC for mainnet: the switch is the `rpc` line alone.
  const connect = cspOf(read("index.html"))["connect-src"];
  for (const n of Object.values(NETWORKS)) {
    assert.ok(connect.includes(n.rpc), n.id + " rpc in connect-src");
    assert.ok(connect.includes(n.reference), n.id + " reference in connect-src");
  }
});

// SEC3-01: the public RPC is a second source only when it is not the
// endpoint in use (the default, or a custom URL set to the public RPC).
test("networks: the second source is the public RPC, none when it is the endpoint in use", () => {
  assert.equal(secondSource("mainnet", NETWORKS.mainnet.rpc), "https://rpc.jetsamchain.com");
  assert.equal(secondSource("mainnet", "https://my-node.example"), "https://rpc.jetsamchain.com");
  assert.equal(secondSource("mainnet", "https://rpc.jetsamchain.com"), null);
  assert.equal(secondSource("testnet", "https://rpc-testnet.jetsamchain.com"), null);
  assert.equal(secondSource("testnet", NETWORKS.testnet.rpc), "https://rpc-testnet.jetsamchain.com");
});

test("no inline script, inline style or inline handler in the page", () => {
  const html = read("index.html");
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\bsrc="/, "script without src");
  assert.doesNotMatch(html, /<style\b/);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /\son[a-z]+="/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
});

test("no external resource: the only absolute URLs are the RPC endpoints", () => {
  for (const [f, src] of shippedText()) {
    for (const m of src.matchAll(/\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)<;]*/gi)) {
      const url = m[0];
      if (url.startsWith("//")) assert.fail(f + ": protocol-relative URL " + url);
      const allowed = RPC.some((r) => url === r || url.startsWith(r + "/")) || url === "http://www.w3.org/2000/svg";
      assert.ok(allowed, f + ": unexpected URL " + url);
    }
    assert.doesNotMatch(src, /@import|googleapis|gstatic|cdnjs|jsdelivr|unpkg/i, f);
  }
});

test("no price or return promise in shipped files", () => {
  for (const [f, src] of shippedText()) {
    assert.doesNotMatch(src, /\bprice\b|\busd\b|\byield\b|\bapy\b|\broi\b/i, f);
  }
});

test("single-file build: one HTML, hashed inline code, still no external resource", () => {
  const dir = mkdtempSync(join(tmpdir(), "jww-build-"));
  try {
    const out = join(dir, "wallet.html");
    execFileSync(process.execPath, [new URL("tools/build-single.mjs", root).pathname, out]);
    const html = readFileSync(out, "utf8");
    const csp = cspOf(html);
    assert.deepEqual(csp["default-src"], ["'none'"]);
    assert.deepEqual(csp["connect-src"], RPC);

    const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 1, "one inline module");
    assert.equal(styles.length, 1, "one inline stylesheet");
    const sha = (s) => "'sha256-" + createHash("sha256").update(s, "utf8").digest("base64") + "'";
    assert.deepEqual(csp["script-src"], [sha(scripts[0]), "'wasm-unsafe-eval'"]);
    assert.deepEqual(csp["worker-src"], ["blob:"]);
    // Worker source and module bytes ship as inert data blocks.
    const data = [...html.matchAll(/<script type="application\/octet-stream" id="([a-z0-9-]+)">([\s\S]*?)<\/script>/g)];
    assert.deepEqual(data.map((m) => m[1]), ["jww-worker-src", "jww-wasm-b64"]);
    const wasmBytes = Buffer.from(data[1][2], "base64");
    const recorded = read("wasm/SOURCE.txt").match(/([0-9a-f]{64})  jetsam_wallet_wasm_bg\.wasm/)[1];
    assert.equal(createHash("sha256").update(wasmBytes).digest("hex"), recorded, "embedded module is the recorded one");
    assert.ok(readFileSync(out + ".sha256", "utf8").startsWith(createHash("sha256").update(html, "utf8").digest("hex")));
    assert.deepEqual(csp["style-src"], [sha(styles[0])]);
    assert.deepEqual(csp["font-src"], ["data:"]);

    assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/);
    assert.doesNotMatch(html, /<link\b[^>]*rel="stylesheet"/);
    assert.doesNotMatch(scripts[0], /^\s*import\s/m);
    assert.doesNotMatch(scripts[0], /^\s*export\s/m);

    // The bundle must at least be valid module syntax.
    const js = join(dir, "bundle.mjs");
    execFileSync("sh", ["-c", 'cat > "$1"', "sh", js], { input: scripts[0] });
    execFileSync(process.execPath, ["--check", js]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wasm/ holds exactly the module and glue recorded in SOURCE.txt", () => {
  const source = read("wasm/SOURCE.txt");
  assert.match(source, /^Source: jetsam repository, commit [0-9a-f]{40}$/m);
  for (const f of ["jetsam_wallet_wasm_bg.wasm", "jetsam_wallet_wasm.js"]) {
    const m = source.match(new RegExp("([0-9a-f]{64})  " + f.replace(/\./g, "\\.")));
    assert.ok(m, f + " recorded");
    const bytes = readFileSync(new URL("wasm/" + f, root));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), m[1], f);
  }
});

test("no HTML injection sink, no eval, no logging, no locale clock in the code", () => {
  for (const f of codeFiles()) {
    const src = read(f);
    assert.doesNotMatch(src, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/, f);
    assert.doesNotMatch(src, /\beval\(|new Function\(|setTimeout\(\s*["'`]/, f);
    assert.doesNotMatch(src, /\bconsole\./, f + ": nothing is logged");
    assert.doesNotMatch(src, /toLocale|getHours\(|getMinutes\(/, f + ": UTC only");
  }
});

test("the secret never goes to localStorage, the URL, the clipboard or a log", () => {
  for (const f of ["js/wallet.js", "js/send.js", "js/keyclient.js", "worker/keyworker.js", "js/secretcanvas.js", "js/vault.js"]) {
    const src = read(f);
    assert.doesNotMatch(src, /localStorage|sessionStorage|location\.(hash|search|href)\s*=|history\.(push|replace)State|clipboard/, f);
  }
  // The key worker posts back only what its handlers return; the only
  // handlers returning secret material are the sealed copy made at creation
  // or import, and reveal (once per grant).
  const worker = read("worker/keyworker.js");
  assert.match(worker, /need\(revealGrants > 0/);
  assert.equal((worker.match(/revealHex\(\)/g) || []).length, 1);
  // SEC-01: no command compares guesses with the secret, and sealing under a
  // password is not a command of its own.
  assert.doesNotMatch(worker + read("wasm/jetsam_wallet_wasm.js"), /checkHexFragment|checkGroups/);
  assert.doesNotMatch(worker, /^\s*seal\(/m);
  assert.equal((worker.match(/\.seal\(/g) || []).length, 3, "generate, importHex, openFile with newPassword");
});

test("secret and password inputs: masked, no spellcheck service", () => {
  const html = read("index.html");
  // The pasted secret: masked text, so no password manager saves and syncs it.
  const hex = html.match(/<input id="open-hex"[^>]*>/)[0];
  assert.match(hex, /type="text"/);
  assert.match(hex, /class="masked"/);
  assert.match(hex, /autocomplete="off"/);
  assert.match(hex, /spellcheck="false"/);
  assert.match(read("css/app.css"), /\.masked \{\s*-webkit-text-security: disc;/);
  for (const id of ["open-file-pass", "unlock-password", "create-pw1", "create-pw2", "open-pw1", "open-pw2", "ws-password"]) {
    const m = html.match(new RegExp('<input id="' + id + '"[^>]*>'));
    assert.ok(m, id);
    assert.match(m[0], /type="password"/, id);
    assert.match(m[0], /spellcheck="false"/, id);
  }
});

// SEC-10: the secret's canvas offers no "Copy image" / "Save image as"
// (context menu blocked) and cannot be dragged out; a risk reduction only.
test("secret canvases: no context menu, not draggable, not selectable", () => {
  const html = read("index.html");
  for (const id of ["secret-canvas", "ws-canvas"]) {
    const m = html.match(new RegExp('<canvas id="' + id + '"[^>]*>'));
    assert.ok(m, id);
    assert.match(m[0], /draggable="false"/, id);
    assert.match(m[0], /class="[^"]*\bsecret-pixels\b/, id);
  }
  assert.match(read("css/app.css"), /\.secret-pixels \{[^}]*user-select: none;[^}]*-webkit-user-drag: none;/);
  assert.match(read("js/secretcanvas.js"), /addEventListener\("contextmenu"[\s\S]{0,80}preventDefault\(\)/);
  assert.match(read("js/wallet.js"), /guardCanvas\(\$\("secret-canvas"\)\)[\s\S]*guardCanvas\(\$\("ws-canvas"\)\)|guardCanvas\(\$\("ws-canvas"\)\)[\s\S]*guardCanvas\(\$\("secret-canvas"\)\)/);
});
