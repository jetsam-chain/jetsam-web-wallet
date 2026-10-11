#!/usr/bin/env node
// Build the single-file edition: one self-contained HTML (fonts, icon, CSS,
// JS, the key worker and the wallet core's WebAssembly inlined) that works
// offline from disk. No network, no dependency. This file is what ships: its
// SHA-256 is printed and written next to it.
//
//   node tools/build-single.mjs [out.html]     (default: dist/jetsam-web-wallet.html)
//
// The inline script and stylesheet are allowed by their SHA-256 in the CSP, so
// nothing but those two blocks may run or style the page, and the RPC
// endpoints are the only peers. The key worker's source and the module bytes
// sit in non-executing <script type="application/octet-stream"> blocks; the
// worker starts from a blob: URL (worker-src blob:) and inherits this policy,
// and the module is compiled under 'wasm-unsafe-eval' (no eval of JavaScript).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] || join(root, "dist", "jetsam-web-wallet.html"));
const read = (p) => readFileSync(join(root, p), "utf8");
const b64 = (p) => readFileSync(join(root, p)).toString("base64");
const sha = (s) => "'sha256-" + createHash("sha256").update(s, "utf8").digest("base64") + "'";

// ---- JS: concatenate the ES modules in dependency order -------------------
const IMPORT_RE = /^import\s+\{[^}]*\}\s+from\s+"\.\/([a-z0-9-]+\.js)";\s*$/gm;
const order = [];
const seen = new Set();
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = read("js/" + file);
  for (const m of src.matchAll(IMPORT_RE)) visit(m[1]);
  order.push(file);
}
visit("app.js");

const topNames = new Map();
const parts = [];
for (const file of order) {
  let src = read("js/" + file).replace(IMPORT_RE, "");
  if (/^\s*import\s/m.test(src)) throw new Error(file + ": unsupported import form");
  if (/^export\s+(default|\{|\*)/m.test(src)) throw new Error(file + ": unsupported export form");
  src = src.replace(/^export\s+(?=(async\s+)?function\b|const\b|let\b|class\b)/gm, "");
  for (const m of src.matchAll(/^(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)/gm)) {
    if (topNames.has(m[1])) throw new Error("name clash: " + m[1] + " in " + file + " and " + topNames.get(m[1]));
    topNames.set(m[1], file);
  }
  parts.push("// ---- " + file + "\n" + src.trim() + "\n");
}
const script = "\n" + parts.join("\n");
if (/<\/script/i.test(script)) throw new Error("bundle contains </script");

// ---- Key worker: wasm glue + worker, and the module bytes -----------------
const glue = read("wasm/jetsam_wallet_wasm.js");
const workerSrc = "\n" + glue + "\n" + read("worker/keyworker.js");
for (const [name, text] of [["worker source", workerSrc]]) {
  if (/<\/script/i.test(text) || /<!--/.test(text)) throw new Error(name + " contains </script or <!--");
}
const wasmB64 = b64("wasm/jetsam_wallet_wasm_bg.wasm");

// ---- CSS: fonts become data: URIs -----------------------------------------
const css =
  "\n" +
  read("css/app.css").replace(/url\("\.\.\/fonts\/([a-z0-9-]+\.woff2)"\)/g, (_, f) => 'url("data:font/woff2;base64,' + b64("fonts/" + f) + '")');
if (/url\("\.\.\//.test(css)) throw new Error("unresolved relative url() in CSS");
if (/<\/style/i.test(css)) throw new Error("stylesheet contains </style");

// ---- HTML -------------------------------------------------------------------
let html = read("index.html");
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error("index.html: missing " + from);
  html = html.replace(from, () => to);
};
swap('<link rel="stylesheet" href="css/app.css">', "<style>" + css + "</style>");
swap(
  '<script type="module" src="js/app.js"></script>',
  '<script type="application/octet-stream" id="jww-worker-src">' + workerSrc + "</script>\n" +
    '<script type="application/octet-stream" id="jww-wasm-b64">' + wasmB64 + "</script>\n" +
    '<script type="module">' + script + "</script>",
);
swap('href="favicon.svg"', 'href="data:image/svg+xml;base64,' + b64("favicon.svg") + '"');

const cspRe = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/;
const m = html.match(cspRe);
if (!m) throw new Error("index.html: no CSP");
const csp = m[1]
  .replace("script-src 'self'", "script-src " + sha(script))
  .replace("worker-src 'self'", "worker-src blob:")
  .replace("style-src 'self'", "style-src " + sha(css))
  .replace("font-src 'self'", "font-src data:")
  .replace("img-src 'self'", "img-src data:");
html = html.replace(cspRe, () => '<meta http-equiv="Content-Security-Policy" content="' + csp + '">');

if (!csp.includes("'wasm-unsafe-eval'") || !csp.includes("worker-src blob:")) throw new Error("CSP not adapted for the worker");

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
const digest = createHash("sha256").update(html, "utf8").digest("hex");
writeFileSync(out + ".sha256", digest + "  " + basename(out) + "\n");
// The same policy as an HTTP header, which can also forbid framing (a <meta>
// policy cannot): see DEPLOY-HEADERS.md.
writeFileSync(out + ".csp", csp + "; frame-ancestors 'none'\n");
console.log(out + "  " + Buffer.byteLength(html) + " bytes  (" + order.join(", ") + ")");
console.log("sha256 " + digest);
