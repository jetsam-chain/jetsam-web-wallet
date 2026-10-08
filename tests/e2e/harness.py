# SPDX-License-Identifier: Apache-2.0
"""Shared pieces of the browser tests: the simulated node, the page under test,
and small Playwright helpers (sync API, driven directly; no MCP server).

Every process started here is stopped by its PID.
"""
import contextlib
import functools
import http.server
import json
import os
import re
import socket
import socketserver
import subprocess
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
PUBLIC_RPC = re.compile(r"^https://rpc(-testnet)?\.jetsamchain\.com")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeNode:
    def __init__(self, network="mainnet", mode="open"):
        self.port = free_port()
        self.proc = subprocess.Popen(
            ["python3", "-I", os.path.join(HERE, "fake_node.py"), "--port", str(self.port), "--network", network, "--mode", mode],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        line = self.proc.stdout.readline()
        if "fake node on" not in line:
            raise RuntimeError("fake node did not start: " + line)
        self.url = "http://127.0.0.1:%d" % self.port

    def control(self, **cmd):
        req = urllib.request.Request(self.url + "/__control", data=json.dumps(cmd).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def build_page(out_dir, extra_connect):
    """The shipped single file, with the test RPC origins added to connect-src
    (the only change: what a user does to use their own RPC)."""
    built = os.path.join(out_dir, "built.html")
    subprocess.run(["node", os.path.join(ROOT, "tools", "build-single.mjs"), built], check=True, capture_output=True)
    html = open(built, encoding="utf-8").read()
    html2 = html.replace(
        "connect-src https://rpc.jetsamchain.com https://rpc-testnet.jetsamchain.com",
        "connect-src https://rpc.jetsamchain.com https://rpc-testnet.jetsamchain.com " + " ".join(extra_connect),
        1,
    )
    assert html2 != html
    page = os.path.join(out_dir, "index.html")
    with open(page, "w", encoding="utf-8") as f:
        f.write(html2)
    return page


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class StaticServer:
    def __init__(self, directory):
        handler = functools.partial(Quiet, directory=directory)
        self.httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.url = "http://127.0.0.1:%d/" % self.port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def block_public(context):
    """No test may reach the real public RPC."""
    context.route(PUBLIC_RPC, lambda route: route.abort())


class Console:
    def __init__(self, page):
        self.lines = []
        page.on("console", lambda m: self.lines.append((m.type, m.text)))
        page.on("pageerror", lambda e: self.lines.append(("pageerror", str(e))))

    def errors(self):
        return [l for l in self.lines if l[0] in ("error", "pageerror")]


def set_rpc(page, url):
    page.click("#settings-open")
    page.check("#rpc-custom")
    page.fill("#rpc-url", url)
    page.click("#settings-save")


def wait_text(page, selector, pattern, timeout=60_000):
    rx = re.compile(pattern)
    deadline = time.time() + timeout / 1000
    last = ""
    while time.time() < deadline:
        try:
            last = page.text_content(selector) or ""
        except Exception:
            last = ""
        if rx.search(last):
            return last
        time.sleep(0.2)
    raise AssertionError("timeout waiting for %s ~ %r (last: %r)" % (selector, pattern, last[:300]))


def visible(page, selector):
    return page.is_visible(selector)
