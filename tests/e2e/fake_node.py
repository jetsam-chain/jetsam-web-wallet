#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""A simulated Jetsam RPC endpoint for browser tests (127.0.0.1 only).

    fake_node.py --port P [--network mainnet|testnet] [--mode open|public]

It answers the JSON-RPC methods the web wallet uses with the shapes the real
node and the public proxy return (u64 above 2^53 written as bare JSON
integers, `creation_height` added to coinbase rows like the proxy does), and
keeps a small chain state: height, block ids, live slots, mempool.

submitTxIntent runs the NODE'S OWN stateless admission (size, canonical bytes,
PagedSpend semantics, owner proof) through jetsam_wallet_core's
`fake_node_tool` (JETSAM_NODE_TOOL), then the stateful checks of
jetsam_mempool::run_admission_checks with the same error texts: fee floor,
epoch anchor (two accepted, v1.3+), mempool slot conflicts, live inputs,
empty outputs.

--mode public behaves like rpc.jetsamchain.com today: submitTxIntent and
getSlotHints(Salted) answer "method not allowed", bodies over 64 KiB get 413.

A test drives it through POST /__control (JSON): fund, mine, faults, state,
requests (every request body received, to check what the wallet revealed).

Hostile faults (audit SEC-02/03/05/07/08): delay_submit (seconds before
submitTxIntent is processed), after_admission (one shot: the intent IS
admitted, then the answer is http502 / garbage / lie_txid / drop), fee_value
(estimateFee answer), dup_rows (every getSlotsByOwner row twice), phish
(estimateFee fails with that text).

Re-review faults (SEC2-01/02/05): lie_refuse (one shot: the intent IS
admitted, then the answer is a JSON-RPC error with that text), lie_tip
(blockCount and getBlockHash claim that many more blocks), hide_mempool
(getMempoolEntry answers null), delay_slots (seconds before getSlotsByOwner).

Audit-3 faults (SEC3-03): bad_mempool_entry (getMempoolEntry for that txid
answers an entry for another one, which the page refuses), no_block_at
(getBlockHash answers null at that height), hide_tx (getTx answers null:
with hide_mempool, a payment it mined is hidden, SEC3-01). Control op `unconfirm` takes a
confirmed transaction off the chain (SEC3-02).

The public RPC (SEC3-01): POST /__reference answers like the public proxy
about the same chain, honestly (no fault applies; read methods only).
harness.route_reference sends the browser's requests for
https://rpc.jetsamchain.com there (and, for a simulated testnet node, those for
https://rpc-testnet.jetsamchain.com, while https://wallet-rpc.jetsamchain.com
goes to the node itself), so the page's cross-check is exercised without any
real network. Its faults: ref_down (HTTP 502), ref_hide (it does
not see any transaction either); op `ref_requests` lists what it was asked.
"""
import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TOOL = os.environ.get(
    "JETSAM_NODE_TOOL",
    "/root/jetsam-wallet-work/target-wc/release/examples/fake_node_tool",
)
COINBASE_TAG = 1 << 63
EPOCH = 32
PUBLIC_ALLOW = {
    "getChainInfo", "getNodeStatus", "getMiningInfo", "getStateInfo", "blockCount", "getBlockHash",
    "getBlockHeader", "getHeaderByHeight", "getBlockHeaderByHash", "getHeaderByHash", "getBlock",
    "getBlockDetails", "getTx", "getRecentTransactions", "getHistoryStepTerminal", "getActiveSlotCount",
    "getSlotsByOwner", "getMempoolStats", "getMempoolInfo", "getMempoolSize", "getMempoolEntry",
    "validateAddress", "getPeerCount", "getEpochAnchor", "estimateFee",
}

# ---- bech32m (BIP-350) ---------------------------------------------------------
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values):
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk


def _hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def bech32m_encode(hrp, data8):
    acc = bits = 0
    data = []
    for b in data8:
        acc = (acc << 8) | b
        bits += 8
        while bits >= 5:
            bits -= 5
            data.append((acc >> bits) & 31)
    if bits:
        data.append((acc << (5 - bits)) & 31)
    mod = _polymod(_hrp_expand(hrp) + data + [0] * 6) ^ 0x2BC830A3
    return hrp + "1" + "".join(CHARSET[d] for d in data) + "".join(CHARSET[(mod >> 5 * (5 - i)) & 31] for i in range(6))


def bech32m_decode(text):
    text = text.lower()
    pos = text.rfind("1")
    hrp, data = text[:pos], [CHARSET.find(c) for c in text[pos + 1:]]
    if pos < 1 or -1 in data or _polymod(_hrp_expand(hrp) + data) != 0x2BC830A3:
        return None, None
    acc = bits = 0
    out = []
    for v in data[:-6]:
        acc = (acc << 5) | v
        bits += 5
        if bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 255)
    return hrp, bytes(out)


def genesis_hashes():
    text = open(os.path.join(ROOT, "js", "networks.js")).read()
    found = dict(re.findall(r'id: "(\w+)",[\s\S]*?genesis: "([0-9a-f]{64})"', text))
    return found


class Chain:
    def __init__(self, network, mode):
        self.lock = threading.RLock()
        self.network = network
        self.hrp = "j" if network == "mainnet" else "tj"
        self.mode = mode
        self.genesis = genesis_hashes()[network]
        self.seed = secrets.token_hex(8)
        self.height = 1000
        self.log_slots = 24
        self.slots = {}  # slot -> dict(value, creation_id, owner)
        self.alloc = 50_000
        self.alloc_at = {}  # height -> counter after the block
        self.mempool = {}  # txid -> dict(facts, admitted_height)
        self.confirmed = {}  # txid -> height
        self.floor = 0
        self.faults = {}
        self.requests = []
        self.ref_requests = []  # what the page asked the public RPC (its /__reference view)
        self.next_slot = 100_000
        for h in range(0, self.height + 1):
            self.alloc_at[h] = self.alloc
        self.tool = subprocess.Popen([TOOL], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.tool_lock = threading.Lock()

    # -- tool ---------------------------------------------------------------
    def ask(self, request):
        with self.tool_lock:
            self.tool.stdin.write(json.dumps(request) + "\n")
            self.tool.stdin.flush()
            return json.loads(self.tool.stdout.readline())

    def block_id(self, h):
        if h == 0:
            return self.genesis
        return hashlib.sha256(f"{self.seed}:{h}".encode()).hexdigest()

    def anchor_height(self, child):
        return 0 if child == 0 else ((child - 1) // EPOCH) * EPOCH

    def required_fee(self, n_in, n_out):
        r = self.ask({"op": "fee", "n_in": n_in, "n_out": n_out, "active_slot_count": str(len(self.slots)), "log_slots": self.log_slots})
        return max(int(r["required_total"]), self.floor)

    # -- control ------------------------------------------------------------
    def fund(self, owner, value, coinbase=False, height=None, slot=None):
        with self.lock:
            slot = slot if slot is not None else self.next_slot
            self.next_slot = max(self.next_slot, slot + 1)
            if coinbase:
                cid = COINBASE_TAG | (height if height is not None else self.height)
            else:
                self.alloc += 1
                cid = self.alloc
                self.alloc_at[self.height] = self.alloc
            self.slots[slot] = {"value": int(value), "creation_id": cid, "owner": owner}
            return {"slot": slot, "creation_id": str(cid)}

    def mine(self, n=1):
        with self.lock:
            for _ in range(n):
                self.height += 1
                for txid, e in list(self.mempool.items()):
                    f = e["facts"]
                    for i in f["inputs"]:
                        self.slots.pop(i["slot_index"], None)
                    for o in f["outputs"]:
                        self.alloc += 1
                        owner = bech32m_encode(self.hrp, bytes.fromhex(o["owner_hex"]))
                        self.slots[o["slot_index"]] = {"value": int(o["amount"]), "creation_id": self.alloc, "owner": owner}
                    self.confirmed[txid] = self.height
                self.mempool.clear()
                self.alloc_at[self.height] = self.alloc
            return {"height": self.height}

    # -- admission ----------------------------------------------------------
    def submit(self, intent_hex):
        if not isinstance(intent_hex, str) or not intent_hex:
            raise RpcFail(-32602, "tx intent: empty hex")
        facts = self.ask({"op": "admit", "hex": intent_hex})
        if not facts.get("ok"):
            raise RpcFail(-32000, "malformed intent: " + str(facts.get("error"))[:300])
        with self.lock:
            hook = self.faults.pop("before_admission", None)
            if hook == "occupy_outputs":
                for o in facts["outputs"]:
                    self.slots.setdefault(o["slot_index"], {"value": 1, "creation_id": 1, "owner": "x"})
            elif hook == "raise_floor":
                self.floor = int(self.faults.pop("floor_value", 50_000))
            txid = facts["txid"]
            if txid in self.mempool:
                raise RpcFail(-32000, "already admitted: TxBodyHash(" + txid + ")")
            required = self.required_fee(len(facts["inputs"]), len(facts["outputs"]))
            if int(facts["fee"]) < required:
                raise RpcFail(-32000, f"consensus: BelowMinFee: required={required} actual={facts['fee']}")
            child = self.height + 1
            cur = self.anchor_height(child)
            accepted = {self.block_id(cur), self.block_id(max(cur - EPOCH, 0))}
            if facts["epoch_anchor"] not in accepted:
                raise RpcFail(-32000, "consensus: BadEpochAnchor")
            pool_in = {i["slot_index"] for e in self.mempool.values() for i in e["facts"]["inputs"]}
            pool_out = {o["slot_index"] for e in self.mempool.values() for o in e["facts"]["outputs"]}
            if any(i["slot_index"] in pool_in for i in facts["inputs"]) or any(o["slot_index"] in pool_out for o in facts["outputs"]):
                raise RpcFail(-32000, "consensus: SlotConflict")
            owner = bech32m_encode(self.hrp, bytes.fromhex(facts["input_owner_hex"]))
            for i in facts["inputs"]:
                live = self.slots.get(i["slot_index"])
                if not live or live["value"] != int(i["amount"]) or live["creation_id"] != int(i["creation_id"]) or live["owner"] != owner:
                    raise RpcFail(-32000, "consensus: BadStateRoot")
            for o in facts["outputs"]:
                if o["slot_index"] in self.slots or o["slot_index"] >= (1 << self.log_slots):
                    raise RpcFail(-32000, "consensus: SlotConflict")
            self.mempool[txid] = {"facts": facts, "admitted_height": self.height}
            self.faults["last_verify_ms"] = facts.get("verify_ms")
            return txid

    # -- RPC ----------------------------------------------------------------
    def call(self, method, params, honest=False):
        # honest: the reference view (what the public RPC would answer about
        # the same chain): no fault applies, read methods only.
        faults = {} if honest else self.faults
        if (self.mode == "public" or honest) and method not in PUBLIC_ALLOW:
            raise RpcFail(-32601, "method not allowed: " + method)
        with self.lock:
            if method == "blockCount":
                return self.height + int(faults.get("lie_tip") or 0)
            if method == "getChainInfo":
                return {
                    "height": self.height, "best_hash": self.block_id(self.height), "difficulty_target": "00" * 32,
                    "active_slot_count": len(self.slots), "log_slots": self.log_slots,
                    "circulating_supply_micro_jtm": str(sum(s["value"] for s in self.slots.values())),
                }
            if method == "getBlockHash":
                h = int(params[0])
                if faults.get("no_block_at") is not None and h == int(faults["no_block_at"]):
                    return None
                return self.block_id(h) if h <= self.height + int(faults.get("lie_tip") or 0) else None
            if method == "getBlockHeader":
                h = int(params[0])
                if h > self.height:
                    return None
                return {"height": h, "alloc_counter": self.alloc_at.get(h, max(v for k, v in self.alloc_at.items() if k <= h))}
            if method == "getSlotsByOwner":
                owner = str(params[0]).lower()
                if faults.get("lie_owner"):
                    owner_out = bech32m_encode(self.hrp, bytes(32))
                else:
                    owner_out = None
                rows = []
                for slot, s in sorted(self.slots.items()):
                    if s["owner"] == owner:
                        row = {"slot_index": slot, "value": s["value"], "creation_id": s["creation_id"], "owner": owner_out or s["owner"], "empty": False}
                        if s["creation_id"] & COINBASE_TAG:
                            row["creation_height"] = s["creation_id"] & ~COINBASE_TAG
                        rows.append(row)
                return rows + rows if faults.get("dup_rows") else rows
            if method == "validateAddress":
                hrp, data = bech32m_decode(str(params[0]))
                if hrp in ("j", "tj") and data and len(data) == 32:
                    return {"valid": True, "bech32": str(params[0]).lower(), "hex": data.hex(), "error": None}
                return {"valid": False, "bech32": None, "hex": None, "error": "invalid"}
            if method == "estimateFee":
                if faults.get("phish"):
                    raise RpcFail(-32000, faults["phish"])
                if faults.get("fee_value") is not None:
                    return int(faults["fee_value"])
                n_out = int(params[0]) if params else 1
                return self.required_fee(1, n_out)
            if method == "getEpochAnchor":
                if faults.pop("anchor_moves_after_read", None):
                    anchor = self.block_id(self.anchor_height(self.height + 1))
                    # the chain crosses into the next epoch right after this read
                    self.height = ((self.height // EPOCH) + 1) * EPOCH + 1
                    for h in range(min(self.alloc_at) if self.alloc_at else 0, self.height + 1):
                        self.alloc_at.setdefault(h, self.alloc)
                    return anchor
                return self.block_id(self.anchor_height(self.height + 1))
            if method in ("getSlotHints", "getSlotHintsSalted"):
                count = int(params[0])
                if faults.get("hints_occupied"):
                    taken = sorted(self.slots)[:count]
                    if len(taken) >= count:
                        return taken
                out = []
                while len(out) < count:
                    s = secrets.randbelow(1 << self.log_slots)
                    if s not in self.slots and s not in out:
                        out.append(s)
                return out
            if method == "getMempoolEntry":
                if faults.get("bad_mempool_entry") == str(params[0]):
                    return {"tx_hash": "ab" * 32, "fee_micro_jtm": 1, "admitted_height": 1, "requires_b255_miner": False}
                e = None if faults.get("hide_mempool") else self.mempool.get(str(params[0]))
                if not e:
                    return None
                f = e["facts"]
                return {
                    "tx_hash": params[0], "fee_micro_jtm": int(f["fee"]), "fee_rate": 1, "n_inputs": len(f["inputs"]),
                    "n_outputs": len(f["outputs"]), "page_count": f["page_count"], "minimum_proof_class": "B16",
                    "requires_b255_miner": False, "admitted_height": e["admitted_height"], "has_authorization": True,
                }
            if method == "getTx":
                if faults.get("hide_tx"):
                    return None
                h = self.confirmed.get(str(params[0]))
                if h is None:
                    return None
                return {"tx_hash": params[0], "height": h, "block_hash": self.block_id(h), "tx_position": 1}
        if method == "submitTxIntent":
            return self.submit(params[0] if params else "")
        raise RpcFail(-32601, "Method not found")


class RpcFail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def make_handler(chain, max_body):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def reply(self, status, body):
            data = body.encode()
            self.send_response(status)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def reference(self, text):
            """The public RPC as the browser tests see it (harness.route_reference):
            the same chain, honest, read methods only. ref_down: HTTP 502;
            ref_hide: it does not see any transaction either."""
            with chain.lock:
                chain.ref_requests.append(text)
                down, hide = chain.faults.get("ref_down"), chain.faults.get("ref_hide")
            if down:
                return self.reply(502, "bad gateway")
            try:
                msg = json.loads(text)
                method = str(msg.get("method", ""))
                method = method[len("jetsam_"):] if method.startswith("jetsam_") else method
                if hide and method in ("getMempoolEntry", "getTx"):
                    result = None
                else:
                    result = chain.call(method, msg.get("params") or [], honest=True)
                return self.reply(200, json.dumps({"jsonrpc": "2.0", "id": msg.get("id"), "result": result}))
            except RpcFail as e:
                return self.reply(200, json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": e.code, "message": e.message}}))

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            if self.path == "/__control":
                cmd = json.loads(self.rfile.read(length))
                return self.reply(200, json.dumps(control(chain, cmd)))
            if self.path == "/__reference":
                return self.reference(self.rfile.read(length).decode("utf-8", "replace"))
            limit = 64 * 1024 if chain.mode == "public" else max_body
            if length > limit:
                self.rfile.read(length)
                return self.reply(413, '{"error":"payload too large"}')
            raw = self.rfile.read(length)
            text = raw.decode("utf-8", "replace")
            with chain.lock:
                chain.requests.append(text)
            try:
                msg = json.loads(text)
                method = str(msg.get("method", ""))
                method = method[len("jetsam_"):] if method.startswith("jetsam_") else method
                fault = chain.faults.get("method:" + method)
                if fault == "drop":
                    self.close_connection = True
                    self.connection.shutdown(2)
                    return
                if fault == "http502":
                    return self.reply(502, "bad gateway")
                if fault == "refuse":
                    raise RpcFail(-32601, "method not allowed: " + method)
                if fault == "garbage":
                    return self.reply(200, json.dumps({"jsonrpc": "2.0", "id": msg.get("id"), "result": {"height": "lots"}}))
                if method == "submitTxIntent" and chain.faults.get("delay_submit"):
                    time.sleep(float(chain.faults["delay_submit"]))
                if method == "getSlotsByOwner" and chain.faults.get("delay_slots"):
                    time.sleep(float(chain.faults["delay_slots"]))
                result = chain.call(method, msg.get("params") or [])
                if method == "submitTxIntent":
                    with chain.lock:
                        after = chain.faults.pop("after_admission", None)
                    if after == "http502":
                        return self.reply(502, "<html>bad gateway</html>")
                    if after == "garbage":
                        return self.reply(200, "<html>upstream timed out</html>")
                    if after == "lie_txid":
                        result = "ab" * 32
                    if after == "drop":
                        self.close_connection = True
                        self.connection.shutdown(2)
                        return
                    with chain.lock:
                        lie = chain.faults.pop("lie_refuse", None)
                    if lie:
                        raise RpcFail(-32000, lie)
                return self.reply(200, json.dumps({"jsonrpc": "2.0", "id": msg.get("id"), "result": result}))
            except RpcFail as e:
                return self.reply(200, json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": e.code, "message": e.message}}))

    return Handler


def control(chain, cmd):
    op = cmd.get("op")
    if op == "fund":
        return chain.fund(cmd["owner"], cmd["value"], cmd.get("coinbase", False), cmd.get("height"), cmd.get("slot"))
    if op == "mine":
        return chain.mine(int(cmd.get("n", 1)))
    if op == "fault":
        with chain.lock:
            for k, v in cmd.get("set", {}).items():
                if v is None:
                    chain.faults.pop(k, None)
                else:
                    chain.faults[k] = v
        return {"ok": True}
    if op == "set":
        with chain.lock:
            if "height" in cmd:
                chain.height = int(cmd["height"])
                for h in range(0, chain.height + 1):
                    chain.alloc_at.setdefault(h, chain.alloc)
            if "floor" in cmd:
                chain.floor = int(cmd["floor"])
            if "mode" in cmd:
                chain.mode = cmd["mode"]
        return {"ok": True}
    if op == "unconfirm":
        # The transaction leaves the chain (as after a reorganisation that
        # does not bring it back): getTx no longer finds it.
        with chain.lock:
            chain.confirmed.pop(cmd["txid"], None)
        return {"ok": True}
    if op == "state":
        with chain.lock:
            return {
                "height": chain.height, "mempool": list(chain.mempool), "confirmed": chain.confirmed,
                "slots": {str(k): {**v, "creation_id": str(v["creation_id"])} for k, v in chain.slots.items()},
                "last_verify_ms": chain.faults.get("last_verify_ms"),
                "mempool_facts": {k: v["facts"] for k, v in chain.mempool.items()},
            }
    if op == "ref_requests":
        with chain.lock:
            out = list(chain.ref_requests)
            if cmd.get("clear"):
                chain.ref_requests.clear()
            return {"requests": out}
    if op == "requests":
        with chain.lock:
            out = list(chain.requests)
            if cmd.get("clear"):
                chain.requests.clear()
            return {"requests": out}
    return {"error": "unknown op"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--network", default="mainnet", choices=["mainnet", "testnet"])
    ap.add_argument("--mode", default="open", choices=["open", "public"])
    ap.add_argument("--port-file")
    args = ap.parse_args()
    chain = Chain(args.network, args.mode)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(chain, 1024 * 1024))
    if args.port_file:
        with open(args.port_file, "w") as f:
            f.write(str(server.server_address[1]))
    print("fake node on 127.0.0.1:%d (%s, %s)" % (server.server_address[1], args.network, args.mode), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
