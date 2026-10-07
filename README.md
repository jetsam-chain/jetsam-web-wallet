# Jetsam Watch Wallet

A watch-only web wallet for Jetsam (JTM). Paste one or more of your addresses
and see what they hold: total and per-address balance, every unspent output
(amount, block, confirmations, mined or received), a receive QR code, and the
chain height.

It has **no keys**. It never asks for a secret, a seed or a wallet file, and it
cannot send. Static HTML, CSS and vanilla JavaScript modules; no dependency, no
build step required, nothing loaded from anywhere but this folder and the RPC.

## Run

Serve the folder on this machine and open it:

    python3 -m http.server 8080 --bind 127.0.0.1
    # then open http://127.0.0.1:8080/

ES modules do not load from `file://`, so the multi-file page needs a local
server. For offline use without a server, build the single-file edition:

    node tools/build-single.mjs            # -> dist/jetsam-watch-wallet.html

That one HTML file (fonts, icon, CSS and JS inlined) opens straight from disk.
The build is deterministic: same sources, same bytes.

## Tests

    node --test tests/*.test.js

Node 18 or newer, no install. The tests cover the exact-integer JSON parser
(on real RPC answers), bech32m address checks (vectors confirmed by both
nodes), amount formatting, output normalisation and finality, the mint-height
search, the RPC client, storage fallbacks, the QR encoder (module for module
against an independent encoder, `tools/gen_qr_reference.py`), the i18n
dictionary, and the page's own guarantees (CSP, no external URL, single-file
build).

## How it reads the chain

| Need | RPC method |
|---|---|
| Height | `getChainInfo` (on refresh), `blockCount` (every 2 min, visible tab only) |
| Right chain? | `getBlockHash(0)` compared with the known genesis |
| Address check | local bech32m checksum, then `validateAddress` |
| Outputs | `getSlotsByOwner(address)` |
| Block of a received output | `getBlockHeader(h).alloc_counter`, searched |

- Answers are parsed as text with every integer kept as a `BigInt`. A coinbase
  output's `creation_id` is `2^63 | height`, which `JSON.parse` would round.
- Amounts are micro-JTM (`1 JTM = 1,000,000 µJTM`), exact end to end.
- A coinbase output carries its block height in `creation_id`. A received output
  carries the chain-wide allocation counter instead; its block is the lowest
  height whose header counter reaches it, found by an interpolation search over
  headers. Found heights that are final are remembered in this browser.
- An output fewer than 8 blocks deep (the consensus finality depth) is marked
  **provisional**: a reorganisation can still undo it.
- Requests go out one at a time, at least 250 ms apart. Balances refresh on load
  and on the Refresh button only.

## Content-Security-Policy

`index.html` carries a strict policy in a `<meta>` tag:

    default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self';
    img-src 'self'; connect-src https://rpc.jetsamchain.com https://rpc-testnet.jetsamchain.com;
    base-uri 'none'; form-action 'none'

The single-file edition keeps the same policy, with the inline script and
stylesheet allowed by their SHA-256 hashes instead of `'self'`.

**Using your own RPC.** Settings accepts another endpoint (https, or plain http
on 127.0.0.1/localhost), but the policy blocks it until you add its origin to
`connect-src` in the page you open (`index.html`, or the built single file). The
page says so when that happens. A bare node refuses any request carrying an
`Origin` header, so a browser cannot talk to it directly: the endpoint must be a
proxy that accepts browser requests (CORS) and forwards JSON-RPC to the node,
like the public one.

## Privacy

Jetsam is a transparent chain. Each lookup tells the RPC operator (and the TLS
front that carries it) which address was asked about, and asking about several
addresses in one session links them together. The page only ever queries the
addresses you add, and sends no cookie and no referrer. If that matters to you,
use a proxy you run yourself.

The address list, theme and network choice are kept in `localStorage` of this
browser only. The page works without storage; it then forgets the list on close.

## Limits of this version

- Read-only: no send, no consolidation, no address creation.
- History is not available from the public RPC: the page shows outputs that are
  still unspent, not those received and later spent.
- The first look at an address with many received outputs costs a few header
  reads per output (about 190 for 33 outputs, under a minute). Later visits use
  the remembered heights. Coinbase outputs cost nothing extra.
- The testnet genesis is pinned in `js/networks.js`; when the testnet is reset,
  the page warns that the RPC serves another chain until that line is updated.
- English only. Strings live in `js/i18n.js`, ready for more languages.

## Roadmap (v1.1)

- Import of an existing wallet secret, kept encrypted in the browser.
- The spend-proof engine compiled to WebAssembly, running in a Web Worker.
- Send: fee estimate, proof on this device, submission, confirmation tracking.

## Files

    index.html            page (CSP, markup)
    css/app.css           styles, light and dark
    js/                   app.js (wiring) + pure modules
    fonts/                Fraunces, Spline Sans, Spline Sans Mono (SIL OFL 1.1, see fonts/LICENSE-OFL.txt)
    tests/                node --test suites and real RPC fixtures
    tools/                single-file build, QR reference generator
