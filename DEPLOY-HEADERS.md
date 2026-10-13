# Serving the wallet: origin and response headers

Nothing here is deployed. This is what a deployment must look like for the
protections described in `THREAT_MODEL.md` to hold.

## What is served

Exactly one file: the single-file build, `dist/jetsam-web-wallet.html`
(`node tools/build-single.mjs`), served as `/` (and `/index.html`). It holds the
page, the styles, the fonts, the key worker's source and the wallet core's
WebAssembly. The build writes next to it:

- `jetsam-web-wallet.html.sha256`: the hash to publish with the release;
- `jetsam-web-wallet.html.csp`: the Content-Security-Policy for the header
  below (the same policy as the page's `<meta>`, plus `frame-ancestors`).

Anyone can then check what they are served against what was released:

    curl -s https://wallet.jetsamchain.com/ | sha256sum

Do **not** serve the multi-file development tree (`index.html` + `js/` +
`worker/` + `wasm/`): its worker would load without a policy of its own unless
every file gets the headers below, and it has no single hash to check.

## Origin

A dedicated origin, `https://wallet.jetsamchain.com`, used for nothing else.
The wallet's encrypted record lives in IndexedDB, which is per origin: any
other page on the same origin (the site, the explorer, a blog post, an old
file) could read and overwrite it, and any script injected there would run
next to the wallet. A path such as `jetsamchain.com/wallet/` is not acceptable.

No cookies are set for this host or for a parent domain that would reach it
(`Domain=.jetsamchain.com` cookies would be sent to it).

## Response headers (the HTML)

| Header | Value | Why |
|---|---|---|
| `Content-Type` | `text/html; charset=utf-8` | |
| `Content-Security-Policy` | the content of `jetsam-web-wallet.html.csp` (one line) | Same as the `<meta>` policy, and `frame-ancestors 'none'`, which only a header can set. With both present the browser enforces both. |
| `X-Frame-Options` | `DENY` | Framing protection for browsers that ignore `frame-ancestors`. Clickjacking of "Prove and send" or "Show the secret" is the risk. |
| `Cross-Origin-Opener-Policy` | `same-origin` | A window that opened the wallet (or that it opens) gets no handle on it. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Other sites cannot embed the file as a resource. |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `no-referrer` | The page also says so in a `<meta>`, and sends requests with `referrerPolicy: "no-referrer"`. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), clipboard-read=(), display-capture=(), publickey-credentials-get=(), interest-cohort=()` | Nothing the wallet needs. `clipboard-write` stays at its default (the page copies addresses, never the secret). |
| `Strict-Transport-Security` | `max-age=63072000` | HTTPS only. Adding `includeSubDomains`/`preload` is a decision for the whole domain. |
| `Cache-Control` | `no-cache` | Revalidate on every visit, so a fix reaches users and a user can tell (by the hash) which version runs. |

`Cross-Origin-Embedder-Policy: require-corp` is **not** needed: the wallet does
not use `SharedArrayBuffer`. It becomes necessary only if multithreaded proving
(wasm threads) is added; then the RPC responses must also carry
`Cross-Origin-Resource-Policy: cross-origin` or be CORS (they are).

No other path should exist on the host; anything else answers 404 with the same
security headers.

## Content-Security-Policy, explained

    default-src 'none';
    script-src 'sha256-…' 'wasm-unsafe-eval';
    worker-src blob:;
    style-src 'sha256-…';
    font-src data:; img-src data:;
    connect-src https://rpc.jetsamchain.com https://wallet-rpc.jetsamchain.com;
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'

- One inline module runs, allowed by its hash; no other script, no `eval`, no
  inline event handler. `'wasm-unsafe-eval'` allows compiling WebAssembly only.
- The key worker starts from a `blob:` URL made from an inert data block of the
  same file; a blob worker inherits this policy (so it too can only talk to the
  RPC origins, and in practice talks to nothing).
- The only network peers are the two mainnet RPC endpoints: the public
  read-only RPC (`rpc.jetsamchain.com`) and the wallet RPC
  (`wallet-rpc.jetsamchain.com`, which accepts payments; the default). No
  `*`, no other origin. A user who runs their
  own proxy must add its origin to `connect-src` in a copy of the file (see
  README); the page says so when the policy blocks a request.

## CDN / proxy in front (Cloudflare)

The file's bytes must reach the browser unchanged, or the published hash and
the CSP hashes no longer match (and the page breaks, which is the intended
failure). For this hostname, disable every feature that rewrites HTML or adds
scripts:

- Rocket Loader, Auto Minify (HTML/JS/CSS), Email Address Obfuscation,
  Server-side Excludes, Automatic HTTPS Rewrites (HTML rewriting), Mirage,
  Polish of inline images;
- Web Analytics / Browser Insights (it injects a beacon script), Zaraz,
  any "Apps";
- caching may stay, with the `Cache-Control` above respected.

The TLS terminator (Cloudflare) sees every request and response in clear,
including which addresses the browser asks the RPC about: see the threat model.
It never sees the secret, which does not leave the browser.

## The RPC side (for the record; not part of this file's deployment)

Sending from a browser needs, on the RPC the page uses by default:

- `submitTxIntent` and `getSlotHintsSalted` allowed by the proxy, on a route
  whose body limit fits the largest intent (606 990 hex characters; the
  wallet refuses to send an intent above that or a body above 608 KiB, the
  wallet RPC proxy's limits), with a rate limit (each intent costs the node a
  ~40 ms proof verification);
- CORS that lets `https://wallet.jetsamchain.com` POST JSON (the proxy answers
  `Access-Control-Allow-Origin: *` today).

`wallet-rpc.jetsamchain.com` (the wallet proxy) does this, serves the mainnet
and is the page's default RPC; the public RPC, `rpc.jetsamchain.com` (the
explorer proxy), stays the cross-check source (SEC3-01). The public RPC
refuses `submitTxIntent`: with it as the endpoint, the wallet detects the
refusal (`method not allowed`, or HTTP 413) before proving anything and says
"Sending is not enabled on this RPC yet". The page checks the mainnet
genesis, so it never takes another chain for the mainnet. The wallet has no
testnet.
