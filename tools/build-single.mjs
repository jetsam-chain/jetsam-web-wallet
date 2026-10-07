#!/usr/bin/env node
// Build the single-file edition: one self-contained HTML (fonts, icon, CSS and
// JS inlined) that works offline from disk. No network, no dependency.
//
//   node tools/build-single.mjs [out.html]     (default: dist/jetsam-watch-wallet.html)
//
// The inline script and stylesheet are allowed by their SHA-256 in the CSP, so
// the policy stays as strict as the multi-file page: nothing but those two
// blocks may run or style the page, and the RPC endpoints are the only peers.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] || join(root, "dist", "jetsam-watch-wallet.html"));
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
swap('<script type="module" src="js/app.js"></script>', '<script type="module">' + script + "</script>");
swap('href="favicon.svg"', 'href="data:image/svg+xml;base64,' + b64("favicon.svg") + '"');

const cspRe = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/;
const m = html.match(cspRe);
if (!m) throw new Error("index.html: no CSP");
const csp = m[1]
  .replace("script-src 'self'", "script-src " + sha(script))
  .replace("style-src 'self'", "style-src " + sha(css))
  .replace("font-src 'self'", "font-src data:")
  .replace("img-src 'self'", "img-src data:");
html = html.replace(cspRe, () => '<meta http-equiv="Content-Security-Policy" content="' + csp + '">');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(out + "  " + Buffer.byteLength(html) + " bytes  (" + order.join(", ") + ")");
