# Threat model — Jetsam web wallet (v1.1, keys)

This document says what the wallet protects, against whom, how, and what it
does **not** protect. No web wallet can promise that no attack is possible:
the residual risks at the end are accepted knowingly and must be read before
anyone puts real money in it.

Status: written with the code, then revised after an adversarial security
review (2026-10-08, findings SEC-01 to SEC-14) and its re-review (findings
SEC2-01 to SEC2-10); each change below names the finding it answers. Every
statement about behaviour points to a test where one exists; the rest is
design intent. A fix is not a proof of absence: the revised parts are to be
reviewed again.

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
  under the user's password), the secret kind, the address *index numbers*,
  the idle-lock delay, the creation time, and the sends made from this
  browser (recipient, amount, fee, txid, input and output slots) **sealed** by
  the key worker (XChaCha20-Poly1305 under a key derived from the secret,
  readable only once unlocked). If that sealed list does not open (damaged,
  or sealed by another wallet), the page says so, blocks sending — the
  reservations it held are unknown — and never writes over it (audit SEC2-03;
  tested). The list keeps at most 100 finished payments (oldest dropped) and
  50 in flight (a new payment is refused beyond that), far below the 1 MiB
  sealing limit (SEC2-08). No secret in clear, no password, no address,
  no txid, no slot in clear. `localStorage` holds preferences (network, theme,
  mode, custom RPC URL, the cross-check choice), the last proof's duration, the tab lock's lease, and —
  in watch mode only — the watched addresses and the block heights of their
  received outputs. Audit SEC-06 found recipients, txids and slots stored in
  clear (and output ids in `localStorage`) contrary to an earlier version of
  this paragraph; records written before the fix are re-sealed on their first
  unlock.
- **RPC** (`rpc.jetsamchain.com` or the user's own proxy): chain height,
  outputs of an address, epoch anchor, fee estimate, slot hints, submission,
  tracking. With the user's own proxy, the public RPC is also asked about
  the txids of the payments made here (and nothing else) before an expiry
  is believed or a payment shown final (3.2, SEC3-01; can be turned off).

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
  bit-for-bit from the recorded source commit (`wasm/SOURCE.txt`; checked
  with a clean target directory) with exactly rustc 1.98.1 and wasm-bindgen
  0.2.122: the build script refuses any other version, since another compiler
  gives other bytes (audit SEC-13).
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
  0.5 JTM, flagged on the review screen as soon as it is more than twice that
  minimum, with the minimum shown (audit SEC-05: 16× the minimum used to pass
  silently). Between 2× and the cap the user decides; the excess goes to the
  miner, at most 0.5 JTM per payment.
- **Lies about balances / outputs**: it can show wrong balances. Outputs whose
  owner is not the queried address, malformed values, impossible heights, a
  slot listed twice (it would count twice and be spent twice; the module also
  refuses a plan or send naming a slot twice — audit SEC-07), out-of-range slot
  hints, oversized (> 8 MiB) or too deeply nested answers are refused (`validate.js`, `utxo.js`,
  `bigjson.js`, `rpc.js`; tests). A different txid on submission makes the
  outcome unknown (3.9). A spend built on invented outputs is rejected by
  honest nodes; the user loses time, not money.
- **Wrong chain**: genesis checked with `getBlockHash(0)`; sending is disabled
  when it does not match. A payment is proven and sent only through the RPC it
  was reviewed against, once that RPC's genesis is checked: changing the RPC in
  Settings sends a payment under review back to the form, and a proof running
  meanwhile stops before submission (audit SEC-11; tested).
- **Censorship / delay / lies about inclusion**: it can refuse to forward a
  payment, claim it was confirmed when it was not, claim it refused a payment
  it admitted, or hide an admitted payment. The wallet has no light client:
  everything it knows about a payment is the RPC's word, so it keeps the
  inputs reserved until the transaction is final (8 blocks) or its expiry
  (anchor + 65 blocks) is *believed* — not proven:
  - a **refusal** ("consensus: SlotConflict", a 4xx…) is not taken as "not
    sent": the payment stays listed and reserved, and the page looks the txid
    it computed itself up (`getMempoolEntry`, `getTx`). Found: reported sent,
    with "the RPC had said it refused this payment: that was false". Not
    found: "the RPC says it refused", held until expiry (audit SEC2-01: an RPC
    that admitted a payment and answered "SlotConflict" used to get "Nothing
    was sent" and freed inputs, i.e. a second payment; tested);
  - an **expiry** is believed only when the RPC serves the block at the expiry
    height, two reads at least a minute apart agree, the tip never moved
    faster than one block per 15 s between them, and enough wall-clock time
    passed since the submission for the chain to get there at that pace
    (≥ 15 s per block still to go). Until then the payment shows "May still be
    mined: checking…" and keeps its inputs. "Expired" is not final: the txid
    is looked up for 1 440 more blocks and a payment found is shown again,
    noted "the RPC had reported this payment expired" (audit SEC2-02: tip +200
    with a hidden mempool used to give "Expired" in 15 s, inputs free, for
    good; tested).
  - **Hiding is enough, and costs nothing** (audit SEC3-01). The checks
    above are about the *consistency* of one RPC's answers. An RPC that
    mined the payment (it is paid) and simply answers `null` to
    `getMempoolEntry` and `getTx` for that txid — tip and block ids honest,
    nothing falsified — passes all of them: its expiry used to be believed
    about an hour after the submission (34 to 65 blocks after the anchor,
    plus the two reads), the inputs were offered again, and a second
    payment to the same recipient from the wallet's other outputs was
    accepted: paid twice (audit PoC; the "9 to 16 minutes" earlier written
    here is only the floor of the variant that also inflates the tip). So
    when the configured RPC is **not** the network's public one, the page
    asks the public RPC (`rpc.jetsamchain.com`, or the testnet one; already
    in `connect-src`) about the same txid before believing an expiry:
    `blockCount`, `getMempoolEntry`, `getTx` — the txid computed here and
    nothing else, never an address. The expiry is believed only if the
    public RPC does not see the payment either **and** is past the expiry
    height. If it sees the payment, the payment stays held, is not called
    expired, and says "the public RPC sees this payment; your RPC does not"
    (switching RPC settles it); if it cannot be reached, answers something
    unreadable, or is behind, the payment stays held and says the expiry
    could not be confirmed. After a refusal, the public RPC is asked too
    before the payment is concluded absent: if it sees it, the page says so
    and holds it; if it cannot be reached, nothing is concluded (held, no new
    proof). The same check is made before "final" (3.2, SEC3-02) when the
    public RPC answers. Tested against a simulated public RPC: the hiding
    RPC no longer gets "Expired", and the public RPC was asked about the
    txid only.
  - **What the cross-check does not cover.** It is a second opinion, not a
    proof: an RPC and the public RPC that both lie (or the public RPC
    compromised, or the same operator) still get an expiry believed. When
    the configured RPC **is** the public one there is no second source: the
    expiry rests on that one RPC's word, and the page says so (Settings, and
    the "Expired" note: "on one RPC's word alone"). It can be turned off in
    Settings (on by default), for users who do not want the public RPC to
    learn their txids — with a warning that an expiry is then one RPC's word.
    Only a second, independent RPC chosen by the user, or a light client
    (this page has none), would go further.
  - **Paying the same recipient again** (SEC3-01): when an earlier payment
    from this browser to the same address, of about the same amount (within
    10 %), is refused, unknown, reported expired within the last 1 440
    blocks, or in doubt, the review screen says "A previous payment to this
    address may still be mined. Check it first." and "Prove and send" stays
    disabled until the user ticks that they checked with the recipient; a
    legitimate payment is not prevented (tested).
  When sources disagree the page shows the most cautious reading: seen in the
  mempool or a block — by the configured RPC or the public one — wins over
  any refusal or expiry; a reported expiry without the block at that height,
  with a tip going backwards or too fast, too soon after the submission, or
  not confirmed by the public RPC stays "May still be mined"; a lookup that
  fails changes nothing (the next round asks again). What is left (residual
  11): with the cross-check off or the public RPC configured, one RPC that
  hides a mined payment for about an hour gets its expiry believed at no
  cost; with the cross-check on, it takes the public RPC to agree.
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
- The RPC's own error texts are never displayed: an error is shown as its
  kind (unreachable, HTTP status, unreadable, refused) and a numeric JSON-RPC
  code, so a hostile RPC cannot put instructions ("re-enter your secret at…")
  on the wallet's screen with the page's authority (audit SEC-08; tested).
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
scrape, not selectable, not translated or spell-checked; the canvas blocks its
context menu — no "Copy image" / "Save image as" — and cannot be dragged out,
audit SEC-10). That is a reduction of risk, not a guarantee: a screenshot, a
screen share or recorder, the browser's own developer tools, or code in the
page reading the pixels still get the image;
password fields are `type="password"`; the pasted 64-hex secret goes in a
masked *text* field (`-webkit-text-security`), with spell-check, autocorrect and
autocomplete off, so that no password manager offers to save and sync it.
Where the engine does not support that masking (checked with `CSS.supports`
at start), the field becomes a `password` field instead, never clear text:
the browser may then offer to save it, and the help text says to refuse
(audit SEC-09; the fallback was exercised in tests by the decision function
only — no non-Blink browser was available to run it end to end). The hex input
is emptied as soon as it is read. The
README tells users to use a browser profile without extensions.

### 3.5 Theft or access to the device

- **Locked wallet, stolen disk/profile**: the attacker gets the encrypted
  record (A3) and can brute-force the password offline. Argon2id with 64 MiB
  and 3 passes (the node's parameters) makes each guess costly; a weak password
  still falls. Minimum length is 10 characters; there is no strength meter.
  Without the password the profile tells them that a wallet exists on this
  network, when it was created, how many address indexes it uses and how many
  bytes of payment history it holds (the sealed size); not which addresses,
  recipients or transactions. The custom RPC URL and, in watch mode, the
  watched addresses are in clear.
- **Unlocked wallet, someone at the keyboard**: they can send. Mitigations:
  idle lock (1/5/15/30 min, default 5), Lock button, password required again to
  show the secret. The encrypted backup can be downloaded without the password
  (it is useless without it). A page restored by the browser's back/forward
  cache comes back with its worker, still unlocked; the idle lock applies at
  its next 5-second check (not tested).
- **Memory of a running browser**: while unlocked, the secret is in the wasm
  memory of the worker. Zeroization is best effort: the handle is zeroized when
  freed, inputs carrying secrets or passwords are zeroized inside the module,
  the worker is terminated on lock. JavaScript strings (the password typed, the
  hex pasted on import) cannot be wiped and live until garbage collection;
  copies the compiler makes on the wasm stack are not wiped either. The 64 MiB
  of Argon2 working memory used to open or seal the record (from which the
  record's encryption key follows) is not zeroized either (`argon2` is built
  without its `zeroize` feature): it stays in the worker's memory until the
  worker ends, which locking does (audit SEC-12; documented, not changed).
- **Same-origin storage**: anything else served on the wallet's origin could
  read the record. Hence a dedicated origin (`DEPLOY-HEADERS.md`). Opened from
  disk (`file://`), browsers may share one storage area between all local
  files (then any local HTML file opened in that browser can read the sealed
  record and the tab lock is shared with them), or give each file an opaque
  origin with no lasting storage (then nothing is remembered). Neither case is
  tested; prefer a served copy whose hash was checked, or a dedicated browser
  profile for the file.

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
  new proof (below), at most 3 attempts (tested).
- Double spends from this browser: inputs of submitted payments stay reserved.
  A payment is recorded in storage (inputs reserved, outcome "unknown")
  *before* the intent is sent, so closing the tab or losing the answer cannot
  make it look unsent; if that record cannot be written (storage refusing,
  record removed or replaced by another tab, history unreadable, browser that
  cannot store the wallet), the payment is **not sent** and the page says so
  (audit SEC2-03: the write used to fail silently; tested). Later write
  failures are shown under "Sent from this browser", never swallowed.
  The outcome has three values: admitted (the RPC answers the txid computed
  here), refused — what the RPC *claims* is a refusal: the node's mempool and
  decoding errors, a JSON-RPC invalid-params error, an HTTP 4xx other than
  403/405/413 — or unknown: no answer, a 5xx from a proxy, an unreadable
  answer, a different txid, an unrecognized error. Neither a refused nor an
  unknown payment is ever called "not sent": both stay listed with their
  inputs reserved and are looked up by the locally computed txid until seen
  or until their expiry is believed (3.2). A 4xx is classed "refused" (audit
  SEC2-09): almost always emitted before forwarding, but a front that filters
  the answer after forwarding is possible, which is why "refused" holds the
  inputs too. The only "nothing was sent" after a proof is when no request
  left the page (a stale anchor or a changed RPC before submission, a request
  over the size limit, the record not written). Cancel stops a proof, but not
  a submission: once the intent may reach the node, the button is disabled
  and says so (audit SEC-02, SEC-03; tested).
- A slot taken or an anchor changed at admission leads to a new proof only
  when the txid lookup found nothing and the first proof's inputs are still
  listed live; the new proof spends **only the first proof's inputs**, so the
  two intents exclude each other on chain and at most one can be accepted;
  the first stays listed as "refused by the RPC" (SEC2-01). "Prove and send"
  runs one proof at a time, from the review screen only (SEC2-07: two clicks
  in one task, from page code, used to prove and submit twice).
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
  `localStorage` renewed every 15 s and expiring after 60 s). A second tab is
  refused with "already open in another tab" and stays locked; the lock is
  released on Lock, on the idle lock, and when the tab closes. Without the lock
  each tab would keep its own list of pending payments and overwrite the
  other's, freeing inputs still in flight (audit SEC-04). Writes to the record
  are also read-modify-write inside one IndexedDB transaction, and a new
  record is added only if none exists (defence in depth).
- **A tab that lost the lease** (lease fallback only: its timers were frozen
  or throttled for over a minute and another tab unlocked meanwhile) checks
  before every write of the record that the lease is still its own; it is
  not, so it locks itself, says why, and writes nothing (audit SEC2-06: with
  a 10 s lease a frozen tab used to keep writing next to the new one; tested
  with Web Locks removed and frozen timers). Until its next write it may
  still *show* the wallet unlocked.
- **A tab that never held the stored wallet cannot write to it**: a tab left
  on "Welcome" while another tab stored a wallet cannot open another secret
  over it — the page goes back to the stored wallet's unlock screen and says
  why — and every write names the encrypted key it unlocked: a record holding
  another key (another wallet, or this one removed and stored again) is not
  written, and the page says "changes are no longer saved" (audit SEC2-04:
  the second secret's history used to be sealed over the first wallet's;
  tested). Only when storage itself refuses does a wallet run unstored, and
  then it cannot send.
- **Settings saved during a refresh** used to leave the page on
  "Connecting…" with sending disabled until a reload (SEC2-05; fixed and
  tested).
- **Residual**: without Web Locks *and* without `localStorage`, nothing can
  coordinate tabs and the lock is granted (such a browser cannot store a
  wallet either). The lease fallback is best effort: two tabs taking an
  expired lease within the same ~60 ms are resolved by reading back, and
  "check the lease, then write" is not atomic across `localStorage` and
  IndexedDB (a window of milliseconds). Web Locks are in every current
  engine; the fallback concerns old ones (Safari < 15.4, Firefox < 96, old
  WebViews), where none of this was run (Chromium only, Web Locks removed).
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
11. **Refused or unknown submission outcomes** (3.2, 3.9): the inputs stay
    reserved until the payment is seen or its expiry is believed (65 blocks
    after its anchor, never sooner than 15 s per block still to go after the
    submission, two reads a minute apart, and — with a custom RPC and the
    cross-check on — the public RPC not seeing it and past that height):
    funds can look held for more than an hour even when the node really
    refused the payment (an honest "fee too low" included) — the price of
    not taking the RPC's word. **Hiding a mined payment costs an RPC
    nothing** (SEC3-01): it answers `null` for that txid, everything else
    honest. With the public RPC configured, or the cross-check turned off,
    that is enough to get "Expired" about an hour after the submission (34
    to 65 blocks after the anchor; the "9 to 16 minutes" of an earlier
    version of this text is only the floor of the costlier variant that also
    inflates the tip); the inputs are offered again, and a second payment
    from the wallet's other outputs pays the recipient twice. The review
    screen then asks for an explicit confirmation before paying the same
    recipient again, and the page keeps looking the first payment up for
    1 440 blocks and shows it again if it appears, but cannot undo a second
    payment. With a custom RPC and the cross-check on (the default), the
    expiry also needs the public RPC to agree: it then takes both to hide
    the payment (or the public RPC compromised). Only a light client would
    close this.
12. **Tab coordination** (3.10): best effort without Web Locks; none without
    Web Locks and storage; none at all between this browser and a node (or
    another browser) holding the same secret.
13. **The secret on screen** (3.4): blocking the canvas's menu and drag only
    removes the easy copies; screenshots, screen sharing and page code still
    see it while it is shown.
14. **Downgrade**: an older build of this page opening a record written by
    this one ignores the sealed history (`meta`) and starts from an empty
    list: its reservations are lost there. Use one build at a time.
15. **Session denial by page code** (3.3): code running in the page can send
    `generate`, `openFile` or `importHex` to the unlocked key worker, which
    replaces the key in memory (it learns nothing, but the session's key is
    gone until the next unlock). Same precondition as residual 2.
16. **Payment history unreadable** (1, 3.9): sending stays blocked until it
    opens again or the wallet is restored from its backup (after waiting for
    payments in flight to expire); the old list is kept, not repaired.

## 6. Out of scope

Hardware wallets, multisig (absent from the protocol), custodial recovery,
price feeds, swaps, mobile apps, the desktop wallet, the RPC proxy itself.
