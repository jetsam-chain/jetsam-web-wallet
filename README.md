# Jetsam Web Wallet

A non-custodial web wallet for Jetsam (JTM). Create a wallet or open the one
your node uses, receive, see balances, and send. The secret is created and kept
in this browser, encrypted with your password; every payment is proven on this
device. Nothing that can spend ever leaves it.

It can also just **watch** addresses (no secret at all), as version 1 did.

One HTML file, no dependency, nothing loaded from anywhere but the RPC.

> Status: tested end to end against a simulated node that runs the real node's
> admission code. **No payment from this page has been made on the testnet or
> the mainnet yet.** Sending needs an RPC that accepts payments
> (`submitTxIntent`). On the testnet the default RPC is the wallet RPC
> (`wallet-rpc.jetsamchain.com`), which does. On the mainnet the default is
> still the public RPC, which does not: the page says so and proves nothing
> there. Read `THREAT_MODEL.md` before trusting it with money.

## How spending works on Jetsam

Jetsam has no signatures. An address is the hash of a 256-bit secret, and a
payment carries a zero-knowledge proof that the sender knows that secret. So
the proof must be computed where the secret is. This page runs the node's own
wallet and proof code (`jetsam_wallet_core`, Rust compiled to WebAssembly) in a
Web Worker:

1. **Review**: recipient (strict bech32m, right network), amount (exact, in
   µJTM), fee (from the RPC, checked against the consensus minimum computed
   locally), change (back to the same address), all on one screen.
2. **Prove** in the worker, with a progress estimate and a Cancel button. A
   proof takes about 10–40 s on a recent laptop (measured: 11 s in Chromium on
   a busy server CPU). Cancel stops the worker, which also locks the wallet.
3. **Submit** to the RPC, after checking the epoch anchor did not change during
   the proof (if it did, the page proves again).
4. **Track** until the payment is final (8 blocks). The payment is recorded
   in this browser *before* it is sent (if that fails, it is not sent), and
   the outputs it spends stay reserved until it is final or its expiry is
   believed, so this browser never tries to spend them twice. What the RPC
   says is checked against what it can be asked: a "refused" answer or a
   reported expiry is looked up by the transaction id computed here before
   any output is offered again — on the configured RPC, and, when that is
   not the network's public RPC (your own RPC, or the testnet's default
   wallet RPC), on the public RPC too (only the txid is sent; on
   by default, can be turned off in Settings). With the public RPC
   configured there is no second source: an expiry then rests on its word
   alone. Paying again a recipient whose earlier payment may still be mined
   asks for an explicit confirmation (`THREAT_MODEL.md` 3.2, 3.9).

## Wallets

- **Create**: 32 bytes from `crypto.getRandomValues`, inside the worker. Before
  any address is shown: an encrypted backup file is downloaded, the 64-hex
  secret is shown once (drawn on a canvas, never as page text), and three
  random groups of it must be typed back.
- **Open**: the 64 hex digits of `jetsam --export-wallet-secret` (or an
  imported spend secret), or a `wallet.key` file — cleartext (48 bytes) or
  encrypted (105 bytes, `jetsam_aead_key1`). There is no word phrase in Jetsam.
- **Stored** in this browser's IndexedDB as the node's encrypted `wallet.key`
  (Argon2id 64 MiB / 3 passes + XChaCha20-Poly1305). The backup file is the
  same format: the node opens it with the same password
  (`JETSAM_WALLET_PASSPHRASE`).
- **Locks** on the Lock button, after 1/5/15/30 minutes without activity
  (default 5), and when a proof is cancelled.
- **Addresses**: the wallet keeps its own list of address indexes. "New
  address" adds the next one; "Look for used addresses" asks the RPC about at
  most three more indexes per click (the node's discovery stops at the first
  empty address, and asking about many addresses at once tells the RPC they
  belong together).
- One wallet per network in a browser. Removing it from the browser deletes
  only that copy.

## Run (development)

    python3 -m http.server 8080 --bind 127.0.0.1
    # open http://127.0.0.1:8080/

The multi-file tree (`index.html`, `js/`, `worker/`, `wasm/`) is for
development. What ships is the single file:

    node tools/build-single.mjs        # -> dist/jetsam-web-wallet.html (+ .sha256, .csp)

The build is deterministic (same sources, same bytes). It inlines the fonts,
styles, code, the key worker and the WebAssembly module, and prints the file's
SHA-256, to publish with each release. That one file also works offline from
disk. How to serve it: `DEPLOY-HEADERS.md`.

## The WebAssembly module

`wasm/` holds the wallet core built from the Jetsam repository
(`jetsam_wallet_wasm`), with its source commit and hashes in
`wasm/SOURCE.txt`. To rebuild and check it:

    tools/import-wasm.sh <jetsam repository checkout>

(rustc **1.98.1** exactly, as the `stable` toolchain, with the
`wasm32-unknown-unknown` target, and the `wasm-bindgen` CLI **0.2.122**
exactly: the build script checks both and refuses other versions, because
another compiler gives other bytes.) The same commit gives the same bytes; the
static tests check the recorded hashes and that the single file embeds exactly
that module.

The module's JavaScript surface keeps the secret behind a `WalletKey` handle:
requests name an address index, never carry the secret. Only two methods of
the module let secret material out, both for backups: `seal` (encrypted file)
and `revealHex` (ASCII bytes, shown on a canvas once, then zeroed). Neither is
a command of the key worker, which is what page code can reach: the worker
calls them itself. The key worker
seals only when a wallet is created or imported, under the password typed in
that same request, and reveals only right after creation or after the
password is entered again. Nothing compares guesses with the secret: the
backup check of a new wallet draws its 3 groups inside the module, allows 3
attempts and then closes for good (enforced by the module, not only the page).

## Tests

    node --test tests/*.test.js

Unit tests (no install, Node 18+): amounts (typed JTM to exact µJTM), address
and network checks (look-alike characters, bech32 vs bech32m), the backup gate,
index lists, epoch windows, key-file classification, RPC answer validation,
send planning helpers, pending payments, the auto-lock, the RPC client's size
limits, the one-tab lock, plus everything from v1 and the page's own
guarantees (CSP, no external URL, no HTML sink/eval/logging, password fields,
the single-file build and the embedded module's hash). `keyworker.test.js`
runs the shipped key worker and module and replays, through its message
interface, the attacks a script in the page could try (no command compares
guesses with the secret or seals it under the caller's password).

Browser tests (Python + Playwright sync API, Chromium):

    JETSAM_WASM_NODE_PKG=<jetsam_wallet_wasm node build dir> \
    JETSAM_NODE_TOOL=<jetsam repo>/target/release/examples/fake_node_tool \
    python3 tests/e2e/run_e2e.py <out dir>

They run the shipped single file against `tests/e2e/fake_node.py`, a simulated
RPC on 127.0.0.1 that answers with real response shapes (u64 above 2^53,
`creation_height` like the public proxy) and admits payments with the node's
own stateless checks (`fake_node_tool`, from the Jetsam repository) plus its
stateful checks (fee floor, epoch anchors, live inputs, empty outputs, mempool
conflicts). Covered: create → back up → receive → funds → send (proven in the
worker, verified natively) → confirmations; restore in fresh browser profiles
(file, hex); wrong password; wrong network; look-alike characters; bad amounts;
insufficient funds; fee raised by the node; epoch change during the proof; slot
taken at admission; RPC without slot hints; epoch boundary wait; malformed
answers, HTTP errors, outputs of another owner, connection cut at submission;
cancel and page close during the proof; idle lock; and an RPC that refuses
payments like the public proxy today. Since the security review: page code
probing the key worker for the secret; a second tab refused while the first is
unlocked; an admitted payment answered with HTTP 502, an unreadable answer or
a different txid (unknown, then resolved through the mempool); Cancel and tab
close during submission; the RPC changed during review and during the proof;
rows listed twice; inflated fees; a phishing error text; what IndexedDB and
localStorage hold. Since the re-review: two synchronous clicks on "Prove and
send"; Settings saved during a refresh; an RPC that admits a payment and
answers "SlotConflict", with and without hiding its mempool; a tip inflated
by 200 blocks with a hidden mempool, briefly and for 30 simulated minutes; an
unreadable payment history and a record removed before submission; a tab
left on "Welcome" opening another secret, and a record replaced under an
unlocked tab; the lease fallback (Web Locks removed) with a frozen holder. Since the
third pass: an RPC that mines a payment and hides it (never "Expired" while
the public RPC sees it, and paying the same recipient again asks for a
confirmation), the public RPC unreachable at the expiry, what the public RPC
is asked (txids only), the cross-check settings; a tip inflated for 40 s (no
"Final"), a final payment taken off the chain (waiting again); a malformed
lookup for one payment while another is mined; an honest refusal, then an
RPC that never serves the expiry block; the proofs a final one replaced;
how often finished payments are looked up; the testnet with its default
endpoints (height, genesis, balance, a payment sent through the wallet RPC and
looked up on the testnet public RPC before "Final"). The public RPC is
simulated by the simulated node's honest view of its own chain, and the
testnet's wallet RPC by a simulated testnet node (request routing in the
browser), so no real RPC is ever contacted.
The simulated node's hostile faults are listed at the top of `fake_node.py`.
No test touches a real network.

## How it reads the chain

| Need | RPC method |
|---|---|
| Height, occupancy | `getChainInfo`, `blockCount` |
| Right chain? | `getBlockHash(0)` against the known genesis (sending is disabled on a mismatch) |
| Outputs of an address | `getSlotsByOwner` |
| Block of a received output | `getBlockHeader(h).alloc_counter`, searched |
| Fee | `estimateFee(2)` as the relay floor, checked against the consensus minimum |
| Epoch anchor | `getEpochAnchor` (before and after the proof) |
| Output slots | `getSlotHintsSalted(count, random salt)`; else random in `[0, 2^log_slots)` |
| Send | `submitTxIntent` (up to 600 000 bytes of request) |
| Tracking | `getMempoolEntry`, `getTx`, `blockCount`; `getBlockHash` (block at the expiry height, block of a payment before "final"); with an RPC other than the public one (your own, or the testnet default), `blockCount`, `getMempoolEntry`, `getTx` on the public RPC too, txid only |

Answers are parsed with every integer kept exact (a coinbase `creation_id` is
`2^63 | height`), size-capped (8 MiB), and checked for type and range.

## Content-Security-Policy

`index.html`:

    default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
    style-src 'self'; font-src 'self'; img-src 'self';
    connect-src https://rpc.jetsamchain.com https://rpc-testnet.jetsamchain.com
                https://wallet-rpc.jetsamchain.com;
    base-uri 'none'; form-action 'none'

The single file allows its one inline script and stylesheet by hash, the key
worker as `blob:`, fonts and icon as `data:`. `'wasm-unsafe-eval'` allows
compiling WebAssembly, not `eval`.

**Default endpoints** (`js/networks.js`). Each network has a default RPC
(reads and sending) and a public read-only RPC asked for the cross-check
(SEC3-01):

| Network | Default RPC | Cross-check (public RPC) |
|---|---|---|
| testnet | `https://wallet-rpc.jetsamchain.com` (accepts payments) | `https://rpc-testnet.jetsamchain.com` |
| mainnet | `https://rpc.jetsamchain.com` (refuses `submitTxIntent`: "Sending is not enabled on this RPC yet") | the same, so no second source |

The wallet RPC and the public RPCs are distinct servers, but all are run by
the Jetsam project: on the testnet the cross-check is a second server of the
same operator, not an independent source (`THREAT_MODEL.md` 3.2). When the
wallet RPC serves the mainnet, the switch is mainnet's `rpc` line in
`js/networks.js` (its origin is already in `connect-src`); the page checks the
genesis, so it never takes one network for the other.

**Using your own RPC.** Settings accepts another endpoint (https, or http on
127.0.0.1/localhost), but the policy blocks it until you add its origin to
`connect-src` in your copy of the page. A bare node refuses browser requests;
the endpoint must be a proxy that accepts them (CORS), like the public one.
An RPC you do not run can lie about balances, refuse to forward a payment and
see which addresses you look at; it cannot spend.

## Privacy

Jetsam is a transparent chain. Each lookup tells the RPC operator (and the TLS
front that carries it) which address was asked about, and asking about several
addresses in one session links them together. The page only asks about the
addresses in its list, and sends no cookie and no referrer. With an RPC other
than the public one (your own, or the testnet's default wallet RPC), the
public RPC is asked about the transaction ids of the payments made from
this page (never an address), to check what your RPC says about them; turn
that off in Settings if the public RPC must not see them (an expiry is then
your RPC's word alone).

## Good practice

- Check the SHA-256 of the file you open against the release, or keep a
  verified copy and open it from disk.
- Use a browser profile without extensions for the wallet.
- Keep the encrypted backup file and its password, **and** the 64 hex digits on
  paper, in different places.
- Lock the wallet when you leave the computer.

## License

Copyright 2026 the Jetsam developers. Licensed under the Apache License,
Version 2.0 (see `LICENSE`). The bundled fonts keep their own SIL Open Font
License 1.1 (see `fonts/LICENSE-OFL.txt`).

## Files

    index.html            page (CSP, markup)
    css/app.css           styles, light and dark
    js/                   app.js (wiring), wallet.js (keys), send.js (payments), pure modules
    worker/keyworker.js   the key worker: the only place the secret exists
    wasm/                 wallet core (WebAssembly + glue) and SOURCE.txt
    fonts/                Fraunces, Spline Sans, Spline Sans Mono (SIL OFL 1.1)
    tests/                node --test suites, RPC fixtures, e2e/ browser tests and simulated node
    tools/                single-file build, wasm import, QR reference generator
    THREAT_MODEL.md       what is protected, against whom, and what is not
    DEPLOY-HEADERS.md     how the file must be served
    LICENSE               Apache License 2.0
