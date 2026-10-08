#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""End-to-end browser tests of the keyed wallet, against a simulated node.

    JETSAM_WASM_NODE_PKG=<pkg/node> python3 tests/e2e/run_e2e.py <out dir> [--browser chromium|firefox] [--only NAME,...]

The page under test is the shipped single file (tools/build-single.mjs) with
the simulated node's origin added to connect-src. The simulated node checks
every submitted intent with the node's own admission code (fake_node_tool).
Nothing here reaches a real network: the public RPC hosts are blocked.

Writes <out>/results.json (every check, PASS/FAIL, timings) and screenshots.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import FakeNode, StaticServer, build_page, block_public, Console, set_rpc, wait_text, ROOT, HERE  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PASSWORD = "tide gauge harbour 7"
OTHER_SEED = "11" * 32  # throw-away recipient seed
results = []
timings = {"prove_ms": []}


def check(name, cond, detail=""):
    results.append({"check": name, "ok": bool(cond), "detail": str(detail)[:500]})
    print(("PASS " if cond else "FAIL ") + name + ((" — " + str(detail)[:200]) if detail else ""), flush=True)
    return cond


def keytool(*args):
    out = subprocess.run(["node", os.path.join(HERE, "keytool.cjs"), *args], check=True, capture_output=True, text=True)
    return out.stdout


def addresses_of(hex_secret, kind, network, start, count):
    return [a["bech32"] for a in json.loads(keytool("addresses", hex_secret, kind, network, str(start), str(count)))["addresses"]]


def new_context(browser, viewport=(1440, 900), scheme="light"):
    ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, accept_downloads=True, color_scheme=scheme)
    block_public(ctx)
    return ctx


def open_page(ctx, url, node_url):
    page = ctx.new_page()
    con = Console(page)
    page.goto(url)
    page.wait_for_selector("#chain-text")
    if node_url not in (page.text_content("#foot-rpc") or ""):
        set_rpc(page, node_url)
    wait_text(page, "#chain-text", r"block")
    return page, con


def unlock(page, password=PASSWORD):
    page.wait_for_selector("#gate-unlock", state="visible")
    page.fill("#unlock-password", password)
    page.click("#unlock-btn")


def total_text(page):
    return (page.text_content("#total-int") or "") + (page.text_content("#total-frac") or "")


def page_holds(page, needle):
    """Is `needle` anywhere in the DOM (text, attributes, input values) or in
    localStorage / IndexedDB of the page?"""
    return page.evaluate(
        """async (needle) => {
          const found = [];
          if (document.documentElement.outerHTML.includes(needle)) found.push("html");
          if (document.body.innerText.includes(needle)) found.push("text");
          for (const i of document.querySelectorAll("input, textarea")) if ((i.value || "").includes(needle)) found.push("input#" + i.id);
          for (let k = 0; k < localStorage.length; k++) {
            const key = localStorage.key(k);
            if ((localStorage.getItem(key) || "").includes(needle) || key.includes(needle)) found.push("localStorage");
          }
          const dbs = indexedDB.databases ? await indexedDB.databases() : [{ name: "jetsam-wallet" }];
          for (const d of dbs) {
            const db = await new Promise((res, rej) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            for (const store of db.objectStoreNames) {
              const all = await new Promise((res) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); });
              const text = JSON.stringify(all, (k, v) => v instanceof Uint8Array ? Array.from(v, b => b.toString(16).padStart(2, "0")).join("") : v);
              if (text.includes(needle)) found.push("indexedDB:" + d.name + "/" + store);
            }
            db.close();
          }
          return found;
        }""",
        needle,
    )


def wait_until(fn, timeout=60.0, step=0.25):
    """Poll fn() until truthy; returns its last value (never raises on timeout)."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
        except Exception:
            last = None
        if last:
            return last
        time.sleep(step)
    return last


def sent_status(page, txid):
    """Status text of the 'Sent from this browser' entry for txid, or None."""
    return page.evaluate(
        """(txid) => {
          for (const li of document.querySelectorAll('#sent-list li')) {
            if (li.textContent.includes(txid)) {
              const st = li.querySelector('.sent-status .badge');
              return st ? st.textContent : '';
            }
          }
          return null;
        }""",
        txid,
    )


def idb_text(page):
    """The IndexedDB record(s), bytes as hex, as one string."""
    return page.evaluate(
        """async () => {
          const db = await new Promise((res, rej) => { const r = indexedDB.open('jetsam-wallet'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          const all = await new Promise((res) => { const r = db.transaction('wallets').objectStore('wallets').getAll(); r.onsuccess = () => res(r.result); });
          db.close();
          return JSON.stringify(all, (k, v) => v instanceof Uint8Array ? Array.from(v, b => b.toString(16).padStart(2, '0')).join('') : v);
        }"""
    )


HOSTILE_FAULTS = ["delay_submit", "after_admission", "fee_value", "dup_rows", "phish", "method:submitTxIntent",
                  "method:estimateFee", "method:getChainInfo", "lie_owner"]


def shot(page, out, name):
    os.makedirs(os.path.join(out, "shots"), exist_ok=True)
    page.screenshot(path=os.path.join(out, "shots", name + ".png"), full_page=True)


# ---------------------------------------------------------------------------
def create_wallet(page, out, tag):
    """Create, back up, pass the quiz (one wrong try first). Returns (hex, address, backup path)."""
    page.wait_for_selector("#gate-welcome", state="visible")
    page.click("#choose-create")
    page.fill("#create-pw1", "short")
    page.fill("#create-pw2", "short")
    page.click("#create-pw-go")
    check(tag + ": short password refused", "at least 10" in page.text_content("#create-pw-msg"))
    page.fill("#create-pw1", PASSWORD)
    page.fill("#create-pw2", PASSWORD + "x")
    page.click("#create-pw-go")
    check(tag + ": mismatched passwords refused", "differ" in page.text_content("#create-pw-msg"))
    page.fill("#create-pw1", PASSWORD)
    page.fill("#create-pw2", PASSWORD)
    page.click("#create-pw-go")
    page.wait_for_selector("#step-file", state="visible")
    check(tag + ": no address before the backup is checked", not page.is_visible("#wallet-view") and not page.is_visible("#qr"))
    check(tag + ": 'saved' is disabled before the download", page.is_disabled("#create-file-done"))
    with page.expect_download() as d:
        page.click("#create-download")
    backup = os.path.join(out, tag + "-wallet.key")
    d.value.save_as(backup)
    size = os.path.getsize(backup)
    check(tag + ": backup is the node's sealed wallet.key (105 bytes, jetsam_aead_key1)", size == 105 and open(backup, "rb").read(16) == b"jetsam_aead_key1", size)
    page.click("#create-file-done")
    page.wait_for_selector("#create-reveal", state="visible")
    page.click("#create-reveal")
    page.wait_for_selector("#secret-canvas", state="visible")
    shot(page, out, tag + "-secret-1440")
    secret = keytool("reveal", backup, PASSWORD).strip()
    check(tag + ": secret decrypted from the downloaded backup", re.fullmatch(r"[0-9a-f]{64}", secret) is not None)
    leaks = page_holds(page, secret)
    check(tag + ": secret shown on canvas only: not in DOM, inputs, localStorage, IndexedDB", leaks == [], leaks)
    leaks_upper = page_holds(page, secret[:16])
    check(tag + ": not even its first 16 digits are in page text/storage", leaks_upper == [], leaks_upper)
    menu = page.evaluate("""() => {
      const c = document.getElementById('secret-canvas');
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      c.dispatchEvent(e);
      const d = new Event('dragstart', { bubbles: true, cancelable: true });
      c.dispatchEvent(d);
      return { menu: e.defaultPrevented, drag: d.defaultPrevented, draggable: c.getAttribute('draggable'), select: getComputedStyle(c).userSelect };
    }""")
    check(tag + ": SEC-10 secret canvas: no context menu (copy/save image), no drag-out, not selectable",
          menu["menu"] and menu["drag"] and menu["draggable"] == "false" and menu["select"] == "none", menu)
    page.click("#create-written")
    page.wait_for_selector("#step-quiz", state="visible")
    check(tag + ": the canvas is cleared after 'written'", page.evaluate("document.getElementById('secret-canvas').width") == 1)
    labels = page.locator("#quiz label").all_text_contents()
    groups = [int(re.search(r"(\d+)", l).group(1)) - 1 for l in labels]
    check(tag + ": three distinct groups asked", len(set(groups)) == 3, labels)
    inputs = page.locator("#quiz input")
    for k, g in enumerate(groups):
        inputs.nth(k).fill("ffff" if secret[4 * g:4 * g + 4] != "ffff" else "0000")
    page.click("#quiz-go")
    wait_text(page, "#quiz-msg", r"Attempts left: 2")
    check(tag + ": a wrong group is refused (2 attempts left)", True)
    for k, g in enumerate(groups):
        inputs.nth(k).fill(secret[4 * g:4 * g + 4].upper())
    shot(page, out, tag + "-quiz-1440")
    page.click("#quiz-go")
    page.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
    expected = addresses_of(secret, "seed", "mainnet", 0, 1)[0]
    page.click("#tab-btn-receive")
    shown = "".join(page.locator("#receive-address span").all_text_contents())
    check(tag + ": receive address = node derivation of the backed-up secret (index 0)", shown == expected, shown)
    return secret, expected, backup


def wait_result(page, timeout=600_000):
    page.wait_for_selector("#send-result", state="visible", timeout=timeout)
    return page.text_content("#result-text")


def proof_seconds(page):
    m = re.search(r"Proof computed in ([0-9.]+) s", page.text_content("#prove-time") or "")
    return float(m.group(1)) if m else None


def send(page, to, amount, *, expect_review=True):
    page.click("#tab-btn-send")
    page.wait_for_selector("#send-form", state="visible")
    page.fill("#send-to", to)
    page.fill("#send-amount", amount)
    page.click("#send-review-btn")
    if not expect_review:
        return None
    page.wait_for_selector("#send-review", state="visible", timeout=60_000)
    return page


def prove_and_wait(page):
    page.click("#review-go")
    page.wait_for_selector("#send-progress", state="visible")
    text = wait_result(page)
    secs = proof_seconds(page)
    if secs is not None:
        timings["prove_ms"].append(round(secs * 1000))
    return text, secs


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--browser", default="chromium")
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    only = set(filter(None, args.only.split(",")))
    want = lambda name: not only or name in only  # noqa: E731

    node = FakeNode()
    node2 = FakeNode()  # another RPC, same chain id (SEC-11)
    site = os.path.join(out, "site")
    os.makedirs(site, exist_ok=True)
    build_page(site, [node.url, node2.url])
    srv = StaticServer(site)
    other = addresses_of(OTHER_SEED, "seed", "mainnet", 0, 1)[0]
    t_start = time.time()
    try:
        with sync_playwright() as p:
            launcher = getattr(p, args.browser)
            browser = launcher.launch(args=["--no-sandbox"] if args.browser == "chromium" else [])
            timings["browser"] = args.browser + " " + browser.version

            # ---- A: create, back up, receive --------------------------------
            ctx_a = new_context(browser)
            page, con = open_page(ctx_a, srv.url, node.url)
            shot(page, out, "welcome-1440-light")
            secret, addr0, backup = create_wallet(page, out, "A")

            # ---- B: funds arrive -------------------------------------------
            tip = node.control(op="state")["height"]
            node.control(op="fund", owner=addr0, value=5_000_000, coinbase=True, height=tip - 20)
            node.control(op="fund", owner=addr0, value=2_000_000)
            node.control(op="fund", owner=addr0, value=1_000_000, coinbase=True, height=tip)
            page.click("#refresh")
            wait_text(page, "#total-sub", r"3 unspent outputs")
            check("B: balance is exact (8 JTM, coinbase creation_id > 2^53 kept)", total_text(page) == "8.000000", total_text(page))
            check("B: the fresh coinbase is marked provisional", "provisional" in page.text_content("#total-sub"), page.text_content("#total-sub"))
            page.click("#tab-btn-outputs")
            shot(page, out, "wallet-1440-light")

            # ---- C: a real send, proven in the worker ------------------------
            if want("send"):
                send(page, other, "1.5")
                rv_to = "".join(page.locator("#rv-to span").all_text_contents())
                check("C: review shows the full recipient, grouped", rv_to == other and page.locator("#rv-to span").count() >= 15, rv_to)
                check("C: review shows amount and fee", "1.500000 JTM" in page.text_content("#rv-amount") and "JTM" in page.text_content("#rv-fee"))
                shot(page, out, "review-1440-light")
                text, secs = prove_and_wait(page)
                check("C: payment accepted by the simulated node (node's own verifier)", text.startswith("Sent"), text)
                st = node.control(op="state")
                check("C: intent in the mempool, verified natively", len(st["mempool"]) == 1, st.get("last_verify_ms"))
                txid = st["mempool"][0] if st["mempool"] else ""
                check("C: page shows the same txid", txid and txid in page.text_content("#result-txid"))
                facts = st["mempool_facts"].get(txid, {})
                outs = {o["owner_hex"]: int(o["amount"]) for o in facts.get("outputs", [])}
                check("C: 1.5 JTM to the recipient, change back to the sender", 1_500_000 in outs.values() and len(outs) == 2, outs)
                timings["first_send_s"] = secs
                shot(page, out, "result-1440-light")
                node.control(op="mine", n=1)
                wait_text(page, "#sent-list", r"Confirmed", timeout=60_000)
                check("C: tracking sees the confirmation (getMempoolEntry/getTx)", True)
                node.control(op="mine", n=8)
                wait_text(page, "#sent-list", r"Final", timeout=60_000)
                check("C: final after 8 blocks", True)
                reqs = node.control(op="requests")["requests"]
                check("C: no request to the RPC ever carried the secret", not any(secret in r for r in reqs), len(reqs))
                check("C: no request carried part of the secret (first 16 digits)", not any(secret[:16] in r for r in reqs))

            # ---- E1: wrong password, lock, unlock --------------------------
            page.click("#lock-btn")
            unlock(page, "not the password")
            wait_text(page, "#unlock-msg", r"does not open")
            check("E: wrong password refused with a clear message", True)
            unlock(page)
            page.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
            check("E: right password unlocks", True)

            # ---- E2: form refusals -----------------------------------------
            if want("refusals"):
                test_other = json.loads(subprocess.run(["node", "-e", "import('%s/js/bech32m.js').then(m=>{const d=m.decodeAddress(process.argv[1]);process.stdout.write(JSON.stringify(m.encodeAddress('tj', d.bytes)))})" % ROOT, other], capture_output=True, text=True, check=True).stdout)
                send(page, test_other, "1", expect_review=False)
                wait_text(page, "#send-to-msg", r"another network")
                check("E: testnet address refused on mainnet", True)
                send(page, other.replace("a", "а", 1), "1", expect_review=False)
                wait_text(page, "#send-to-msg", r"look-alike")
                check("E: look-alike character refused", True)
                send(page, other, "1,5", expect_review=False)
                wait_text(page, "#send-amount-msg", r"dot")
                check("E: comma amount refused", True)
                send(page, other, "1000", expect_review=False)
                wait_text(page, "#send-msg", r"Not enough")
                check("E: insufficient funds refused before proving", True, page.text_content("#send-msg"))

            # ---- E3: fee too low at submission -------------------------------
            if want("fee"):
                send(page, other, "0.1")
                node.control(op="fault", set={"before_admission": "raise_floor", "floor_value": 60000})
                text, _ = prove_and_wait(page)
                check("E: fee raised by the node after review -> clean refusal", "higher fee" in text, text)
                node.control(op="set", floor=0)
                page.click("#result-new")

            # ---- E4: stale anchor during the proof -> re-proved ---------------
            if want("anchor"):
                send(page, other, "0.1")
                node.control(op="fault", set={"anchor_moves_after_read": True})
                text, _ = prove_and_wait(page)
                check("E: epoch changed during the proof -> re-read, re-proved, accepted", text.startswith("Sent"), text)
                node.control(op="mine", n=1)
                page.click("#result-new")

            # ---- E5: slot collision -> new slots, re-proved -------------------
            if want("slots"):
                send(page, other, "0.1")
                node.control(op="fault", set={"before_admission": "occupy_outputs"})
                text, _ = prove_and_wait(page)
                check("E: output slot taken at admission -> new slots, re-proved, accepted", text.startswith("Sent"), text)
                node.control(op="mine", n=1)
                page.click("#result-new")

            # ---- E6: no slot hints on this RPC -> drawn slots -----------------
            if want("drawn"):
                node.control(op="fault", set={"method:getSlotHintsSalted": "refuse"})
                send(page, other, "0.1")
                page.click("#review-go")
                wait_text(page, "#prove-status", r"drawn at random", timeout=120_000)
                text = wait_result(page)
                check("E: without getSlotHintsSalted, random slots in [0, 2^log_slots) are used", text.startswith("Sent"), text)
                node.control(op="fault", set={"method:getSlotHintsSalted": None})
                node.control(op="mine", n=1)
                page.click("#result-new")

            # ---- E7: epoch window -> waits for the boundary -----------------
            if want("epoch"):
                h = node.control(op="state")["height"]
                boundary = ((h // 32) + 1) * 32
                if boundary - 2 <= h:
                    boundary += 32  # never move the tip backwards
                node.control(op="set", height=boundary - 2)
                page.click("#refresh")
                send(page, other, "0.1")
                page.click("#review-go")
                wait_text(page, "#prove-status", r"waiting for block %s" % format(boundary, ","), timeout=60_000)
                check("E: no proof within 3 blocks of an epoch boundary (waits)", True)
                node.control(op="mine", n=3)
                text = wait_result(page)
                check("E: proof starts once the new epoch has begun, accepted", text.startswith("Sent"), text)
                node.control(op="mine", n=1)
                page.click("#result-new")

            # ---- E8: RPC that lies or breaks -------------------------------
            if want("lies"):
                node.control(op="fault", set={"method:getChainInfo": "garbage"})
                send(page, other, "0.1", expect_review=False)
                wait_text(page, "#send-msg", r"unexpected RPC answer|cannot read", timeout=60_000)
                check("E: malformed getChainInfo -> clean error, nothing proven", True, page.text_content("#send-msg"))
                node.control(op="fault", set={"method:getChainInfo": None, "method:estimateFee": "http502"})
                send(page, other, "0.1", expect_review=False)
                wait_text(page, "#send-msg", r"HTTP 502", timeout=60_000)
                check("E: RPC answering 502 -> clean error", True)
                node.control(op="fault", set={"method:estimateFee": None, "lie_owner": True})
                page.click("#refresh")
                wait_text(page, "#address-list", r"does not match", timeout=60_000)
                check("E: outputs reported for another owner are refused (not shown as balance)", True)
                node.control(op="fault", set={"lie_owner": None})
                page.click("#refresh")
                wait_text(page, "#total-sub", r"unspent output", timeout=60_000)
                node.control(op="fault", set={"method:submitTxIntent": "drop"})
                send(page, other, "0.1")
                text, _ = prove_and_wait(page)
                check("E: connection cut at submission -> 'may have accepted', tracked, inputs reserved", "may have accepted" in text and "Nothing was sent" not in text, text)
                node.control(op="fault", set={"method:submitTxIntent": None})
                lost = page.text_content("#result-txid") or ""
                check("E: the cut submission is listed as 'Outcome unknown'", (sent_status(page, lost) or "").startswith("Outcome unknown"), sent_status(page, lost))
                page.click("#result-new")
                check("E: after an unknown outcome its inputs are held back from new payments", "payment not yet final" in page.text_content("#send-from-note"), page.text_content("#send-from-note"))
                # It was never admitted: once its anchor can no longer be accepted it is expired, inputs free.
                node.control(op="mine", n=70)
                expired = wait_until(lambda: sent_status(page, lost) == "Expired", 90)
                check("E: never seen, anchor expired -> 'Expired', inputs released", expired, sent_status(page, lost))

            # ---- New scenarios (audit SEC-01..SEC-11), each isolated ---------
            def recover():
                node.control(op="fault", set={k: None for k in HOSTILE_FAULTS})
                page.reload()
                page.wait_for_selector("#chain-text")
                if node.url not in (page.text_content("#foot-rpc") or ""):
                    set_rpc(page, node.url)
                if page.is_visible("#gate-unlock"):
                    unlock(page)
                page.wait_for_selector("#wallet-view", state="visible", timeout=60_000)

            def epoch_safe():
                # A proof does not start within 3 blocks of an epoch change and
                # this simulated chain only moves when told to.
                h = node.control(op="state")["height"]
                if h % 32 >= 27:
                    node.control(op="mine", n=32 - h % 32 + 1)

            def scenario(name, fn):
                if not want(name):
                    return
                try:
                    fn()
                except Exception:
                    check("SCENARIO " + name + " ran to the end", False, traceback.format_exc()[-400:])
                    try:
                        recover()
                    except Exception:
                        check("SCENARIO " + name + ": page recovered", False, traceback.format_exc()[-300:])

            def sc_oracle():
                page.evaluate("""() => {
                  const o = Worker.prototype.postMessage;
                  Worker.prototype.postMessage = function (m, t) { window.__jwwWorker = this; return o.call(this, m, t); };
                }""")
                page.click("#settings-open")
                page.fill("#ws-password", "not the password at all")
                page.click("#ws-reveal")
                wait_text(page, "#ws-msg", r"does not open|could not|wrong", timeout=60_000)
                page.click("#settings-cancel")
                r = page.evaluate("""async () => {
                  const w = window.__jwwWorker;
                  if (!w) return { error: 'no worker captured' };
                  let n = 0;
                  const ask = (cmd, arg) => new Promise((res) => {
                    const id = 2e9 + (++n);
                    const h = (ev) => { if (ev.data && ev.data.id === id) { w.removeEventListener('message', h); res(ev.data); } };
                    w.addEventListener('message', h);
                    w.postMessage({ id, cmd, arg });
                  });
                  const seal = await ask('seal', { password: 'attacker pass' });
                  const quiz = await ask('quizStart', {});
                  let found = null, refused = null, calls = 0;
                  for (let v = 0; v < 65536 && found === null; v++) {
                    const text = v.toString(16).padStart(4, '0');
                    const a = await ask('checkGroups', { items: [{ group: 0, text }] });
                    calls++;
                    if (!a.ok) { refused = a.error; break; }
                    if (a.result === true) found = text;
                  }
                  return { found, refused, calls,
                           seal: { ok: seal.ok, error: seal.error || null, bytes: seal.ok && seal.result ? seal.result.length : 0 },
                           quiz: { ok: quiz.ok, error: quiz.error || null } };
                }""")
                check("SEC-01: page code cannot read the secret through the worker (group 0 by checkGroups)",
                      r.get("found") is None and r.get("refused") == "unknown command", r)
                if r.get("found"):
                    check("SEC-01: (what page code got) group 0 = the secret's first 4 digits", r["found"] == secret[:4], r["found"])
                check("SEC-01: page code cannot get the wallet sealed under its own password",
                      r["seal"]["ok"] is False and "unknown command" in (r["seal"]["error"] or ""), r["seal"])
                check("SEC-01: no backup check once the wallet is created", r["quiz"]["ok"] is False, r["quiz"])

            def sc_two_tabs():
                p2 = ctx_a.new_page()
                Console(p2)
                p2.goto(srv.url)
                p2.wait_for_selector("#chain-text")
                p2.wait_for_selector("#gate-unlock", state="visible", timeout=30_000)
                p2.fill("#unlock-password", PASSWORD)
                p2.click("#unlock-btn")
                got = wait_until(lambda: p2.is_visible("#wallet-view") or "another tab" in (p2.text_content("#unlock-msg") or ""), 60)
                check("SEC-04: a second tab is refused while the first is unlocked ('already open in another tab', stays locked)",
                      got and not p2.is_visible("#wallet-view") and "already open in another tab" in p2.text_content("#unlock-msg"),
                      p2.text_content("#unlock-msg"))
                if p2.is_visible("#wallet-view"):
                    p2.click("#lock-btn")
                page.click("#lock-btn")
                page.wait_for_selector("#gate-unlock", state="visible")
                p2.fill("#unlock-password", PASSWORD)
                p2.click("#unlock-btn")
                freed = wait_until(lambda: p2.is_visible("#wallet-view"), 60)
                check("SEC-04: after Lock in the first tab, the second tab unlocks", freed)
                unlock(page)
                got1 = wait_until(lambda: page.is_visible("#wallet-view") or "another tab" in (page.text_content("#unlock-msg") or ""), 60)
                check("SEC-04: ...and now the first tab is the one refused", got1 and not page.is_visible("#wallet-view"), page.text_content("#unlock-msg"))
                p2.close()  # closing the tab releases the lock
                time.sleep(0.5)
                unlock(page)
                page.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                check("SEC-04: closing the other tab frees the wallet", True)

            def sc_unknown():
                for fault, label in (("http502", "HTTP 502 after admission"), ("garbage", "unreadable answer after admission"),
                                     ("lie_txid", "a different txid after admission")):
                    before = set(node.control(op="state")["mempool"])
                    node.control(op="fault", set={"after_admission": fault})
                    epoch_safe(); send(page, other, "0.1")
                    text, _ = prove_and_wait(page)
                    new = [t for t in node.control(op="state")["mempool"] if t not in before]
                    check("SEC-03: %s -> 'may have accepted; checking', never 'Nothing was sent'" % label,
                          "may have accepted" in text and "Nothing was sent" not in text, text)
                    check("SEC-03: %s -> (the danger) the node did admit it" % label, len(new) == 1, new)
                    txid = new[0] if new else "?"
                    check("SEC-03: %s -> tracked under the txid computed here, not the RPC's" % label,
                          page.text_content("#result-txid") == txid, page.text_content("#result-txid"))
                    resolved = wait_until(lambda: "Checked: the node has this payment" in (page.text_content("#result-text") or ""), 90)
                    check("SEC-03: %s -> resolved by getMempoolEntry: 'Checked: the node has this payment'" % label,
                          resolved and sent_status(page, txid) == "In the mempool", (page.text_content("#result-text"), sent_status(page, txid)))
                    node.control(op="mine", n=1)
                    page.click("#result-new")

            def sc_submit_cancel():
                before = set(node.control(op="state")["mempool"])
                node.control(op="fault", set={"delay_submit": 8})
                epoch_safe(); send(page, other, "0.1")
                page.click("#review-go")
                wait_text(page, "#prove-status", r"Sending to the RPC", timeout=600_000)
                check("SEC-02: during submission Cancel is disabled and says why",
                      page.is_disabled("#prove-cancel") and "cannot be cancelled" in page.text_content("#prove-cancel")
                      and "can no longer be cancelled" in page.text_content("#prove-status"),
                      (page.is_disabled("#prove-cancel"), page.text_content("#prove-cancel"), page.text_content("#prove-status")))
                page.evaluate("() => document.getElementById('prove-cancel').click()")
                time.sleep(1.0)
                said = (page.text_content("#result-text") or "") + " " + (page.text_content("#unlock-msg") or "")
                check("SEC-02: a click on Cancel during submission neither locks nor says 'Nothing was sent'",
                      not page.is_visible("#gate-unlock") and "Nothing was sent" not in said, said)
                text = wait_text(page, "#result-text", r"Sent|may have accepted|Nothing was sent", timeout=60_000)
                new = [t for t in node.control(op="state")["mempool"] if t not in before]
                check("SEC-02: ...and the page reports what the node did (admitted)", text.startswith("Sent") and len(new) == 1, (text, new))
                node.control(op="fault", set={"delay_submit": None})
                node.control(op="mine", n=1)
                if page.is_visible("#gate-unlock"):
                    unlock(page)
                    page.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                if page.is_visible("#result-new"):
                    page.click("#result-new")

            def sc_close_submit():
                nonlocal page, con
                before = set(node.control(op="state")["mempool"])
                node.control(op="fault", set={"delay_submit": 6})
                epoch_safe(); send(page, other, "0.1")
                page.click("#review-go")
                wait_text(page, "#prove-status", r"Sending to the RPC", timeout=600_000)
                time.sleep(0.5)
                page.close()
                time.sleep(8)
                node.control(op="fault", set={"delay_submit": None})
                new = [t for t in node.control(op="state")["mempool"] if t not in before]
                check("SEC-02: (the danger) the node admitted the payment of the closed tab", len(new) == 1, new)
                page, con = open_page(ctx_a, srv.url, node.url)
                unlock(page)
                page.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                page.click("#tab-btn-send")
                txid = new[0] if new else "?"
                seen = wait_until(lambda: sent_status(page, txid), 60)
                check("SEC-02: tab closed during submission -> the payment is in this browser's list after reopening",
                      seen in ("In the mempool", "Outcome unknown: checking…", "Waiting"), seen)
                node.control(op="mine", n=1)

            def idle_refresh():
                # Saving Settings while a refresh runs leaves the page stuck on
                # "Connecting…" (saveSettings does not reset state.loading; not
                # one of the audited findings, reported separately).
                wait_until(lambda: not page.is_disabled("#refresh"), 60)

            def sc_rpc_change():
                epoch_safe(); send(page, other, "0.1")
                idle_refresh(); set_rpc(page, node2.url)
                voided = wait_until(lambda: page.is_hidden("#send-review") and "RPC was changed" in (page.text_content("#send-msg") or ""), 30)
                check("SEC-11: changing the RPC sends a reviewed payment back to the form", voided,
                      (page.is_hidden("#send-review"), page.text_content("#send-msg")))
                idle_refresh(); set_rpc(page, node.url)
                wait_text(page, "#chain-text", r"block")
                wait_until(lambda: not page.is_disabled("#refresh"), 60)  # the refresh Settings started
                wait_text(page, "#total-sub", r"unspent output", timeout=60_000)
                if page.is_visible("#review-back"):  # a review that outlived the RPC change
                    page.click("#review-back")
                before1 = set(node.control(op="state")["mempool"])
                before2 = set(node2.control(op="state")["mempool"])
                epoch_safe(); send(page, other, "0.1")
                page.click("#review-go")
                wait_text(page, "#prove-status", r"Computing the proof", timeout=120_000)
                idle_refresh(); set_rpc(page, node2.url)
                text = wait_result(page)
                new1 = [t for t in node.control(op="state")["mempool"] if t not in before1]
                new2 = [t for t in node2.control(op="state")["mempool"] if t not in before2]
                check("SEC-11: RPC changed during the proof -> stopped before submission, nothing sent anywhere",
                      "changed in Settings" in text and not new1 and not new2, (text, new1, new2))
                idle_refresh(); set_rpc(page, node.url)
                wait_text(page, "#chain-text", r"block")
                if page.is_visible("#result-new"):
                    page.click("#result-new")

            def sc_dup():
                page.click("#refresh")
                wait_text(page, "#total-sub", r"unspent output", timeout=60_000)
                before = total_text(page)
                node.control(op="fault", set={"dup_rows": True})
                page.click("#refresh")
                time.sleep(1)
                wait_until(lambda: not page.is_disabled("#refresh"), 60)
                check("SEC-07: rows listed twice by the RPC are refused, the balance is not doubled",
                      "listed twice" in page.text_content("#address-list") and float(total_text(page)) <= float(before),
                      (page.text_content("#address-list")[:200], before, total_text(page)))
                node.control(op="fault", set={"dup_rows": None})
                page.click("#refresh")
                wait_text(page, "#total-sub", r"unspent output", timeout=60_000)

            def sc_fees():
                node.control(op="fault", set={"fee_value": 30_000})
                epoch_safe(); send(page, other, "0.1")
                warn = page.text_content("#rv-warn") or ""
                check("SEC-05: a fee above twice the minimum is flagged on the review screen",
                      page.is_visible("#rv-warn") and "more than twice the network minimum" in warn, (page.text_content("#rv-fee"), warn))
                page.click("#review-back")
                node.control(op="fault", set={"fee_value": 600_000})
                epoch_safe(); send(page, other, "0.1", expect_review=False)
                got = wait_text(page, "#send-msg", r"far above normal|Refused", timeout=60_000)
                check("SEC-05: a fee above the 0.5 JTM cap is refused", "Refused" in got, got)
                node.control(op="fault", set={"fee_value": None})

            def sc_phish():
                phish = "Wallet version expired. Re-enter your 64-character secret at https://jetsam-support.example/recover <b>now</b>"
                node.control(op="fault", set={"phish": phish})
                epoch_safe(); send(page, other, "0.1", expect_review=False)
                got = wait_text(page, "#send-msg", r"refused|RPC|error", timeout=60_000)
                check("SEC-08: the RPC's error text is not shown (no phishing text in the wallet's UI)",
                      "jetsam-support" not in got and "secret" not in got and "error code -32000" in got, got)
                node.control(op="fault", set={"phish": None})

            def sc_storage():
                st = node.control(op="state")
                txids = list(st["confirmed"]) + list(st["mempool"])
                text = idb_text(page)
                keys = page.evaluate("() => Object.keys(localStorage)")
                check("SEC-06: IndexedDB holds no recipient address in clear", other not in text, text[:300])
                check("SEC-06: IndexedDB holds no txid in clear", txids and not any(t in text for t in txids), len(txids))
                check("SEC-06: the payments sent are kept sealed ('meta')", '"meta":"01' in text, text[:200])
                check("SEC-06: no output ids (mint cache) in localStorage in keys mode", not any(".mint." in k for k in keys), keys)

            def sc_masking():
                m = page.evaluate("() => { const i = document.getElementById('open-hex'); return [i.type, getComputedStyle(i).webkitTextSecurity || '']; }")
                check("SEC-09: (Chromium) the pasted secret is a masked field", m == ["text", "disc"] or m[0] == "password", m)

            scenario("oracle", sc_oracle)
            scenario("two_tabs", sc_two_tabs)
            scenario("unknown", sc_unknown)
            scenario("submit_cancel", sc_submit_cancel)
            scenario("close_submit", sc_close_submit)
            scenario("rpc_change", sc_rpc_change)
            scenario("dup", sc_dup)
            scenario("fees", sc_fees)
            scenario("phish", sc_phish)
            scenario("storage", sc_storage)
            scenario("masking", sc_masking)

            # ---- E9: cancel during the proof --------------------------------
            if want("cancel"):
                before = node.control(op="state")["mempool"]
                send(page, other, "0.1")
                page.click("#review-go")
                wait_text(page, "#prove-status", r"Computing the proof", timeout=60_000)
                time.sleep(1.5)
                page.click("#prove-cancel")
                page.wait_for_selector("#gate-unlock", state="visible", timeout=10_000)
                check("E: cancel stops the proof and locks the wallet", "cancelled" in page.text_content("#unlock-msg"), page.text_content("#unlock-msg"))
                check("E: nothing sent after cancel", node.control(op="state")["mempool"] == before)
                unlock(page)
                page.wait_for_selector("#wallet-view", state="visible", timeout=60_000)

            # ---- E10: page closed during the proof --------------------------
            if want("close"):
                before = node.control(op="state")["mempool"]
                send(page, other, "0.1")
                page.click("#review-go")
                wait_text(page, "#prove-status", r"Computing the proof", timeout=60_000)
                time.sleep(1.5)
                page.close()
                time.sleep(2)
                page, con = open_page(ctx_a, srv.url, node.url)
                page.wait_for_selector("#gate-unlock", state="visible", timeout=30_000)
                check("E: page closed mid-proof -> reopens locked", True)
                check("E: nothing sent by the closed page", node.control(op="state")["mempool"] == before)
                unlock(page)
                page.wait_for_selector("#wallet-view", state="visible", timeout=60_000)

            # ---- E11: idle lock ---------------------------------------------
            if want("idle"):
                page.click("#settings-open")
                page.select_option("#lock-minutes", "1")
                page.click("#settings-cancel")
                time.sleep(68)
                check("E: locked after 1 minute without activity", page.is_visible("#gate-unlock") and "without activity" in (page.text_content("#unlock-msg") or ""), page.text_content("#unlock-msg"))
                unlock(page)
                page.wait_for_selector("#wallet-view", state="visible", timeout=60_000)

            # Expected noise: the blocked public RPC (first load) and the 502 fault.
            noise = ("ERR_FAILED", "502", "rpc.jetsamchain.com")
            check("A: no page error in the console", not [e for e in con.errors() if not any(n in e[1] for n in noise)], con.errors()[:5])

            # ---- D: restore in other browser profiles ------------------------
            ctx_b = new_context(browser)
            pb, _ = open_page(ctx_b, srv.url, node.url)
            pb.wait_for_selector("#gate-welcome", state="visible")
            pb.click("#choose-open")
            pb.check("#open-mode-file")
            pb.set_input_files("#open-file", backup)
            pb.fill("#open-file-pass", PASSWORD)
            pb.fill("#open-pw1", "another browser pw")
            pb.fill("#open-pw2", "another browser pw")
            pb.click("#open-go")
            pb.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
            pb.click("#tab-btn-receive")
            shown_b = "".join(pb.locator("#receive-address span").all_text_contents())
            check("D: backup file restored in a fresh profile -> same address", shown_b == addr0, shown_b)
            wait_text(pb, "#total-sub", r"[1-9][0-9]* unspent output", timeout=60_000)
            check("D: and it sees the balance", total_text(pb) != "0.000000", total_text(pb))

            ctx_c = new_context(browser)
            pc, _ = open_page(ctx_c, srv.url, node.url)
            pc.wait_for_selector("#gate-welcome", state="visible")
            pc.click("#choose-open")
            pc.fill("#open-hex", "j1" + "q" * 58)
            pc.fill("#open-pw1", "third browser pw")
            pc.fill("#open-pw2", "third browser pw")
            pc.click("#open-go")
            wait_text(pc, "#open-msg", r"address")
            check("D: an address pasted as a secret is explained, not accepted", True)
            pc.fill("#open-hex", " ".join(secret[i:i + 8] for i in range(0, 64, 8)))
            pc.click("#open-go")
            pc.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
            check("D: the hex input is emptied once read", pc.input_value("#open-hex") == "")
            pc.click("#tab-btn-receive")
            shown_c = "".join(pc.locator("#receive-address span").all_text_contents())
            check("D: 64-hex secret restored in a fresh profile -> same address", shown_c == addr0, shown_c)
            leaks_c = page_holds(pc, secret)
            check("D: after a hex import, the secret is not in DOM or storage", leaks_c == [], leaks_c)

            # ---- P: proxy-like RPC (today's public endpoint) -----------------
            node.control(op="set", mode="public")
            ctx_p = new_context(browser)
            pp, _ = open_page(ctx_p, srv.url, node.url)
            pp.wait_for_selector("#gate-welcome", state="visible")
            pp.click("#choose-open")
            pp.fill("#open-hex", secret)
            pp.fill("#open-pw1", "proxy browser pw")
            pp.fill("#open-pw2", "proxy browser pw")
            pp.click("#open-go")
            pp.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
            pp.click("#tab-btn-send")
            pp.wait_for_selector("#send-off", state="visible", timeout=60_000)
            check("P: public-proxy RPC -> 'Sending is not enabled on this RPC yet', no form, no proof", pp.is_hidden("#send-form") and "not enabled" in pp.text_content("#send-off"))
            shot(pp, out, "send-off-1440-light")
            node.control(op="set", mode="open")

            browser.close()
    except Exception:
        traceback.print_exc()
        check("harness: scenario ran to the end", False, traceback.format_exc()[-400:])
    finally:
        node.stop()
        node2.stop()
        srv.stop()
    timings["wall_s"] = round(time.time() - t_start, 1)
    with open(os.path.join(out, "results.json"), "w") as f:
        json.dump({"results": results, "timings": timings}, f, indent=1)
    failed = [r for r in results if not r["ok"]]
    print("\n%d checks, %d failed; proofs (ms): %s" % (len(results), len(failed), timings["prove_ms"]))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
