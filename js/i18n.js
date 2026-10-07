// User-facing text. English only for now; other languages are added as more
// keys of STRINGS (same keys, translated values) and a language picker.

export const STRINGS = {
  en: {
    "a11y.skip": "Skip to content",
    "brand.tag": "watch-only wallet",

    "net.label": "Network",
    "net.mainnet": "Mainnet",
    "net.testnet": "Testnet",

    "chain.connecting": "Connecting…",
    "chain.height": "block {height}",
    "chain.unreachable": "RPC unreachable",
    "chain.genesis_mismatch": "This RPC does not serve the {network} this page knows (genesis {hash}…). Balances below come from that other chain.",

    "theme.toggle": "Switch between light and dark theme",
    "settings.open": "Settings",

    "balance.kicker": "Held by your watched addresses",
    "balance.none": "Add an address to see its balance",
    "balance.outputs.one": "1 unspent output",
    "balance.outputs.other": "{n} unspent outputs",
    "balance.addresses.one": "on 1 address",
    "balance.addresses.other": "across {n} addresses",
    "balance.provisional": "of which {amount} JTM provisional",
    "balance.failed.one": "1 address could not be read",
    "balance.failed.other": "{n} addresses could not be read",
    "balance.loading": "reading…",
    "balance.updated": "Updated {time}",

    "action.refresh": "Refresh",
    "action.refreshing": "Reading…",
    "action.close": "Close",
    "action.save": "Save",

    "addr.title": "Watched addresses",
    "addr.add_label": "Add an address to watch",
    "addr.placeholder": "j1…",
    "addr.add": "Watch",
    "addr.empty": "No address yet. Paste one of your addresses above — nothing else is needed, and no key is ever asked for.",
    "addr.checking": "Checking with the node…",
    "addr.added": "Added.",
    "addr.added_unchecked": "Added. The checksum is valid; the node could not confirm it ({reason}).",
    "addr.reading": "Reading…",
    "addr.show": "Outputs",
    "addr.receive": "Receive",
    "addr.remove": "Remove",
    "addr.remove_confirm": "Remove?",
    "addr.remove_label": "Stop watching {address}",
    "addr.stored": "The list is kept in this browser only. Removing an address here does not touch its funds.",
    "addr.not_stored": "This browser does not allow storage: the list will be forgotten when the page closes.",
    "addr.err.empty": "Paste an address first.",
    "addr.err.mixed_case": "An address is all lowercase (or all uppercase), never mixed.",
    "addr.err.format": "This is not a Jetsam address.",
    "addr.err.checksum": "The checksum does not match: a character is wrong or missing. Copy it again from your wallet.",
    "addr.err.unknown_prefix": "This is not a Jetsam address: it should start with j1 (mainnet) or tj1 (testnet).",
    "addr.err.length": "This address has the wrong length.",
    "addr.err.other_network": "This is a {network} address. Switch the network at the top to watch it.",
    "addr.err.duplicate": "Already watched.",
    "addr.err.too_many": "At most {n} addresses per network.",
    "addr.err.node_rejects": "The node does not accept this address.",

    "tabs.label": "Wallet views",
    "tabs.outputs": "Outputs",
    "tabs.receive": "Receive",
    "tabs.send": "Send",

    "outputs.lede": "Every unspent output your addresses hold. Their sum is the balance above.",
    "outputs.caption": "Unspent outputs",
    "outputs.show_all": "Show all addresses",
    "outputs.filtered": "Showing {address} only.",
    "outputs.no_address": "No address watched yet.",
    "outputs.none": "No unspent output: the balance is zero.",
    "outputs.loading": "Reading outputs…",
    "outputs.unavailable": "Outputs could not be read. Try Refresh.",
    "outputs.more": "Show {n} more ({left} left)",
    "outputs.provisional_note": "Provisional: fewer than 8 blocks deep. A chain reorganisation can still undo it; after 8 blocks it is final.",

    "col.amount": "Amount (JTM)",
    "col.height": "Block",
    "col.confirmations": "Confirmations",
    "col.kind": "Origin",
    "col.slot": "Slot",
    "col.address": "Address",

    "utxo.count.one": "1 output",
    "utxo.count.other": "{n} outputs",
    "utxo.mined": "Mined",
    "utxo.received": "Received",
    "utxo.provisional": "Provisional",
    "utxo.final": "Final",
    "utxo.resolving": "finding…",

    "receive.pick": "Address to share",
    "receive.copy": "Copy address",
    "receive.copied": "Copied.",
    "receive.copy_failed": "Copy failed: select the address and copy it by hand.",
    "receive.empty": "Add an address first. This page never creates addresses: it has no keys.",
    "receive.qr_title": "QR code of {address}",
    "receive.note": "Only {network} JTM can be sent to this address. Check the first and last characters with the sender.",

    "send.title": "Sending arrives in a later version",
    "send.body1": "On Jetsam, spending is not a signature: your device must compute a zero-knowledge proof that it knows the secret behind the address. That proof engine is not in this page yet, so this version only reads.",
    "send.body2": "To send today, use the Jetsam desktop wallet or the node's command line, on a machine that holds your wallet file.",
    "send.body3": "This page never asks for a secret, a key or a wallet file. If a page that looks like this one does, close it.",

    "foot.readonly": "Read-only. No keys, no signing, nothing to steal here.",
    "foot.privacy": "Jetsam is a transparent chain. Each lookup tells the RPC operator which address was asked about; point Settings to a proxy you run if that matters to you.",
    "foot.rpc": "RPC: {url}",

    "settings.title": "Settings",
    "settings.rpc_legend": "RPC endpoint — {network}",
    "settings.rpc_default": "Public endpoint ({url})",
    "settings.rpc_custom": "My own RPC proxy",
    "settings.rpc_url": "RPC URL",
    "settings.rpc_help": "A bare node refuses browser requests; it has to sit behind a proxy that allows them, like the public one. This page's security policy only lets it talk to the two public endpoints: for any other URL, edit connect-src in the page's Content-Security-Policy first (see README).",
    "settings.storage": "This browser",
    "settings.storage_on.one": "1 {network} address remembered in this browser.",
    "settings.storage_on.other": "{n} {network} addresses remembered in this browser.",
    "settings.storage_off": "Storage is not available here: nothing is remembered.",
    "settings.forget": "Forget the addresses of this network",
    "settings.forget_confirm.one": "Click again to forget 1 address",
    "settings.forget_confirm.other": "Click again to forget {n} addresses",

    "rpc.url_invalid": "That is not a URL.",
    "rpc.url_scheme": "Use https:// (plain http:// only for 127.0.0.1 or localhost).",
    "rpc.url_credentials": "No user name or password in the URL.",

    "error.network": "The RPC could not be reached.",
    "error.timeout": "The RPC did not answer in time.",
    "error.http": "The RPC answered with HTTP {status}.",
    "error.parse": "The RPC sent an answer this page cannot read.",
    "error.method": "The RPC refused: {message}",
    "error.generic": "Something went wrong: {message}",
    "error.csp": "Blocked by this page's Content-Security-Policy: the RPC URL is not in connect-src. Add it there, or go back to the public endpoint in Settings.",
  },
};

let lang = "en";

/** Look up a string and fill {placeholders}. Unknown keys come back as-is. */
export function t(key, vars) {
  const table = STRINGS[lang] || STRINGS.en;
  let s = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : STRINGS.en[key];
  if (s === undefined) return key;
  if (vars) s = s.replace(/\{([a-z_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** Plural form: key + ".one" when n is 1, key + ".other" otherwise; {n} is filled. */
export function tp(key, n, vars = {}) {
  const count = typeof n === "bigint" ? n : BigInt(n);
  return t(key + (count === 1n ? ".one" : ".other"), { n: vars.n !== undefined ? vars.n : String(n), ...vars });
}

/** Fill data-i18n (text), data-i18n-placeholder and data-i18n-aria-label. */
export function applyI18n(root) {
  for (const n of root.querySelectorAll("[data-i18n]")) n.textContent = t(n.getAttribute("data-i18n"));
  for (const n of root.querySelectorAll("[data-i18n-placeholder]")) n.setAttribute("placeholder", t(n.getAttribute("data-i18n-placeholder")));
  for (const n of root.querySelectorAll("[data-i18n-aria-label]")) n.setAttribute("aria-label", t(n.getAttribute("data-i18n-aria-label")));
  if (root.documentElement) root.documentElement.lang = lang;
}
