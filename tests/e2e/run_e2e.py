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
    site = os.path.join(out, "site")
    os.makedirs(site, exist_ok=True)
    build_page(site, [node.url])
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
                check("E: connection cut at submission -> 'may have been accepted', tracked, inputs reserved", "may have been accepted" in text, text)
                node.control(op="fault", set={"method:submitTxIntent": None})
                page.click("#result-new")
                check("E: after an unknown outcome its inputs are held back from new payments", "payment not yet final" in page.text_content("#send-from-note"), page.text_content("#send-from-note"))

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

            check("A: no page error in the console", not [e for e in con.errors() if "ERR_FAILED" not in e[1] and "502" not in e[1]], con.errors()[:5])

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
        srv.stop()
    timings["wall_s"] = round(time.time() - t_start, 1)
    with open(os.path.join(out, "results.json"), "w") as f:
        json.dump({"results": results, "timings": timings}, f, indent=1)
    failed = [r for r in results if not r["ok"]]
    print("\n%d checks, %d failed; proofs (ms): %s" % (len(results), len(failed), timings["prove_ms"]))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
