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
from harness import FakeNode, StaticServer, build_page, route_reference, Console, set_rpc, wait_text, ROOT, HERE  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PASSWORD = "tide gauge harbour 7"
OTHER_SEED = "11" * 32  # throw-away recipient seed
SEED_W1 = "22" * 32  # throw-away wallets of the SEC2 scenarios
SEED_W2 = "44" * 32
results = []
timings = {"prove_ms": []}
REFERENCE = {"url": None}  # the simulated node standing in for the public RPC (SEC3-01)


def check(name, cond, detail=""):
    results.append({"check": name, "ok": bool(cond), "detail": str(detail)[:500]})
    print(("PASS " if cond else "FAIL ") + name + ((" — " + str(detail)[:200]) if detail else ""), flush=True)
    return cond


def keytool(*args):
    out = subprocess.run(["node", os.path.join(HERE, "keytool.cjs"), *args], check=True, capture_output=True, text=True)
    return out.stdout


def addresses_of(hex_secret, kind, network, start, count):
    return [a["bech32"] for a in json.loads(keytool("addresses", hex_secret, kind, network, str(start), str(count)))["addresses"]]


def new_context(browser, viewport=(1440, 900), scheme="light", default_url=None):
    ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, accept_downloads=True, color_scheme=scheme)
    # The real RPC hosts never reach the network: the public one is answered
    # by the simulated node's honest view; with `default_url`, the wallet RPC
    # (the default) and the public RPC by that simulated node, else the
    # wallet RPC is blocked.
    route_reference(ctx, REFERENCE["url"], default_url)
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
                  "method:estimateFee", "method:getChainInfo", "lie_owner", "lie_refuse", "lie_tip", "hide_mempool",
                  "delay_slots", "bad_mempool_entry", "no_block_at", "hide_tx", "ref_down", "ref_hide"]


def time_travel(page, minutes):
    """Move this page's clock (Date.now) forward: what the wallet would see
    after that much wall-clock time, without waiting for it. A key press in
    the same task keeps the idle lock from counting that time as inactivity."""
    page.evaluate("""(ms) => {
      const o = Date.now; Date.now = () => o() + ms;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    }""", int(minutes * 60_000))


def submissions(node):
    """Non-empty submitTxIntent requests the node received since the last call."""
    reqs = node.control(op="requests", clear=True)["requests"]
    return sum(1 for r in reqs if '"method":"jetsam_submitTxIntent"' in r and '"params":[""]' not in r)


def idb_patch(page, js_body):
    """Rewrite the stored mainnet record in place: js_body is a function body
    of (r) returning the new record (as another tab or a damaged disk would)."""
    return page.evaluate("""async (src) => {
      const mut = new Function("r", src);
      const db = await new Promise((res, rej) => { const q = indexedDB.open("jetsam-wallet"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const tx = db.transaction("wallets", "readwrite");
      const st = tx.objectStore("wallets");
      const rec = await new Promise((res) => { const q = st.get("mainnet"); q.onsuccess = () => res(q.result); });
      const out = mut(rec);
      if (out === null) st.delete("mainnet"); else st.put(out);
      await new Promise((res) => { tx.oncomplete = res; });
      db.close();
      return true;
    }""", js_body)


def open_hex(page, seed, password=PASSWORD):
    page.wait_for_selector("#gate-welcome", state="visible")
    page.click("#choose-open")
    page.fill("#open-hex", seed)
    page.fill("#open-pw1", password)
    page.fill("#open-pw2", password)
    page.click("#open-go")


def sent_item(page, txid):
    """Whole text of the 'Sent from this browser' entry for txid, or ''."""
    return page.evaluate("""(txid) => {
      for (const li of document.querySelectorAll('#sent-list li')) if (li.textContent.includes(txid)) return li.textContent;
      return '';
    }""", txid)


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


def send(page, to, amount, *, expect_review=True, confirm_repeat=True):
    page.click("#tab-btn-send")
    page.wait_for_selector("#send-form", state="visible")
    # Pay from address #0, the funded one: a scenario may have added (and made
    # active) a new, empty address meanwhile (SEC2-03, SEC2-04).
    page.select_option("#send-from", index=0)
    page.fill("#send-to", to)
    page.fill("#send-amount", amount)
    page.click("#send-review-btn")
    if not expect_review:
        return None
    try:
        page.wait_for_selector("#send-review", state="visible", timeout=60_000)
    except Exception:
        raise AssertionError("no review screen: " + (page.text_content("#send-msg") or "") + " | " + (page.text_content("#send-from-note") or ""))
    # The scenarios pay the same recipient again and again, some of those
    # payments held: the user confirms paying again (SEC3-01), except where
    # that warning is what is tested.
    if confirm_repeat and page.is_visible("#rv-repeat"):
        page.check("#rv-repeat-ok")
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
    REFERENCE["url"] = node.url
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
            # The refresh started at unlock may already show the outputs: read
            # the screen once the refresh this click starts is over (the
            # button is enabled again).
            wait_until(lambda: page.is_enabled("#refresh") and re.search(r"\b3 unspent outputs\b", page.text_content("#total-sub") or ""), 60)
            check("B: balance is exact (8 JTM, coinbase creation_id > 2^53 kept)", total_text(page) == "8.000000", total_text(page))
            check("B: the fresh coinbase is marked provisional", "provisional" in page.text_content("#total-sub"), page.text_content("#total-sub"))
            # More outputs for the scenarios below: some leave inputs held
            # (refused or unknown payments stay reserved until they expire).
            for _ in range(6):
                node.control(op="fund", owner=addr0, value=3_000_000, coinbase=True, height=tip - 30)
            page.click("#refresh")
            wait_text(page, "#total-sub", r"9 unspent outputs")
            # A refresh re-reading the address keeps its last balance on screen,
            # marked "reading…", instead of dropping the total to 0.
            known = wait_until(lambda: page.is_enabled("#refresh") and "reading" not in (page.text_content("#total-sub") or "")
                               and re.search(r"\b9 unspent outputs\b", page.text_content("#total-sub") or "") and total_text(page), 60)
            node.control(op="fault", set={"delay_slots": 4})
            page.click("#refresh")
            during = wait_until(lambda: "reading" in (page.text_content("#total-sub") or "") and (total_text(page), page.text_content("#total-sub")), 30)
            node.control(op="fault", set={"delay_slots": None})
            check("B: during a refresh the total keeps the last known balance, marked 'reading…'",
                  bool(known) and bool(during) and during[0] == known and "9 unspent outputs" in during[1], (known, during))
            after = wait_until(lambda: page.is_enabled("#refresh") and "reading" not in (page.text_content("#total-sub") or "") and total_text(page), 60)
            check("B: ...and the same balance once the refresh is over", after == known, (known, after))
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
                # Two reads a minute apart, the block checked (SEC3-02).
                wait_text(page, "#sent-list", r"Final", timeout=180_000)
                check("C: final at 9 confirmations", True)
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
                wait_text(page, "#send-to-msg", r"testnet address")
                check("E: a testnet address (tj1…) is refused by name: the wallet is mainnet only",
                      "mainnet only" in (page.text_content("#send-to-msg") or ""), page.text_content("#send-to-msg"))
                send(page, other.replace("a", "а", 1), "1", expect_review=False)
                wait_text(page, "#send-to-msg", r"look-alike")
                check("E: look-alike character refused", True)
                send(page, other, "1,5", expect_review=False)
                wait_text(page, "#send-amount-msg", r"dot")
                check("E: comma amount refused", True)
                send(page, other, "1000", expect_review=False)
                wait_text(page, "#send-msg", r"Not enough")
                check("E: insufficient funds refused before proving, saying what is spendable now",
                      "JTM is spendable now" in (page.text_content("#send-msg") or ""), page.text_content("#send-msg"))
                check("E: mainnet recipient placeholder is j1…", page.get_attribute("#send-to", "placeholder") == "j1…",
                      page.get_attribute("#send-to", "placeholder"))

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
                # The note reads 0 while a refresh is in flight (the address is
                # being re-read): wait for the refresh rather than racing it.
                held = wait_until(lambda: "payment not yet final" in (page.text_content("#send-from-note") or ""), 30)
                check("E: after an unknown outcome its inputs are held back from new payments", held, page.text_content("#send-from-note"))
                # It was never admitted: once its anchor can no longer be accepted it is expired, inputs free.
                node.control(op="mine", n=70)
                time_travel(page, 30)  # 70 blocks take more than an hour: an expiry sooner is not believed (SEC2-02)
                expired = wait_until(lambda: sent_status(page, lost) == "Expired", 150)
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

            # ---- Re-review scenarios (SEC2-01..SEC2-07) ----------------------
            def refresh_idle(pg=None):
                pg = pg or page
                wait_until(lambda: not pg.is_disabled("#refresh"), 60)
                pg.click("#refresh")
                wait_until(lambda: not pg.is_disabled("#refresh"), 60)

            def sc_double_click():
                epoch_safe(); refresh_idle()
                before = set(node.control(op="state")["mempool"])
                submissions(node)
                send(page, other, "0.1")
                page.evaluate("() => { const b = document.getElementById('review-go'); b.click(); b.click(); }")
                wait_result(page)
                time.sleep(3)
                wait_until(lambda: not page.is_visible("#send-progress"), 300)
                time.sleep(3)
                new = [t for t in node.control(op="state")["mempool"] if t not in before]
                n = submissions(node)
                check("SEC2-07: two synchronous clicks on 'Prove and send' -> one proof, one submission", n == 1 and len(new) == 1, (n, new))
                node.control(op="mine", n=1)
                if page.is_visible("#result-new"):
                    page.click("#result-new")

            def sc_settings_refresh():
                wait_until(lambda: not page.is_disabled("#refresh"), 60)
                node.control(op="fault", set={"delay_slots": 5})
                page.click("#refresh")
                time.sleep(0.5)
                set_rpc(page, node.url)  # Settings saved (same URL) while the refresh waits
                node.control(op="fault", set={"delay_slots": None})
                ok = wait_until(lambda: not page.is_disabled("#refresh") and "block" in (page.text_content("#chain-text") or ""), 40)
                check("SEC2-05: Settings saved during a refresh -> the page refreshes again, not stuck on 'Connecting…'",
                      ok, (page.text_content("#chain-text"), page.is_disabled("#refresh")))
                if not ok:
                    recover()

            def sc_lie_refused():
                # (a) admitted, then answered "consensus: SlotConflict" once; the RPC is honest afterwards.
                epoch_safe(); refresh_idle()
                before = set(node.control(op="state")["mempool"])
                submissions(node)
                node.control(op="fault", set={"lie_refuse": "consensus: SlotConflict"})
                send(page, other, "0.1")
                text, _ = prove_and_wait(page)
                new = [t for t in node.control(op="state")["mempool"] if t not in before]
                n = submissions(node)
                txid = page.text_content("#result-txid") or ""
                check("SEC2-01: admitted then answered 'SlotConflict' -> never 'Nothing was sent'",
                      "Nothing was sent" not in text and len(new) == 1, (text, new))
                check("SEC2-01: ...found by its txid: reported sent, and the RPC's refusal flagged as unreliable",
                      text.startswith("Sent") and "not reliable" in text and new and txid == new[0], (text, txid))
                check("SEC2-01: ...no second proof was submitted", n == 1, n)
                page.click("#result-new")
                check("SEC2-01: ...its inputs stay held", "payment not yet final" in (page.text_content("#send-from-note") or ""),
                      page.text_content("#send-from-note"))
                node.control(op="mine", n=1)
                # (b) the same lie, and the mempool hidden: the wallet cannot see the payment.
                epoch_safe(); refresh_idle()
                before = set(node.control(op="state")["mempool"])
                submissions(node)
                node.control(op="fault", set={"lie_refuse": "consensus: SlotConflict", "hide_mempool": True})
                send(page, other, "0.1")
                text, _ = prove_and_wait(page)
                new = [t for t in node.control(op="state")["mempool"] if t not in before]
                n = submissions(node)
                check("SEC2-01: lie + hidden mempool -> 'the RPC says it refused', never 'Nothing was sent'",
                      "Nothing was sent" not in text and "says it refused" in text, text)
                check("SEC2-01: ...the node holds exactly one of the payment's proofs (no double payment)", len(new) == 1, (new, n))
                first = new[0] if new else "?"
                st = sent_status(page, first) or ""
                check("SEC2-01: ...the admitted proof is listed, held as 'refused by the RPC'", st.startswith("Refused by the RPC"), st)
                page.click("#result-new")
                check("SEC2-01: ...its inputs stay held", "payment not yet final" in (page.text_content("#send-from-note") or ""),
                      page.text_content("#send-from-note"))
                node.control(op="fault", set={"hide_mempool": None})
                node.control(op="mine", n=1)
                ok = wait_until(lambda: sent_status(page, first) == "Confirmed", 60)
                check("SEC2-01: ...once visible it is 'Confirmed', with a note that the RPC had said refused",
                      ok and "said it refused" in sent_item(page, first), sent_item(page, first)[:200])

            def set_crosscheck(on):
                """Settings: look payments up on the public RPC too (default on)."""
                wait_until(lambda: not page.is_disabled("#refresh"), 60)
                page.click("#settings-open")
                if page.is_checked("#rpc-crosscheck") != on:
                    page.click("#rpc-crosscheck")
                page.click("#settings-save")
                wait_text(page, "#chain-text", r"block")
                wait_until(lambda: not page.is_disabled("#refresh"), 60)

            def sc_lie_tip():
                # (a) a short lie: tip +200 and a hidden mempool for 40 s.
                epoch_safe(); refresh_idle()
                send(page, other, "0.1")
                text, _ = prove_and_wait(page)
                txid = page.text_content("#result-txid") or ""
                page.click("#result-new")
                node.control(op="fault", set={"lie_tip": 200, "hide_mempool": True})
                time.sleep(40)
                st = sent_status(page, txid)
                note = page.text_content("#send-from-note") or ""
                check("SEC2-02: tip +200 and a hidden mempool for 40 s -> not 'Expired', inputs still held",
                      st != "Expired" and "payment not yet final" in note, (st, note))
                node.control(op="fault", set={"lie_tip": None, "hide_mempool": None})
                node.control(op="mine", n=1)
                ok = wait_until(lambda: sent_status(page, txid) == "Confirmed", 60)
                check("SEC2-02: ...then mined: 'Confirmed'", ok, sent_status(page, txid))
                # (b) a lie that lasts: 30 min of wall clock (simulated), blocks served up to the claimed tip.
                # With the cross-check on, the public RPC sees the payment and
                # nothing is released (SEC3-01, tested below); this part checks
                # SEC2-02 itself, with the cross-check off in Settings.
                set_crosscheck(False)
                epoch_safe(); refresh_idle()
                send(page, other, "0.1")
                text, _ = prove_and_wait(page)
                txid2 = page.text_content("#result-txid") or ""
                page.click("#result-new")
                time_travel(page, 30)
                node.control(op="fault", set={"lie_tip": 200, "hide_mempool": True})
                mid = wait_until(lambda: (sent_status(page, txid2) or "").startswith("May still be mined"), 60)
                check("SEC2-02: an expiry first reported is only a doubt: 'may still be mined; checking', inputs held",
                      mid and "payment not yet final" in (page.text_content("#send-from-note") or ""), sent_status(page, txid2))
                exp = wait_until(lambda: sent_status(page, txid2) == "Expired", 150)
                check("SEC2-02: ...confirmed by two reads a minute apart -> 'Expired'", exp, sent_status(page, txid2))
                node.control(op="fault", set={"lie_tip": None, "hide_mempool": None})
                node.control(op="mine", n=1)
                # An expired payment is looked up one round in 8 (SEC3-06): ~2 min.
                ok = wait_until(lambda: sent_status(page, txid2) == "Confirmed", 200)
                check("SEC2-02: 'Expired' is re-checked: found mined later -> 'Confirmed', with a note",
                      ok and "reported this payment expired" in sent_item(page, txid2), sent_item(page, txid2)[:200])
                recover()  # back to the real clock
                set_crosscheck(True)

            def sc_meta_broken():
                epoch_safe(); refresh_idle()
                send(page, other, "0.1")
                text, _ = prove_and_wait(page)
                txid = page.text_content("#result-txid") or ""
                page.click("#result-new")
                page.click("#lock-btn")
                page.wait_for_selector("#gate-unlock", state="visible")
                good = json.loads(idb_text(page))[0]["meta"]
                idb_patch(page, "r.meta[30] ^= 1; return r;")
                bad = json.loads(idb_text(page))[0]["meta"]
                page.reload()
                page.wait_for_selector("#chain-text")
                unlock(page)
                page.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                page.click("#tab-btn-send")
                time.sleep(1)
                banner = page.text_content("#send-history") if page.is_visible("#send-history") else ""
                check("SEC2-03: a payment history that does not open is reported, not shown as empty",
                      "could not be read" in banner and "could not be read" in (page.text_content("#keys-msg") or ""),
                      (banner[:200], page.text_content("#keys-msg")))
                check("SEC2-03: ...and sending is blocked while the reservations are unknown",
                      page.is_hidden("#send-form") and page.is_hidden("#send-review"), page.is_visible("#send-form"))
                check("SEC2-03: ...the banner offers: try again, restore from the backup, wait for the anchor to expire",
                      page.is_visible("#history-retry") and "backup" in banner and "hours" in banner, banner[:300])
                page.click("#addr-new")  # a write of another field
                time.sleep(16)  # and a tracking round
                check("SEC2-03: ...the unreadable history is never overwritten", json.loads(idb_text(page))[0]["meta"] == bad)
                idb_patch(page, "r.meta = Uint8Array.from(%s.match(/../g), (h) => parseInt(h, 16)); return r;" % json.dumps(good))
                page.click("#history-retry")
                back = wait_until(lambda: page.is_hidden("#send-history") and sent_status(page, txid) is not None and page.is_visible("#send-form"), 30)
                check("SEC2-03: 'Try again' once the history opens: list back, sending allowed", back, sent_status(page, txid))
                node.control(op="mine", n=1)
                # The record cannot be written before the payment leaves (removed meanwhile): it does not leave.
                epoch_safe(); refresh_idle()
                before = set(node.control(op="state")["mempool"])
                submissions(node)
                send(page, other, "0.1")
                page.evaluate("""async () => {
                  const db = await new Promise((res) => { const q = indexedDB.open('jetsam-wallet'); q.onsuccess = () => res(q.result); });
                  const tx = db.transaction('wallets', 'readwrite');
                  const st = tx.objectStore('wallets');
                  window.__jwwRecord = await new Promise((res) => { const q = st.get('mainnet'); q.onsuccess = () => res(q.result); });
                  st.delete('mainnet');
                  await new Promise((res) => { tx.oncomplete = res; });
                  db.close();
                }""")
                text, _ = prove_and_wait(page)
                new = [t for t in node.control(op="state")["mempool"] if t not in before]
                n = submissions(node)
                check("SEC2-03: the payment could not be recorded before sending -> not sent, and said so",
                      "could not be recorded" in text and n == 0 and not new, (text, n, new))
                page.evaluate("""async () => {
                  const db = await new Promise((res) => { const q = indexedDB.open('jetsam-wallet'); q.onsuccess = () => res(q.result); });
                  const tx = db.transaction('wallets', 'readwrite');
                  tx.objectStore('wallets').put(window.__jwwRecord);
                  await new Promise((res) => { tx.oncomplete = res; });
                  db.close();
                }""")
                page.click("#result-new")

            def sc_welcome_tab():
                ctx_w = new_context(browser)
                try:
                    ta, _ = open_page(ctx_w, srv.url, node.url)
                    ta.wait_for_selector("#gate-welcome", state="visible")
                    tb, _ = open_page(ctx_w, srv.url, node.url)
                    open_hex(tb, SEED_W1)
                    tb.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                    w1 = addresses_of(SEED_W1, "seed", "mainnet", 0, 1)[0]
                    h = node.control(op="state")["height"]
                    node.control(op="fund", owner=w1, value=3_000_000, coinbase=True, height=h - 30)
                    epoch_safe(); refresh_idle(tb)
                    send(tb, other, "0.1")
                    text, _ = prove_and_wait(tb)
                    txid = tb.text_content("#result-txid") or ""
                    tb.click("#result-new")
                    tb.click("#lock-btn")
                    tb.wait_for_selector("#gate-unlock", state="visible")
                    # Snapshot once locked: until then the first tab itself may
                    # still save its payment history (tracking).
                    record = idb_text(tb)
                    open_hex(ta, SEED_W2, "other password 22")
                    said = wait_until(lambda: ta.is_visible("#wallet-view") or "already" in ((ta.text_content("#open-msg") or "") + (ta.text_content("#unlock-msg") or "")), 60)
                    msgs = (ta.text_content("#open-msg") or "") + (ta.text_content("#unlock-msg") or "")
                    check("SEC2-04: a tab left on 'Welcome' cannot open another secret over the stored wallet",
                          said and not ta.is_visible("#wallet-view") and "already" in msgs and "storage is blocked" not in msgs, msgs)
                    check("SEC2-04: ...the stored record is untouched (key, history, indexes)", idb_text(ta) == record)
                    unlock(tb)
                    tb.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                    tb.click("#tab-btn-send")
                    seen = wait_until(lambda: sent_status(tb, txid), 30)
                    # Locking cleared the outputs read; the note shows the
                    # reservation once the address is read again after unlock.
                    held = wait_until(lambda: "payment not yet final" in (tb.text_content("#send-from-note") or ""), 60)
                    check("SEC2-04: ...the first tab still has its payment and its reservation",
                          seen and held, (seen, tb.text_content("#send-from-note")))
                    # The record replaced under an unlocked tab (another wallet's key): no write lands in it.
                    idb_patch(tb, "r.sealed = r.sealed.slice(); r.sealed[60] ^= 1; return r;")
                    replaced = idb_text(tb)
                    tb.click("#addr-new")
                    time.sleep(2)
                    check("SEC2-04: a record replaced under an unlocked tab is not written to, and the tab says so",
                          idb_text(tb) == replaced and "no longer saved" in (tb.text_content("#keys-msg") or ""), tb.text_content("#keys-msg"))
                    node.control(op="mine", n=1)
                finally:
                    ctx_w.close()

            def sc_lease():
                c2 = new_context(browser)
                try:
                    c2.add_init_script("Object.defineProperty(navigator, 'locks', { get: () => undefined });")
                    pa, _ = open_page(c2, srv.url, node.url)
                    open_hex(pa, SEED_W1)
                    pa.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                    pb = c2.new_page()
                    pb.goto(srv.url)
                    pb.wait_for_selector("#gate-unlock", state="visible", timeout=30_000)
                    # The holder's timers stop (a throttled or frozen background tab).
                    pa.evaluate("() => { for (let i = 1; i < 100000; i++) clearInterval(i); }")
                    time_travel(pb, 0.5)
                    unlock(pb)
                    got = wait_until(lambda: pb.is_visible("#wallet-view") or "another tab" in (pb.text_content("#unlock-msg") or ""), 60)
                    check("SEC2-06: lease fallback: a holder silent for 30 s still holds the wallet",
                          got and not pb.is_visible("#wallet-view"), pb.text_content("#unlock-msg"))
                    time_travel(pb, 1.5)  # well past any renewal the holder made before it froze
                    unlock(pb)
                    took = wait_until(lambda: pb.is_visible("#wallet-view"), 60)
                    check("SEC2-06: ...after more than 60 s the lease is taken over by the other tab", took)
                    record = idb_text(pb)
                    pa.click("#addr-new")
                    time.sleep(2)
                    check("SEC2-06: the tab that lost its lease writes nothing and locks itself",
                          idb_text(pb) == record and pa.is_visible("#gate-unlock") and "another tab" in (pa.text_content("#unlock-msg") or ""),
                          (idb_text(pb) == record, pa.is_visible("#gate-unlock"), pa.text_content("#unlock-msg")))
                finally:
                    c2.close()

            # ---- Audit-3 scenarios (SEC3-01..SEC3-04) -------------------------
            def send_ok(note=""):
                """One honest payment of 0.1 JTM; returns its txid."""
                epoch_safe(); refresh_idle()
                send(page, other, "0.1")
                text, _ = prove_and_wait(page)
                txid = page.text_content("#result-txid") or ""
                page.click("#result-new")
                if not text.startswith("Sent"):
                    raise AssertionError("payment not accepted: " + text[:200])
                return txid

            def held_note():
                """The 'Spendable now' note, once it shows held funds (it reads
                0 while a refresh re-reads the address: wait, do not race it)."""
                wait_until(lambda: "payment not yet final" in (page.text_content("#send-from-note") or ""), 30)
                return page.text_content("#send-from-note") or ""

            def sc_track_isolation():
                # One payment's lookup answered with an entry for another txid
                # (the page refuses it): the other payments must still advance.
                t1 = send_ok()
                t2 = send_ok()
                node.control(op="fault", set={"bad_mempool_entry": t1})
                node.control(op="mine", n=1)
                ok2 = wait_until(lambda: sent_status(page, t2) == "Confirmed", 60)
                st1 = sent_status(page, t1)
                check("SEC3-03: a malformed answer about one payment does not stop the others ('Confirmed')",
                      ok2 and st1 != "Confirmed", (st1, sent_status(page, t2)))
                check("SEC3-03: ...the payment with the malformed answer is unchanged and still held",
                      st1 in ("Waiting", "In the mempool") and "payment not yet final" in held_note(), (st1, held_note()))
                node.control(op="fault", set={"bad_mempool_entry": None})
                ok1 = wait_until(lambda: sent_status(page, t1) == "Confirmed", 60)
                check("SEC3-03: ...once its answer is readable again it advances too", ok1, sent_status(page, t1))

            def sc_honest_refusal():
                epoch_safe(); refresh_idle()
                h = node.control(op="state")["height"]
                expiry_at = (h // 32) * 32 + 65
                send(page, other, "0.1")
                node.control(op="set", floor=900_000)
                text, _ = prove_and_wait(page)
                node.control(op="set", floor=0)
                txid = page.text_content("#result-txid") or ""
                page.click("#result-new")
                item = sent_item(page, txid)
                check("SEC3-03: an honest refusal is held, and the list says until which block",
                      "says it refused" in text and ("until its anchor expires at block " + format(expiry_at, ",")) in item, (text[:120], item[-300:]))
                node.control(op="fault", set={"no_block_at": expiry_at})
                node.control(op="mine", n=80)
                time_travel(page, 90)
                said = wait_until(lambda: "does not serve that block" in sent_item(page, txid), 240)
                check("SEC3-03: an RPC that never serves the block at the expiry height -> after a few rounds the page says so and how to settle it",
                      said and (sent_status(page, txid) or "").startswith("May still be mined") and "payment not yet final" in held_note(),
                      (sent_status(page, txid), sent_item(page, txid)[-250:]))
                node.control(op="fault", set={"no_block_at": None})
                time_travel(page, 2)
                exp = wait_until(lambda: sent_status(page, txid) == "Expired", 240)
                check("SEC3-03: ...once the block is served: 'Expired', and the note is gone",
                      exp and "does not serve" not in sent_item(page, txid), (sent_status(page, txid), sent_item(page, txid)[-200:]))
                recover()  # back to the real clock

            def sc_siblings():
                # Admitted, answered "SlotConflict", mempool hidden: the page
                # proves again on the same inputs (SEC2-01). Once the first
                # proof is final, the others can never be accepted (SEC3-04).
                epoch_safe(); refresh_idle()
                listed = lambda: page.evaluate("""() => [...document.querySelectorAll('#sent-list li')].map(li => li.querySelector('.mono-line').textContent)""")
                mempool_before = set(node.control(op="state")["mempool"])
                listed_before = set(listed())
                node.control(op="fault", set={"lie_refuse": "consensus: SlotConflict", "hide_mempool": True, "ref_hide": True})
                send(page, other, "0.1")
                text, _ = prove_and_wait(page)
                new = [t for t in node.control(op="state")["mempool"] if t not in mempool_before]
                proofs = [t for t in listed() if t not in listed_before]
                check("SEC3-04: (setup) the RPC's lie leads to several proofs of one payment, one admitted",
                      "says it refused" in text and len(new) == 1 and len(proofs) >= 2, (text[:100], new, len(proofs)))
                node.control(op="fault", set={"hide_mempool": None, "ref_hide": None})
                node.control(op="mine", n=9)
                first = new[0] if new else "?"
                ok = wait_until(lambda: sent_status(page, first) == "Final", 150)
                siblings = [p for p in proofs if p != first]
                stats = [sent_status(page, p) for p in siblings]
                check("SEC3-04: once one proof is final, its sibling proofs say 'Replaced', not 'Refused by the RPC: checking…'",
                      ok and siblings and all(s == "Replaced" for s in stats), (sent_status(page, first), stats))
                page.click("#result-new")

            def sc_final_lie():
                txid = send_ok()
                node.control(op="mine", n=1)
                wait_until(lambda: sent_status(page, txid) == "Confirmed", 60)
                node.control(op="fault", set={"lie_tip": 200})
                time.sleep(40)
                st = sent_status(page, txid)
                node.control(op="fault", set={"lie_tip": None})
                check("SEC3-02: a tip inflated by 200 blocks for 40 s does not make a 1-block-deep payment 'Final'", st == "Confirmed", st)
                back = wait_until(lambda: sent_status(page, txid) == "Confirmed", 60)
                node.control(op="mine", n=8)
                fin = wait_until(lambda: sent_status(page, txid) == "Final", 200)
                check("SEC3-02: ...once the lie stops: 'Confirmed'; 8 real blocks later, two reads a minute apart: 'Final'",
                      back and fin, sent_status(page, txid))
                node.control(op="unconfirm", txid=txid)
                gone = wait_until(lambda: sent_status(page, txid) not in ("Final", None), 300)
                check("SEC3-02: 'Final' is still looked up: a payment gone from the chain is waiting again, and flagged",
                      gone and sent_status(page, txid) == "Waiting" and "reported this payment final" in sent_item(page, txid),
                      (sent_status(page, txid), sent_item(page, txid)[-220:]))

            def recipient_outputs():
                return sorted(k for k, v in node.control(op="state")["slots"].items() if v["owner"] == other)

            def sc_hidden_tx():
                # Audit-3 PoC Q1: the configured RPC mines the payment and hides
                # it (getMempoolEntry/getTx null), tip and block ids honest.
                node.control(op="mine", n=1)  # nothing else of ours left in the mempool
                outs0 = recipient_outputs()
                node.control(op="ref_requests", clear=True)
                txid = send_ok()
                node.control(op="fault", set={"hide_tx": True, "hide_mempool": True})
                node.control(op="mine", n=1)
                mined = txid in node.control(op="state")["confirmed"]
                node.control(op="mine", n=70)
                time_travel(page, 70)
                mid = wait_until(lambda: (sent_status(page, txid) or "").startswith("May still be mined"), 90)
                time_travel(page, 2)
                time.sleep(50)  # rounds past every consistency condition of SEC2-02
                st, item = sent_status(page, txid), sent_item(page, txid)
                check("SEC3-01: a payment the RPC mined and hides (honest tip and block ids) is never 'Expired': the public RPC sees it",
                      mined and mid and st != "Expired" and "public RPC sees this payment" in item, (mined, st, item[-260:]))
                # The user is told "nothing arrived" and pays the same recipient again.
                submissions(node)
                epoch_safe(); refresh_idle()
                send(page, other, "0.1", confirm_repeat=False)
                shown = page.is_visible("#rv-repeat")
                warn = page.text_content("#rv-repeat-text") or ""
                disabled = page.is_disabled("#review-go")
                page.evaluate("() => document.getElementById('review-go').click()")  # page code forcing the click
                time.sleep(2)
                n = submissions(node)
                check("SEC3-01: paying that recipient again: 'A previous payment to this address may still be mined. Check it first.', "
                      "'Prove and send' disabled until confirmed, nothing proven or sent",
                      shown and "may still be mined. Check it first" in warn and disabled and n == 0 and page.is_visible("#send-review"),
                      (shown, warn[:120], disabled, n))
                page.click("#rv-repeat-ok")
                check("SEC3-01: ...an explicit confirmation lets a legitimate payment through", not page.is_disabled("#review-go"))
                page.click("#review-back")
                check("SEC3-01: ...no second payment reached the recipient (one output more than before: the first payment)",
                      len(recipient_outputs()) == len(outs0) + 1, (len(outs0), len(recipient_outputs())))
                reqs = [json.loads(r) for r in node.control(op="ref_requests")["requests"]]
                methods = sorted({r["method"] for r in reqs})
                leaked = [r for r in reqs if any(a in json.dumps(r) for a in (addr0, other))]
                check("SEC3-01: the public RPC was asked about the txid only (blockCount, getMempoolEntry, getTx), never an address",
                      reqs and set(methods) <= {"jetsam_blockCount", "jetsam_getMempoolEntry", "jetsam_getTx"} and not leaked
                      and any(txid in json.dumps(r) for r in reqs), (methods, len(reqs), leaked[:1]))
                node.control(op="fault", set={"hide_tx": None, "hide_mempool": None})
                found = wait_until(lambda: sent_status(page, txid) in ("Confirmed", "Final"), 90)
                check("SEC3-01: ...once the RPC stops hiding it, it is found mined and the doubt note is gone",
                      found and "public RPC sees" not in sent_item(page, txid), sent_item(page, txid)[-200:])
                recover()  # back to the real clock

            def sc_ref_down():
                # A payment really refused (fee floor raised), so never mined;
                # the public RPC unreachable when the expiry comes.
                epoch_safe(); refresh_idle()
                send(page, other, "0.1")
                node.control(op="set", floor=900_000)
                text, _ = prove_and_wait(page)
                node.control(op="set", floor=0)
                txid = page.text_content("#result-txid") or ""
                page.click("#result-new")
                node.control(op="fault", set={"ref_down": True})
                node.control(op="mine", n=70)
                time_travel(page, 90)
                said = wait_until(lambda: "could not confirm it" in sent_item(page, txid), 150)
                check("SEC3-01: public RPC unreachable -> the expiry is not believed: held, and said honestly",
                      said and sent_status(page, txid) != "Expired" and "payment not yet final" in held_note(),
                      (sent_status(page, txid), sent_item(page, txid)[-200:], held_note()))
                node.control(op="fault", set={"ref_down": None})
                time_travel(page, 2)
                exp = wait_until(lambda: sent_status(page, txid) == "Expired", 150)
                check("SEC3-01: ...reachable again and agreeing -> 'Expired', noted as checked with the public RPC",
                      exp and "Neither your RPC nor the public RPC has it" in sent_item(page, txid), sent_item(page, txid)[-200:])
                recover()

            def sc_crosscheck_settings():
                wait_until(lambda: not page.is_disabled("#refresh"), 60)
                page.click("#settings-open")
                on = page.is_checked("#rpc-crosscheck") and page.is_enabled("#rpc-crosscheck")
                note_on = page.text_content("#rpc-crosscheck-note") or ""
                page.click("#rpc-default")
                note_def = page.text_content("#rpc-crosscheck-note") or ""
                on_def = page.is_enabled("#rpc-crosscheck") and page.is_checked("#rpc-crosscheck")
                page.click("#rpc-custom")
                custom_url = page.input_value("#rpc-url")
                page.fill("#rpc-url", "https://rpc.jetsamchain.com/")
                note_pub = page.text_content("#rpc-crosscheck-note") or ""
                off_pub = page.is_disabled("#rpc-crosscheck")
                page.fill("#rpc-url", custom_url)
                page.click("#rpc-crosscheck")
                note_off = page.text_content("#rpc-crosscheck-note") or ""
                page.click("#settings-cancel")
                check("SEC3-01: Settings: the cross-check is on by default with a custom RPC, and says what it sends (the txid only)",
                      on and "only that, never an address" in note_on, note_on[:160])
                check("SEC3-01: ...the default endpoint (the wallet RPC) is cross-checked with the public RPC",
                      on_def and "https://rpc.jetsamchain.com" in note_def and "only that, never an address" in note_def, note_def[:160])
                check("SEC3-01: ...with the public RPC as the endpoint it says there is no second source (no false promise)",
                      off_pub and "no second source" in note_pub, note_pub[:160])
                check("SEC3-01: ...turning it off warns that an expiry is then one RPC's word (pay twice)",
                      "pay twice" in note_off, note_off[:160])

            def sc_track_load():
                # Finished payments still looked up (expired, final, replaced)
                # are visited one tracking round in 8, not every 15 s (SEC3-06).
                rows = page.evaluate("""() => [...document.querySelectorAll('#sent-list li')].map(li => [li.querySelector('.mono-line').textContent, li.querySelector('.sent-status .badge').textContent])""")
                done = [t for t, st in rows if st in ("Expired", "Final", "Replaced")]
                node.control(op="requests", clear=True)
                time.sleep(50)
                reqs = node.control(op="requests", clear=True)["requests"]
                counts = {t: sum(1 for r in reqs if '"jetsam_getMempoolEntry"' in r and t in r) for t in done}
                check("SEC3-06: finished payments still looked up are asked about at most once in 50 s (one round in 8), not every round",
                      done and max(counts.values()) <= 1, (len(done), sorted(counts.values())[-3:]))

            def sc_watch_home():
                # Watch-only has a visible way back to the gate (#home-btn),
                # the same transition as Settings' "Use a wallet with a secret
                # instead": nothing watched is forgotten, a stored wallet stays.
                ctx_h = new_context(browser, viewport=(390, 844), scheme="dark")
                seed_h = "66" * 32
                addr_h = addresses_of(seed_h, "seed", "mainnet", 0, 1)[0]
                watched = lambda pg: pg.evaluate("() => localStorage.getItem('jww.v1.addresses.mainnet')")  # noqa: E731
                listed = lambda pg: pg.evaluate("() => [...document.querySelectorAll('#address-list code')].map(c => c.title)")  # noqa: E731
                try:
                    ha, con_h = open_page(ctx_h, srv.url, node.url)
                    ha.wait_for_selector("#gate-welcome", state="visible")
                    check("HOME: no Home button on the welcome gate", ha.is_hidden("#home-btn"))
                    ha.click("#choose-watch")
                    ha.wait_for_selector("#wallet-view", state="visible")
                    ha.fill("#add-input", other)
                    ha.click("#add-form button[type=submit]")
                    wait_until(lambda: other in listed(ha), 30)
                    wide = ha.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
                    check("HOME: the watch-only view shows the Home button (Lock hidden), no horizontal scroll at 390 px",
                          ha.is_visible("#home-btn") and ha.is_hidden("#lock-btn") and ha.text_content("#home-btn") == "Home" and wide <= 0,
                          (ha.is_visible("#home-btn"), ha.is_hidden("#lock-btn"), ha.text_content("#home-btn"), wide))
                    shot(ha, out, "watch-home-390-dark")
                    ha.click("#theme-toggle")
                    shot(ha, out, "watch-home-390-light")
                    saved = watched(ha)
                    ha.click("#home-btn")
                    ha.wait_for_selector("#gate-welcome", state="visible", timeout=10_000)
                    check("HOME: Home shows the welcome gate (create / open / watch); the watch view and Home are gone",
                          ha.is_hidden("#wallet-view") and ha.is_hidden("#home-btn")
                          and all(ha.is_visible(s) for s in ("#choose-create", "#choose-open", "#choose-watch")))
                    check("HOME: ...the watched list is kept in this browser", saved and other in saved and watched(ha) == saved, (saved, watched(ha)))
                    ha.click("#choose-watch")
                    ha.wait_for_selector("#wallet-view", state="visible")
                    check("HOME: watching again lists the same address", wait_until(lambda: listed(ha) == [other], 30), listed(ha))
                    # A wallet with a secret opened and locked in another tab of
                    # this browser while the first one still watches.
                    hb, _ = open_page(ctx_h, srv.url, node.url)
                    hb.wait_for_selector("#home-btn", state="visible")  # the mode is remembered
                    hb.click("#home-btn")
                    open_hex(hb, seed_h)
                    hb.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                    check("HOME: an unlocked wallet shows Lock and Home", hb.is_visible("#home-btn") and hb.is_visible("#lock-btn"))
                    hb.click("#lock-btn")
                    hb.wait_for_selector("#gate-unlock", state="visible")
                    record = idb_text(hb)
                    hb.close()
                    check("HOME: the first tab still watches", ha.is_visible("#home-btn") and ha.is_visible("#wallet-view"))
                    ha.click("#home-btn")
                    ha.wait_for_selector("#gate-unlock", state="visible", timeout=10_000)
                    check("HOME: with a wallet stored here, Home shows the gate as a fresh visit does (unlock it), its record untouched",
                          ha.is_hidden("#wallet-view") and ha.is_hidden("#gate-welcome") and record and idb_text(ha) == record)
                    unlock(ha)
                    ha.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                    ha.click("#tab-btn-receive")
                    shown_h = "".join(ha.locator("#receive-address span").all_text_contents())
                    check("HOME: ...and that wallet opens again with its password (same address)", shown_h == addr_h, shown_h)
                    check("HOME: the watched list is still kept", watched(ha) == saved, watched(ha))
                    noise = ("ERR_FAILED", "502", "rpc.jetsamchain.com")
                    check("HOME: no page error in the console", not [e for e in con_h.errors() if not any(n in e[1] for n in noise)], con_h.errors()[:5])
                finally:
                    ctx_h.close()

            def clip(pg):
                return pg.evaluate("() => navigator.clipboard.readText()")

            def no_horizontal_scroll(pg):
                return pg.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth") <= 0

            def key_workers(pg):
                return len(pg.workers)

            def create_to_file(pg):
                pg.wait_for_selector("#gate-welcome", state="visible")
                pg.click("#choose-create")
                pg.fill("#create-pw1", PASSWORD)
                pg.fill("#create-pw2", PASSWORD)
                pg.click("#create-pw-go")
                pg.wait_for_selector("#step-file", state="visible")

            def download_backup(pg, path):
                with pg.expect_download() as d:
                    pg.click("#create-download")
                d.value.save_as(path)
                return keytool("reveal", path, PASSWORD).strip()

            def sc_secret_copy():
                # The secret of a new wallet can be copied, on its backup step
                # only, after a warning and the password; the clipboard is
                # emptied after 30 s (best effort) and when the step is left.
                # Then: the addresses panel shows each full address with a copy
                # button; Home from the unlocked wallet locks it.
                ctx_s = new_context(browser, viewport=(390, 844), scheme="dark")
                try:
                    ctx_s.grant_permissions(["clipboard-read", "clipboard-write"], origin=srv.url.rstrip("/"))
                    ps, con_s = open_page(ctx_s, srv.url, node.url)
                    create_to_file(ps)
                    check("COPY: no copy button before the secret is shown (file step)", ps.is_hidden("#secret-copy"))
                    backup_s = os.path.join(out, "copy-wallet.key")
                    secret_s = download_backup(ps, backup_s)
                    ps.click("#create-file-done")
                    ps.wait_for_selector("#create-reveal", state="visible")
                    check("COPY: ...nor on the secret step before 'Show my secret'", ps.is_hidden("#secret-copy"))
                    ps.evaluate("() => navigator.clipboard.writeText('sentinel')")
                    ps.click("#create-reveal")
                    ps.wait_for_selector("#secret-canvas", state="visible")
                    ps.wait_for_selector("#secret-copy", state="visible")
                    ps.click("#secret-copy")
                    warn = ps.text_content("#secret-copy-confirm") or ""
                    check("COPY: the button opens a warning first (other apps and malware can read the clipboard; password manager only), nothing copied yet",
                          ps.is_visible("#secret-copy-confirm") and "can read the clipboard" in warn and "password manager" in warn and clip(ps) == "sentinel",
                          (warn[:160], clip(ps)))
                    shot(ps, out, "secret-copy-warning-390-dark")
                    ps.click("#secret-copy-cancel")
                    check("COPY: Cancel closes the warning, nothing copied", ps.is_hidden("#secret-copy-confirm") and clip(ps) == "sentinel")
                    ps.click("#secret-copy")
                    ps.fill("#secret-copy-pw", "not the password")
                    ps.click("#secret-copy-go")
                    wait_text(ps, "#secret-copy-msg", r"does not open")
                    check("COPY: a wrong password copies nothing", clip(ps) == "sentinel", clip(ps))
                    ps.fill("#secret-copy-pw", PASSWORD)
                    ps.click("#secret-copy-go")
                    wait_text(ps, "#secret-copy-msg", r"Copied")
                    got = clip(ps)
                    check("COPY: with the password the clipboard holds exactly the 64-hex secret of the downloaded backup",
                          re.fullmatch(r"[0-9a-f]{64}", got or "") is not None and got == secret_s, (got or "")[:6])
                    leaks = page_holds(ps, secret_s)
                    leaks16 = page_holds(ps, secret_s[:16])
                    check("COPY: ...and the secret is still nowhere in the DOM, inputs, localStorage or IndexedDB", leaks == [] and leaks16 == [], (leaks, leaks16))
                    timer = ps.text_content("#secret-copy-timer") or ""
                    check("COPY: a visible countdown says when the clipboard is emptied, and that it is best effort",
                          re.search(r"emptied in \d+ s \(best effort\)", timer) is not None and "30 seconds" in (ps.text_content("#secret-copy-msg") or ""), timer)
                    shot(ps, out, "secret-copy-390-dark")
                    ps.click("#theme-toggle")
                    shot(ps, out, "secret-copy-390-light")
                    ps.click("#theme-toggle")
                    check("COPY: the secret step has no horizontal scroll at 390 px", no_horizontal_scroll(ps))
                    time_travel(ps, 0.5)  # 30 s later on the page's clock
                    emptied = wait_until(lambda: clip(ps) == "", 10)
                    check("COPY: 30 s later the clipboard is emptied, and the page says so",
                          emptied and "was emptied" in (ps.text_content("#secret-copy-msg") or "") and (ps.text_content("#secret-copy-timer") or "") == "",
                          (clip(ps), ps.text_content("#secret-copy-msg")))
                    ps.click("#secret-copy")
                    ps.fill("#secret-copy-pw", PASSWORD)
                    ps.click("#secret-copy-go")
                    wait_text(ps, "#secret-copy-msg", r"Copied")
                    again = clip(ps) == secret_s
                    ps.click("#create-written")
                    ps.wait_for_selector("#step-quiz", state="visible")
                    check("COPY: copied again, then leaving the step ('I have written it down') empties the clipboard at once",
                          again and wait_until(lambda: clip(ps) == "", 5) and ps.is_hidden("#secret-copy"), (again, clip(ps)))
                    labels = ps.locator("#quiz label").all_text_contents()
                    groups = [int(re.search(r"(\d+)", l).group(1)) - 1 for l in labels]
                    inputs = ps.locator("#quiz input")
                    for k, g in enumerate(groups):
                        inputs.nth(k).fill(secret_s[4 * g:4 * g + 4])
                    ps.click("#quiz-go")
                    ps.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                    addr_s = addresses_of(secret_s, "seed", "mainnet", 0, 1)[0]
                    ps.wait_for_selector("#address-list li")
                    row = ps.locator("#address-list li").first
                    line = "".join(row.locator(".addr-line span").all_text_contents())
                    check("ADDR: the address row shows the full address (groups of four), not a shortened one",
                          line == addr_s and addr_s in (row.text_content() or "").replace(" ", "") and "…" not in (row.locator(".addr-line").text_content() or ""), line)
                    row.locator("button", has_text="Copy").click()
                    check("ADDR: its Copy button copies exactly that address", wait_until(lambda: clip(ps) == addr_s, 5), clip(ps))
                    check("ADDR: no horizontal scroll at 390 px with the full address", no_horizontal_scroll(ps))
                    ps.locator("#address-list").scroll_into_view_if_needed()
                    shot(ps, out, "addresses-390-dark")
                    ps.click("#theme-toggle")
                    shot(ps, out, "addresses-390-light")
                    ps.click("#theme-toggle")
                    check("COPY: no copy button for the secret once the wallet is open", ps.is_hidden("#secret-copy"))
                    # (b) Home from the unlocked wallet: locked through the Lock path.
                    cut = ps.evaluate("() => { const c = document.getElementById('chain'); return c.scrollWidth - c.clientWidth; }")
                    check("HOME(b): an unlocked wallet shows Lock and Home; at 390 px the header fits and the chain height is not cut short",
                          ps.is_visible("#lock-btn") and ps.is_visible("#home-btn") and no_horizontal_scroll(ps) and cut <= 0
                          and re.search(r"block [0-9,]+$", ps.text_content("#chain-text") or "") is not None, (cut, ps.text_content("#chain-text")))
                    shot(ps, out, "home-unlocked-390-dark")
                    workers_before = key_workers(ps)
                    ps.click("#home-btn")
                    ps.wait_for_selector("#gate-unlock", state="visible", timeout=10_000)
                    gone = wait_until(lambda: key_workers(ps) == 0, 10)
                    leaks_b = page_holds(ps, secret_s)
                    check("HOME(b): Home locks (the key worker with the secret is gone) and shows the unlock screen of the stored wallet",
                          workers_before >= 1 and gone and ps.is_hidden("#wallet-view") and ps.is_hidden("#lock-btn"),
                          (workers_before, key_workers(ps)))
                    check("HOME(b): ...the secret is in no DOM, input or storage", leaks_b == [], leaks_b)
                    unlock(ps)
                    ps.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                    ps.click("#tab-btn-receive")
                    shown_s = "".join(ps.locator("#receive-address span").all_text_contents())
                    check("HOME(b): ...and the wallet unlocks again with its password (same address)", shown_s == addr_s, shown_s)
                    noise = ("ERR_FAILED", "502", "rpc.jetsamchain.com")
                    check("COPY: no page error in the console", not [e for e in con_s.errors() if not any(n in e[1] for n in noise)], con_s.errors()[:5])
                finally:
                    ctx_s.close()

            def sc_home_gate():
                # (c) Home from every gate screen back to Welcome; an
                # unfinished backup asks first and leaves nothing behind.
                ctx_g = new_context(browser, viewport=(390, 844), scheme="light")
                seed_g = "77" * 32
                try:
                    pg, con_g = open_page(ctx_g, srv.url, node.url)
                    pg.wait_for_selector("#gate-welcome", state="visible")
                    check("HOME(c): no Home on Welcome (the start)", pg.is_hidden("#home-btn"))
                    pg.click("#choose-open")
                    pg.fill("#open-hex", seed_g)
                    pg.fill("#open-pw1", PASSWORD)
                    check("HOME(c): Home on the Open screen", pg.is_visible("#home-btn"))
                    pg.click("#home-btn")
                    pg.wait_for_selector("#gate-welcome", state="visible", timeout=5_000)
                    check("HOME(c): Open -> Home -> Welcome, the typed secret and password emptied",
                          page_holds(pg, seed_g) == [] and pg.input_value("#open-pw1") == "" and pg.is_hidden("#home-btn"))
                    pg.click("#choose-create")
                    pg.fill("#create-pw1", PASSWORD)
                    pg.click("#home-btn")
                    pg.wait_for_selector("#gate-welcome", state="visible", timeout=5_000)
                    check("HOME(c): Create (password step, nothing generated) -> Home -> Welcome, no question asked",
                          not pg.is_visible("#home-confirm") and pg.input_value("#create-pw1") == "" and key_workers(pg) == 0)
                    create_to_file(pg)
                    pg.click("#home-btn")
                    pg.wait_for_selector("#home-confirm", state="visible", timeout=5_000)
                    check("HOME(c): on the backup file step Home asks 'Leave without finishing the backup?'",
                          "Leave without finishing the backup?" in (pg.text_content("#home-confirm") or ""))
                    shot(pg, out, "home-confirm-390-light")
                    pg.click("#home-stay")
                    check("HOME(c): ...Stay keeps the step", pg.is_hidden("#home-confirm") and pg.is_visible("#step-file"))
                    backup_g = os.path.join(out, "home-wallet.key")
                    secret_g = download_backup(pg, backup_g)
                    pg.click("#create-file-done")
                    pg.click("#create-reveal")
                    pg.wait_for_selector("#secret-canvas", state="visible")
                    pg.click("#home-btn")
                    pg.wait_for_selector("#home-confirm", state="visible", timeout=5_000)
                    pg.click("#home-leave")
                    pg.wait_for_selector("#gate-welcome", state="visible", timeout=5_000)
                    gone = wait_until(lambda: key_workers(pg) == 0, 10)
                    check("HOME(c): secret shown, Home -> Leave: Welcome, canvas cleared, the key worker gone, nothing stored, secret nowhere in the page",
                          gone and pg.evaluate("document.getElementById('secret-canvas').width") == 1 and idb_text(pg) == "[]"
                          and page_holds(pg, secret_g) == [], (key_workers(pg), idb_text(pg)[:80]))
                    # The downloaded file still opens that wallet.
                    pg.click("#choose-open")
                    pg.check("#open-mode-file")
                    pg.set_input_files("#open-file", backup_g)
                    pg.fill("#open-file-pass", PASSWORD)
                    pg.fill("#open-pw1", PASSWORD)
                    pg.fill("#open-pw2", PASSWORD)
                    pg.click("#open-go")
                    pg.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                    pg.click("#tab-btn-receive")
                    shown_g = "".join(pg.locator("#receive-address span").all_text_contents())
                    check("HOME(c): ...the backup file downloaded before leaving still opens that wallet",
                          shown_g == addresses_of(secret_g, "seed", "mainnet", 0, 1)[0], shown_g)
                    pg.click("#lock-btn")
                    pg.wait_for_selector("#gate-unlock", state="visible")
                    record = idb_text(pg)
                    check("HOME(c): Home on the unlock screen", pg.is_visible("#home-btn"))
                    pg.click("#home-btn")
                    pg.wait_for_selector("#gate-welcome", state="visible", timeout=5_000)
                    pg.click("#choose-create")
                    pg.wait_for_selector("#gate-unlock", state="visible", timeout=5_000)
                    check("HOME(c): Unlock -> Home -> Welcome; Create there goes back to unlocking the stored wallet and says why, record untouched",
                          "keeps one wallet" in (pg.text_content("#unlock-msg") or "") and idb_text(pg) == record, pg.text_content("#unlock-msg"))
                    unlock(pg)
                    pg.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                    check("HOME(c): ...and it unlocks with its password", True)
                    noise = ("ERR_FAILED", "502", "rpc.jetsamchain.com")
                    check("HOME(c): no page error in the console", not [e for e in con_g.errors() if not any(n in e[1] for n in noise)], con_g.errors()[:5])
                finally:
                    ctx_g.close()

            scenario("double_click", sc_double_click)
            scenario("settings_refresh", sc_settings_refresh)
            scenario("lie_refused", sc_lie_refused)
            scenario("lie_tip", sc_lie_tip)
            scenario("meta_broken", sc_meta_broken)
            scenario("welcome_tab", sc_welcome_tab)
            scenario("lease", sc_lease)
            scenario("track_isolation", sc_track_isolation)
            scenario("honest_refusal", sc_honest_refusal)
            scenario("siblings", sc_siblings)
            scenario("final_lie", sc_final_lie)
            scenario("hidden_tx", sc_hidden_tx)
            scenario("ref_down", sc_ref_down)
            scenario("crosscheck_settings", sc_crosscheck_settings)
            scenario("track_load", sc_track_load)
            scenario("watch_home", sc_watch_home)
            scenario("secret_copy", sc_secret_copy)
            scenario("home_gate", sc_home_gate)

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

            # ---- R: the default RPCs ----------------------------------------
            # The wallet RPC (reads and sending) and the public RPC
            # (cross-check) are both played by one simulated node: the node
            # itself and its /__reference view.
            if want("default_rpc"):
                tnode = FakeNode()
                try:
                    ctx_t = new_context(browser, default_url=tnode.url)
                    # A visitor who chose the testnet with an earlier version:
                    # the choice is ignored, the page is on the mainnet.
                    ctx_t.add_init_script("""try { if (!localStorage.getItem("jww.v1.prefs")) localStorage.setItem("jww.v1.prefs", '{"network":"testnet"}'); } catch (_) {}""")
                    hosts = set()

                    def note_host(r):
                        m = re.match(r"^https?://[^/]+", r.url)
                        if m:
                            hosts.add(m.group(0))
                    ctx_t.on("request", note_host)
                    pt = ctx_t.new_page()
                    con_t = Console(pt)
                    pt.goto(srv.url)
                    pt.wait_for_selector("#chain-text")
                    wait_text(pt, "#chain-text", r"block")
                    tip_t = tnode.control(op="state")["height"]
                    check("R: mainnet only (a stored 'testnet' choice is ignored, no network selector); the default RPC is the wallet RPC; height read through it, genesis recognised (no warning)",
                          pt.text_content("#network") == "Mainnet" and pt.locator("select#network, option[value=testnet]").count() == 0
                          and pt.text_content("#foot-rpc") == "RPC: https://wallet-rpc.jetsamchain.com"
                          and re.sub(r"\D", "", pt.text_content("#chain-text") or "") == str(tip_t)
                          and pt.is_hidden("#banner") and "ok" in (pt.get_attribute("#chain-dot", "class") or ""),
                          (pt.text_content("#foot-rpc"), pt.text_content("#chain-text"), pt.text_content("#banner")))
                    pt.click("#settings-open")
                    label = pt.text_content("#rpc-default-label") or ""
                    note = pt.text_content("#rpc-crosscheck-note") or ""
                    box_on = pt.is_checked("#rpc-default") and pt.is_checked("#rpc-crosscheck") and pt.is_enabled("#rpc-crosscheck")
                    pt.click("#settings-cancel")
                    check("R: Settings: default endpoint is the wallet RPC, cross-checked with the public RPC (txid only)",
                          "https://wallet-rpc.jetsamchain.com" in label and box_on
                          and "https://rpc.jetsamchain.com" in note and "only that, never an address" in note, (label, note[:200]))
                    seed_t = "55" * 32
                    addr_t = addresses_of(seed_t, "seed", "mainnet", 0, 1)[0]
                    to_t = addresses_of(OTHER_SEED, "seed", "mainnet", 0, 1)[0]
                    open_hex(pt, seed_t)
                    pt.wait_for_selector("#wallet-view", state="visible", timeout=60_000)
                    # A received output (not a coinbase): its height comes only
                    # from the headers' allocation counter.
                    tnode.control(op="fund", owner=addr_t, value=4_000_000)
                    pt.click("#refresh")
                    # The refresh started at unlock may already show the output;
                    # the one this click starts then hides the total ("reading…")
                    # while it reads the address again. Read the total once the
                    # click's refresh is over (the button is enabled again).
                    bal_t = wait_until(lambda: pt.is_enabled("#refresh") and re.search(r"\b1 unspent output\b", pt.text_content("#total-sub") or "")
                                       and total_text(pt), 60)
                    check("R: balance read through the wallet RPC", bal_t == "4.000000", total_text(pt))
                    pt.click("#tab-btn-send")
                    pt.wait_for_selector("#send-form", state="visible", timeout=60_000)
                    check("R: sending is enabled on the wallet RPC (no 'Sending is not enabled on this RPC yet')",
                          pt.is_hidden("#send-off") and pt.is_visible("#send-form"))
                    check("R: recipient placeholder is j1…", pt.get_attribute("#send-to", "placeholder") == "j1…",
                          pt.get_attribute("#send-to", "placeholder"))
                    note_t = wait_until(lambda: "4.00 JTM waits for 9 confirmations" in (pt.text_content("#send-from-note") or "") and pt.text_content("#send-from-note"), 30)
                    check("R: a fresh received output is shown waiting, not spendable",
                          bool(note_t) and "Spendable now: 0.00 JTM" in note_t, pt.text_content("#send-from-note"))
                    # One block short of final: the review refuses to spend it,
                    # and says what is spendable now and what waits.
                    tnode.control(op="mine", n=7)
                    send(pt, to_t, "1", expect_review=False)
                    wait_text(pt, "#send-msg", r"Not enough")
                    msg_t = pt.text_content("#send-msg") or ""
                    check("R: a received output not yet final is not spent by the review (enforced, not only shown)",
                          "0.00 JTM is spendable now" in msg_t and "4.00 JTM waits for 9 confirmations" in msg_t and pt.is_hidden("#send-review"), msg_t)
                    tnode.control(op="mine", n=1)
                    if tnode.control(op="state")["height"] % 32 >= 27:
                        tnode.control(op="mine", n=6)
                    tnode.control(op="ref_requests", clear=True)
                    send(pt, to_t, "1")
                    text_t, _ = prove_and_wait(pt)
                    st_t = tnode.control(op="state")
                    txid_t = st_t["mempool"][0] if len(st_t["mempool"]) == 1 else "?"
                    check("R: payment sent through the wallet RPC, admitted by the simulated node",
                          text_t.startswith("Sent") and txid_t in (pt.text_content("#result-txid") or ""), (text_t[:120], st_t["mempool"]))
                    shot(pt, out, "default-rpc-sent-1440-light")
                    tnode.control(op="mine", n=9)
                    wait_text(pt, "#sent-list", r"Final", timeout=180_000)
                    refs = [json.loads(r) for r in tnode.control(op="ref_requests")["requests"]]
                    check("R: before 'Final' the txid was looked up on the public RPC, never an address",
                          any(txid_t in json.dumps(r) for r in refs) and not any(a in json.dumps(r) for r in refs for a in (addr_t, to_t)),
                          (sorted({r["method"] for r in refs}), len(refs)))
                    check("R: the page talked only to itself, the wallet RPC and the public RPC",
                          hosts <= {srv.url.rstrip("/"), "https://wallet-rpc.jetsamchain.com", "https://rpc.jetsamchain.com"}, sorted(hosts))
                    check("R: no page error in the console", not con_t.errors(), con_t.errors()[:5])
                finally:
                    tnode.stop()

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
