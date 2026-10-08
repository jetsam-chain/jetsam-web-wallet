// Test helper (Node): the wallet core's wasm, to read what a test needs from
// a backup the page produced. Throw-away test wallets only.
//   node keytool.cjs reveal <wallet.key> <password>      -> 64 hex
//   node keytool.cjs addresses <hex> <seed|spend> <network> <start> <count>
const path = require("path");
const fs = require("fs");
const pkg = process.env.JETSAM_WASM_NODE_PKG;
const w = require(path.join(pkg, "jetsam_wallet_wasm.js"));
const [cmd, ...a] = process.argv.slice(2);
if (cmd === "reveal") {
  const key = w.WalletKey.fromKeyfile(fs.readFileSync(a[0]), a[1]);
  process.stdout.write(Buffer.from(key.revealHex()).toString("ascii"));
  key.free();
} else if (cmd === "addresses") {
  const key = w.WalletKey.fromHex(a[0], a[1]);
  process.stdout.write(key.addresses(Number(a[3]), Number(a[4]), a[2]));
  key.free();
} else {
  throw new Error("unknown command");
}
