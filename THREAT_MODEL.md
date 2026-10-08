# Threat model — Jetsam web wallet (v1.1, keys)

This document says what the wallet protects, against whom, how, and what it
does **not** protect. No web wallet can promise that no attack is possible:
the residual risks at the end are accepted knowingly and must be read before
anyone puts real money in it.

Status: written with the code, before an independent security review. Every
statement about behaviour points to a test where one exists; the rest is
design intent.

## 1. What the wallet is

A single HTML file (`dist/jetsam-web-wallet.html`) that runs entirely in the
browser:

- **Page** (main thread): UI, RPC client, address list, balances, the send
  form. Never holds the secret.
- **Key worker** (`worker/keyworker.js`, started from a `blob:` URL in the
  shipped file): runs `jetsam_wallet_core` compiled to WebAssembly — the node's
  own key derivation, key-file format, coin selection, transaction assembly and
  zero-knowledge owner proof. The secret exists only here, behind a `WalletKey`
  handle inside the module's memory.
- **Storage** (IndexedDB of the wallet's origin): one record per network, the
  node's encrypted `wallet.key` (Argon2id 64 MiB / 3 passes + XChaCha20-Poly1305
  under the user's password), the secret kind, the address index list, the
  sends made from this browser. No secret in clear, no password, no address.
- **RPC** (`rpc.jetsamchain.com` or the user's own proxy): chain height,
  outputs of an address, epoch anchor, fee estimate, slot hints, submission,
  tracking.

Jetsam has no signatures: spending means proving knowledge of the secret behind
an address. So the proof must be computed where the secret is — here, in the
browser. There is no server that could do it without becoming a custodian.

## 2. Assets

| Asset | Why it matters |
|---|---|
| A1. The 32-byte secret (seed or imported spend secret) | Whoever has it can spend everything, forever. |
| A2. The password | With the encrypted record or backup file, it gives A1. |
| A3. The encrypted record / backup file | Offline brute-force target; losing every copy (and the paper) loses the funds. |
| A4. Integrity of a payment (recipient, amount, fee, change address) | A silent change sends money elsewhere. |
| A5. The list of the user's addresses and balances | Privacy: links addresses together and to the user's IP. |
| A6. Availability (being able to see and spend) | Censorship, lockout, lost backup. |

## 3. Adversaries and what the wallet does about them

### 3.1 Compromised JavaScript served to the user (server, CDN, DNS, build)

The strongest adversary. Whoever controls the bytes of the page controls the
wallet: it can read the secret when the user types or unlocks it, change the
recipient, or ship a key worker that leaks.

Mitigations (they make tampering **detectable**, not impossible):

- One file, deterministic build, SHA-256 printed by the build and meant to be
  published with each release (`*.sha256`); `curl … | sha256sum` compares the
  served file with the released one. The WebAssembly inside is rebuilt
  bit-for-bit from the recorded source commit (`wasm/SOURCE.txt`; checked once
  with a clean target directory).
- The release file can be **downloaded and opened from disk**: once verified,
  it no longer depends on the server (a user who does this is out of reach of
  a later server compromise).
- Strict CSP (hash-pinned single inline script, no `eval`, `connect-src` = the
  RPC only): an attacker who controls the page can change the CSP too, so this
  protects against injection, not against a hostile server.
- No third-party code at all: no npm dependency in what ships, no CDN, no font
  service, no analytics.

**Residual**: a user who opens the hosted page without checking the hash trusts
the server, its TLS terminator (Cloudflare) and DNS at that moment. This is the
main reason a browser wallet is weaker than the desktop wallet or a node.

### 3.2 A lying or hostile RPC

The RPC is not trusted for anything that can move money.

- **Cannot spend**: it never receives the secret (tested: no request body in a
  full session contains the secret or its first 16 digits). The proof is bound
  to the transaction; the RPC cannot alter recipient, amount or change.
- **Cannot redirect change**: change always returns to the sending address,
  chosen by the wallet.
- **Fee inflation**: the fee comes from the RPC's estimate, so it is checked:
  never below the consensus minimum computed locally by the core, refused above
  0.5 JTM, flagged above 20× the minimum. Shown on the review screen.
- **Lies about balances / outputs**: it can show wrong balances. Outputs whose
  owner is not the queried address, malformed values, impossible heights, a
  different txid on submission, out-of-range slot hints, oversized (> 8 MiB) or
  too deeply nested answers are refused (`validate.js`, `utxo.js`,
  `bigjson.js`, `rpc.js`; tests). A spend built on invented outputs is rejected
  by honest nodes; the user loses time, not money.
- **Wrong chain**: genesis checked with `getBlockHash(0)`; sending is disabled
  when it does not match.
- **Censorship / delay / lies about inclusion**: it can refuse to forward a
  payment or claim it was confirmed when it was not. The wallet keeps the
  inputs reserved until the transaction is final (8 blocks) or provably expired
  (anchor + 65 blocks); it cannot prove inclusion by itself (no light client).
- **Spying**: it learns which addresses are asked about and from which IP, and
  that addresses asked about together belong together. The wallet asks only
  about the addresses in its list, scans at most 5 new indexes per click, and
  says so. A custom RPC is shown with a permanent warning banner.

### 3.3 Script injection (XSS) and hostile data

- No HTML sink: no `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `document.write`, `eval`, `new Function` anywhere in the code (static test).
  Every RPC string reaches the page through `textContent`.
- CSP blocks inline scripts other than the pinned one, inline handlers,
  external scripts, `<base>`, form posts, framing (header). The page also
  refuses to start when it is framed (for copies served without the header).
- RPC JSON is parsed by a hand-written parser that keeps integers exact
  (`creation_id` above 2^53), refuses `__proto__` pollution, caps depth.
- Imported files are size-checked (≤ 4 KiB, 48 or 105 bytes) before parsing;
  the authoritative parser is the node's own code in wasm.

**Residual**: an XSS that runs anyway (a browser bug, a CSP bypass) runs with
the page's rights and can ask the unlocked key worker to prove a payment to the
attacker. Locking (manual, on idle, on cancel) shortens that window.

What such code cannot do through the worker is obtain the secret without the
password. No command compares guesses with the secret (an unlimited
fragment check used to let page code read it four digits at a time, audit
SEC-01; removed): the backup check exists only for a newly generated seed, its
3 groups are drawn inside the module, 3 attempts are allowed and then it
closes for good — the module enforces this, not just the page. The encrypted
copy is made only when a wallet is created or imported, under the password
given in that same request; an unlocked wallet cannot be re-sealed under a
password chosen by the caller. `reveal` works once right after creation, and
afterwards only after `grantReveal` re-opened the stored copy with the
password (the same work as an offline guess, so no cheaper oracle). The
secret is exposed to page code only while it is drawn on screen (creation, or
after the password), as pixels it can read back.

### 3.4 Hostile browser extension

An extension with access to the page can read the DOM, inputs, and the canvas
pixels; it can inject scripts. **The wallet cannot defend against it.** What it
does limit: the secret is shown only as pixels on a canvas (no text node to
scrape, not selectable, not in the clipboard, not translated or spell-checked);
password fields are `type="password"`; the pasted 64-hex secret goes in a
masked *text* field (`-webkit-text-security`), with spell-check, autocorrect and
autocomplete off, so that no password manager offers to save and sync it
(masking support in Firefox not verified: without it, the digits are visible
on screen while typed); the hex input is emptied as soon as it is read. The
README tells users to use a browser profile without extensions.

### 3.5 Theft or access to the device

- **Locked wallet, stolen disk/profile**: the attacker gets the encrypted
  record (A3) and can brute-force the password offline. Argon2id with 64 MiB
  and 3 passes (the node's parameters) makes each guess costly; a weak password
  still falls. Minimum length is 10 characters; there is no strength meter.
- **Unlocked wallet, someone at the keyboard**: they can send. Mitigations:
  idle lock (1/5/15/30 min, default 5), Lock button, password required again to
  show the secret. The encrypted backup can be downloaded without the password
  (it is useless without it).
- **Memory of a running browser**: while unlocked, the secret is in the wasm
  memory of the worker. Zeroization is best effort: the handle is zeroized when
  freed, inputs carrying secrets or passwords are zeroized inside the module,
  the worker is terminated on lock. JavaScript strings (the password typed, the
  hex pasted on import) cannot be wiped and live until garbage collection;
  copies the compiler makes on the wasm stack are not wiped either.
- **Same-origin storage**: anything else served on the wallet's origin could
  read the record. Hence a dedicated origin (`DEPLOY-HEADERS.md`). Opened from
  disk (`file://`), browsers may share one storage area between all local
  files.

### 3.6 Look-alike addresses and altered pastes

- Recipient checked locally with strict bech32m (bech32 checksums refused),
  network prefix compared with the selected network (refused, never
  converted), any non-ASCII character named as a look-alike/invisible character
  (Cyrillic letters, zero-width spaces) (tests).
- The review screen shows the full recipient in groups of four, with amount,
  fee, total, change, network and number of outputs spent; a warning if the
  recipient is one of the wallet's own addresses.

**Residual**: clipboard-replacing malware that substitutes a *valid* address of
the attacker passes every check. Only comparing the address with the recipient
through another channel catches it; the review screen asks for that.

### 3.7 Network attacker (MITM)

HTTPS to the RPC (plain HTTP is only accepted for `127.0.0.1`/`localhost`). A
TLS-terminating front (Cloudflare) sees RPC traffic in clear: addresses and
transactions, never the secret.

### 3.8 Loss of the backup / user mistakes

- A new wallet cannot show an address before: the encrypted file was
  downloaded, the 64 hex digits were shown once and the user typed back three
  random groups, drawn inside the module (`crypto.getRandomValues`, unbiased),
  compared there without the page holding the secret. Three wrong attempts
  discard the wallet (it never held anything): the worker drops the key and the
  module refuses any further answer.
- The backup file is the node's own format: `jetsam` opens it with the same
  password (`JETSAM_WALLET_PASSPHRASE`), and the 64 hex digits import with
  `jetsam --import-wallet-secret`.
- Removing the wallet from the browser requires ticking "I have my backup" and
  a second click.
- The secret is generated inside the module from `crypto.getRandomValues`
  (getrandom's `js` backend) — no other RNG; the proof's hiding randomness too.

**Residual**: a user who keeps neither the file+password nor the paper, or who
loses both, loses the funds. Nothing can be recovered by anyone.

### 3.9 Proving-time and protocol pitfalls

- A proof binds the epoch anchor; the wallet does not start a proof within 3
  blocks of an epoch change, re-reads the anchor after proving and proves again
  if it changed (tested with an anchor that moves during the proof).
- Output slots: from `getSlotHintsSalted` (random salt, not the address) or,
  when the RPC offers none, drawn uniformly in `[0, 2^log_slots)` avoiding the
  wallet's own slots; a slot found taken at admission leads to new slots and a
  new proof, at most 3 attempts (tested).
- Double spends from this browser: inputs of submitted payments stay reserved.
  A payment is recorded (inputs reserved, outcome "unknown") *before* the
  intent is sent, so closing the tab or losing the answer cannot make it look
  unsent. Its outcome has three values: admitted (the RPC answers the txid
  computed here), refused (an explicit refusal the wallet recognizes: the
  node's mempool and decoding errors, a 4xx), or unknown — no answer, a 5xx
  from a proxy, an unreadable answer, a different txid, an unrecognized error.
  An unknown payment is never called "not sent": the page says the node may
  have accepted it, keeps its inputs reserved and asks `getMempoolEntry`/`getTx`
  about the locally computed txid until it is seen, or until its anchor has
  expired (then it can never be admitted). Cancel stops a proof, but not a
  submission: once the intent may reach the node, the button is disabled and
  says so (audit SEC-02, SEC-03; tested).
- Coinbase and received outputs fewer than 8 blocks deep are shown provisional
  and not spent.
- Timing: the portable carry-less multiplication used in wasm is constant-time
  (core patch `ct-clmul`); the rest of the prover was not audited for timing.
  Remote timing attacks through a browser are considered impractical, not
  impossible.

### 3.10 Several tabs, or the same secret elsewhere

- **Two tabs of this page**: a wallet can be unlocked in one tab (or window)
  only. Unlocking, opening or finishing a new wallet takes a lock named after
  the network (Web Locks; where the browser lacks them, a lease in
  `localStorage` renewed every 3 s and expiring after 10 s). A second tab is
  refused with "already open in another tab" and stays locked; the lock is
  released on Lock, on the idle lock, and when the tab closes. Without the lock
  each tab would keep its own list of pending payments and overwrite the
  other's, freeing inputs still in flight (audit SEC-04). Writes to the record
  are also read-modify-write inside one IndexedDB transaction, and a new
  record is added only if none exists (defence in depth).
- **Residual**: without Web Locks *and* without `localStorage`, nothing can
  coordinate tabs and the lock is granted (such a browser cannot store a
  wallet either). The lease fallback is best effort: two tabs writing within
  the same ~60 ms are resolved by reading back, not by an atomic primitive.
- **The same secret in the node (or another browser)**: nothing coordinates
  them. Each spends without knowing the other's pending payments; a conflict
  is refused by the network after a full proof, and each side's history is
  incomplete. Use one place to spend from at a time.

## 4. Assumptions

- The browser, the OS and the hardware are not compromised; the browser's
  `crypto.getRandomValues` is a CSPRNG; WebAssembly memory isolation holds.
- The user verifies the release hash or uses a trusted copy, and keeps the
  backup safe.
- The consensus code compiled into the module (`jetsam_core`, `jetsam_gkr`,
  `jetsam_tx`, `jetsam_poseidon2b`, `jetsam_wallet_core`) is correct; it is the
  node's own code, and the intents it produces in the browser are accepted by
  the node's native verifier (tested).
- The RPC operator is honest about forwarding payments **or** the user runs
  their own proxy.

## 5. Residual risks, accepted

1. **Served-code trust** (3.1): visiting the hosted page without checking its
   hash is trusting the server, the CDN and DNS at that instant.
2. **Malicious extension or XSS while unlocked** (3.3, 3.4): can drain the
   spendable balance by proving payments, and read the secret's pixels while it
   is on screen. Not preventable by a page. It cannot extract the secret from
   the key worker without the password (3.3).
3. **Weak password + stolen device** (3.5): offline brute force of the
   encrypted record.
4. **Secret remnants in memory** (3.5): best-effort zeroization only; strings
   in the JS heap and stack copies in wasm memory persist until reused.
5. **Clipboard malware with a valid address** (3.6).
6. **RPC privacy** (3.2, 3.7): the RPC operator and the TLS front see which
   addresses are queried, from which IP, and which belong together.
7. **RPC lies about balances or inclusion** (3.2): no light-client proof yet.
8. **Loss of every backup** (3.8).
9. **Browser storage eviction**: a browser may clear site data (low disk,
   "clear history"); the encrypted record goes with it. The backup is the only
   durable copy.
10. **Not yet proven on a real network**: every send in the tests went to a
    simulated node that runs the node's admission code; no transaction from
    this page has been submitted to the testnet or mainnet.

## 6. Out of scope

Hardware wallets, multisig (absent from the protocol), custodial recovery,
price feeds, swaps, mobile apps, the desktop wallet, the RPC proxy itself.
