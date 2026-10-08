// Jetsam web wallet: wiring between the page and the pure modules.
//
// Two modes. "keys": a wallet whose secret lives in the key worker
// (wallet.js, send.js); this file never sees it. "watch": the v1 watch-only
// list of pasted addresses, no secret at all.

import { NETWORKS } from "./networks.js";
import { createRpc, checkRpcUrl, RpcError, describeRpcError } from "./rpc.js";
import { decodeAddress } from "./bech32m.js";
import { formatJtm, formatInt } from "./amount.js";
import { normalizeSlots, confirmations, isProvisional, summarize } from "./utxo.js";
import { resolveMintHeights } from "./mintheight.js";
import { startProgress } from "./progress.js";
import { encodeQr, qrPath } from "./qr.js";
import { createStore } from "./storage.js";
import { formatUtcClock } from "./timefmt.js";
import { t, tp, applyI18n } from "./i18n.js";
import { createWalletController } from "./wallet.js";
import { createSendController } from "./send.js";
import { createTabLock } from "./tablock.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const MIN_GAP_MS = 250; // between two requests to the RPC
const TIP_POLL_MS = 120_000; // chain height only, never an address
const MAX_MINT_LOOKUPS = 400; // received outputs whose height we look up per refresh
const PAGE_ROWS = 100; // ledger rows rendered at once
const MAX_ADDRESSES = 50;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let storage;
try {
  storage = window.localStorage;
} catch (_) {
  storage = undefined;
}
const store = createStore(storage);
// One unlocked tab per wallet (SEC-04): Web Locks, else a localStorage lease.
const tabLock = createTabLock({ locks: navigator.locks || null, storage: store.available ? storage : null });

const state = {
  mode: "keys", // "keys" | "watch"
  storageBroken: false,
  lastProofMs: null,
  network: "mainnet",
  rpc: null,
  rpcUrl: "",
  customRpc: false,
  tip: null,
  chainError: null,
  genesis: null, // "ok" | "mismatch" | null
  genesisHash: null,
  addresses: [],
  data: new Map(), // address -> { status, rows, error }
  mintCache: new Map(), // creation_id (string) -> height
  loading: false,
  lastRefresh: null,
  filter: null,
  receive: null,
  shownRows: PAGE_ROWS,
  cspBlocked: false,
  progress: null, // block lookup in progress (progress.js), or null
  epoch: 0, // bumped on network/RPC change, so late answers are dropped
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const shortAddr = (a) => a.slice(0, 9) + "…" + a.slice(-6);

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
function loadNetwork(net) {
  state.network = NETWORKS[net] ? net : "mainnet";
  const custom = store.get("rpc." + state.network, null);
  const checked = custom ? checkRpcUrl(custom) : null;
  state.customRpc = Boolean(checked && checked.ok);
  state.rpcUrl = state.customRpc ? checked.url : NETWORKS[state.network].rpc;
  state.rpc = createRpc({ url: state.rpcUrl, minGapMs: MIN_GAP_MS });
  const saved = state.mode === "watch" ? store.get("addresses." + state.network, []) : [];
  state.addresses = Array.isArray(saved)
    ? saved.filter((a) => {
        const d = decodeAddress(a);
        return d.ok && d.network === state.network;
      }).slice(0, MAX_ADDRESSES)
    : [];
  state.data = new Map(state.addresses.map((a) => [a, { status: "idle", rows: [], error: null }]));
  state.mintCache = new Map();
  state.tip = null;
  state.chainError = null;
  state.genesis = null;
  state.genesisHash = null;
  state.filter = null;
  state.receive = state.addresses[0] || null;
  state.shownRows = PAGE_ROWS;
  state.cspBlocked = false;
  state.progress = null;
  state.epoch++;
}

function saveAddresses() {
  if (state.mode === "watch") store.set("addresses." + state.network, state.addresses);
}

function mintCacheKey() {
  return "mint." + (state.genesisHash || "none").slice(0, 16);
}

// Kept in localStorage in watch mode only: the creation ids of received
// outputs identify the wallet's outputs on the chain, and a keyed wallet
// stores nothing that names them (SEC-06).
function loadMintCache() {
  if (state.mode !== "watch") return;
  const saved = store.get(mintCacheKey(), {});
  state.mintCache = new Map(
    Object.entries(saved && typeof saved === "object" ? saved : {}).filter(
      ([k, v]) => /^[0-9]{1,20}$/.test(k) && Number.isSafeInteger(v) && v >= 0,
    ),
  );
}

function saveMintCache() {
  if (state.mode !== "watch") return;
  // Only final heights are kept: a reorganisation cannot move them any more.
  const out = {};
  for (const [k, h] of state.mintCache) {
    if (state.tip !== null && !isProvisional(h, state.tip)) out[k] = h;
  }
  store.set(mintCacheKey(), out);
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function currentTheme() {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced) return forced;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
  $("theme-toggle").setAttribute("aria-pressed", String(currentTheme() === "light"));
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------
function describeError(e) {
  if (state.cspBlocked) return t("error.csp");
  const rpc = describeRpcError(e, t);
  if (rpc !== null) return rpc;
  return t("error.generic", { message: e && e.message ? e.message : String(e) });
}

async function readChain(epoch) {
  const info = await state.rpc.call("getChainInfo");
  if (epoch !== state.epoch) return false;
  if (!info || typeof info.height !== "bigint") throw new RpcError("parse", "getChainInfo without a height");
  state.tip = Number(info.height);
  if (state.genesis === null) {
    const g = await state.rpc.call("getBlockHash", [0]);
    if (epoch !== state.epoch) return false;
    state.genesisHash = typeof g === "string" ? g.toLowerCase() : null;
    state.genesis = state.genesisHash === NETWORKS[state.network].genesis ? "ok" : "mismatch";
    loadMintCache();
  }
  state.chainError = null;
  return true;
}

async function pollTip() {
  if (state.loading || document.visibilityState !== "visible" || state.tip === null) return;
  const epoch = state.epoch;
  try {
    const h = await state.rpc.call("blockCount");
    if (epoch !== state.epoch || typeof h !== "bigint") return;
    state.tip = Number(h);
    state.chainError = null;
  } catch (e) {
    if (epoch === state.epoch) state.chainError = describeError(e);
  }
  render();
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
async function readAddress(address, epoch) {
  const entry = { status: "loading", rows: (state.data.get(address) || {}).rows || [], error: null };
  state.data.set(address, entry);
  render();
  try {
    const raw = await state.rpc.call("getSlotsByOwner", [address]);
    if (epoch !== state.epoch) return;
    entry.rows = normalizeSlots(raw === null ? [] : raw, address);
    for (const r of entry.rows) {
      if (r.height === null && state.mintCache.has(r.creationId.toString())) {
        r.height = state.mintCache.get(r.creationId.toString());
      }
    }
    entry.status = "ok";
  } catch (e) {
    if (epoch !== state.epoch) return;
    entry.status = "error";
    entry.error = describeError(e);
  }
  render();
}

async function resolveReceived(epoch) {
  const pending = [];
  const located = new Set();
  for (const entry of state.data.values()) {
    if (entry.status !== "ok") continue;
    for (const r of entry.rows) {
      if (r.coinbase) continue;
      if (r.height === null) pending.push(r.creationId);
      else located.add(r.creationId);
    }
  }
  if (!pending.length || state.tip === null) return;
  // Newest first matter most (they are the ones still gaining confirmations).
  pending.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const ids = pending.slice(0, MAX_MINT_LOOKUPS);
  const headers = new Map();
  const allocAt = async (h) => {
    if (epoch !== state.epoch) throw new Error("stale");
    if (!headers.has(h)) {
      const hd = await state.rpc.call("getBlockHeader", [h]);
      if (!hd || typeof hd.alloc_counter !== "bigint") throw new Error("no header at " + h);
      headers.set(h, hd.alloc_counter);
    }
    return headers.get(h);
  };
  const progress = startProgress(located.size, ids);
  state.progress = progress;
  announceProgress("start");
  renderProgress();
  let dirty = 0;
  try {
    await resolveMintHeights(ids, state.tip, allocAt, {
      onResolved: (id, h) => {
        if (epoch !== state.epoch) return;
        progress.resolve(id);
        renderProgress();
        if (h === null) return;
        state.mintCache.set(id.toString(), h);
        for (const entry of state.data.values()) {
          for (const r of entry.rows) if (r.creationId === id) r.height = h;
        }
        if (++dirty % 8 === 0) render();
      },
    });
  } finally {
    if (epoch === state.epoch && state.progress === progress) {
      state.progress = null;
      announceProgress("end");
      renderProgress();
    }
  }
  if (epoch === state.epoch) saveMintCache();
}

async function refreshAll() {
  if (state.loading) return;
  state.loading = true;
  const epoch = state.epoch;
  render();
  try {
    if (!(await readChain(epoch))) return;
    render();
    // Indexed loop over the live list: an address added meanwhile is read too.
    for (let k = 0; k < state.addresses.length; k++) {
      if (epoch !== state.epoch) return;
      await readAddress(state.addresses[k], epoch);
    }
    if (epoch !== state.epoch) return;
    await resolveReceived(epoch);
    await readIdle(epoch);
    if (epoch === state.epoch) state.lastRefresh = Date.now();
  } catch (e) {
    if (epoch === state.epoch) state.chainError = describeError(e);
  } finally {
    if (epoch === state.epoch) state.loading = false;
    render();
  }
}

// Addresses added while nothing else was running (or after a refresh had
// already passed them) are read here.
async function readIdle(epoch) {
  let found = true;
  while (found && epoch === state.epoch) {
    found = false;
    for (const a of state.addresses) {
      const e = state.data.get(a);
      if (e && e.status === "idle") {
        found = true;
        await readAddress(a, epoch);
      }
    }
    if (found) await resolveReceived(epoch);
  }
}

async function addAddress(input) {
  const msg = $("add-msg");
  msg.className = "field-msg";
  const d = decodeAddress(input);
  if (!d.ok) {
    msg.textContent = t("addr.err." + d.error);
    msg.classList.add("bad");
    return false;
  }
  if (d.network !== state.network) {
    msg.textContent = t("addr.err.other_network", { network: t("net." + d.network) });
    msg.classList.add("bad");
    return false;
  }
  if (state.addresses.includes(d.address)) {
    msg.textContent = t("addr.err.duplicate");
    msg.classList.add("bad");
    return false;
  }
  if (state.addresses.length >= MAX_ADDRESSES) {
    msg.textContent = t("addr.err.too_many", { n: MAX_ADDRESSES });
    msg.classList.add("bad");
    return false;
  }
  // Second opinion from the node: same checksum rules, same 32 bytes.
  const epoch = state.epoch;
  msg.textContent = t("addr.checking");
  try {
    const v = await state.rpc.call("validateAddress", [d.address]);
    if (epoch !== state.epoch) return false;
    const hex = Array.from(d.bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (!v || v.valid !== true || String(v.hex).toLowerCase() !== hex) {
      msg.textContent = t("addr.err.node_rejects");
      msg.classList.add("bad");
      return false;
    }
  } catch (e) {
    // The local checksum already passed; the node being unreachable is not a
    // reason to refuse an address, only to say so.
    if (epoch !== state.epoch) return false;
    msg.textContent = t("addr.added_unchecked", { reason: describeError(e) });
    msg.classList.add("warn");
  }
  state.addresses.push(d.address);
  state.data.set(d.address, { status: "idle", rows: [], error: null });
  if (!state.receive) state.receive = d.address;
  saveAddresses();
  if (!msg.classList.contains("warn")) {
    msg.textContent = t("addr.added");
    msg.classList.add("good");
  }
  render();
  if (state.tip === null) {
    refreshAll();
  } else if (!state.loading) {
    // A refresh in progress picks the new address up by itself. Otherwise the
    // read runs in the background: the caller gets control back as soon as
    // the address is in the list, not after its blocks are located.
    state.loading = true;
    readIdle(epoch)
      .catch(() => {})
      .finally(() => {
        if (epoch === state.epoch) state.loading = false;
        render();
      });
  }
  return true;
}

function removeAddress(address) {
  state.addresses = state.addresses.filter((a) => a !== address);
  state.data.delete(address);
  if (state.filter === address) state.filter = null;
  if (state.receive === address) state.receive = state.addresses[0] || null;
  saveAddresses();
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function setBalance(micro) {
  const s = formatJtm(micro);
  const dot = s.indexOf(".");
  $("total-int").textContent = s.slice(0, dot);
  $("total-frac").textContent = s.slice(dot);
}

function renderChain() {
  const dot = $("chain-dot");
  const text = $("chain-text");
  const net = t("net." + state.network);
  dot.className = "dot";
  // The network name is already in the selector next to it.
  if (state.chainError) {
    dot.classList.add("err");
    text.textContent = t("chain.unreachable");
  } else if (state.tip === null) {
    text.textContent = t("chain.connecting");
  } else {
    dot.classList.add(state.genesis === "mismatch" ? "warn" : "ok");
    text.textContent = t("chain.height", { height: formatInt(state.tip) });
  }
  $("network").value = state.network;

  const banner = $("banner");
  let msg = "";
  if (state.cspBlocked) msg = t("error.csp");
  else if (state.chainError) msg = state.chainError;
  else if (state.genesis === "mismatch") {
    msg = t("chain.genesis_mismatch", {
      network: net,
      hash: (state.genesisHash || "?").slice(0, 12),
    });
  }
  banner.hidden = !msg;
  banner.textContent = msg;
  $("foot-rpc").textContent = t("foot.rpc", { url: state.rpcUrl });
}

function renderHero() {
  const okRows = [];
  let failed = 0;
  let loading = 0;
  for (const a of state.addresses) {
    const e = state.data.get(a);
    if (!e) continue;
    if (e.status === "ok") okRows.push(...e.rows);
    else if (e.status === "error") failed++;
    else loading++;
  }
  const tip = state.tip === null ? 0 : state.tip;
  const s = summarize(okRows, tip);
  setBalance(s.total);
  $("total-label").textContent = state.mode === "keys" ? t("balance.kicker_keys") : t("balance.kicker");
  const parts = [];
  if (!state.addresses.length) parts.push(state.mode === "keys" ? "" : t("balance.none"));
  else {
    parts.push(
      tp("balance.outputs", s.count, { n: formatInt(s.count) }) + " " +
      tp("balance.addresses", state.addresses.length, { n: formatInt(state.addresses.length) }),
    );
    if (s.provisional > 0n) parts.push(t("balance.provisional", { amount: formatJtm(s.provisional, { trim: true }) }));
    if (failed) parts.push(tp("balance.failed", failed));
    if (state.loading && loading) parts.push(t("balance.loading"));
  }
  $("total-sub").textContent = parts.join(" · ");
  $("refresh").disabled = state.loading;
  $("refresh").textContent = state.loading ? t("action.refreshing") : t("action.refresh");
  $("last-refresh").textContent = state.lastRefresh ? t("balance.updated", { time: formatUtcClock(state.lastRefresh) }) : "";
}

function renderAddresses() {
  const keys = state.mode === "keys";
  $("addr-title").textContent = keys ? t("addr.title_keys") : t("addr.title");
  $("add-form").hidden = keys;
  $("keys-tools").hidden = !keys;
  if (keys) {
    $("addr-new").disabled = wallet.kind === "spend";
    $("addr-scan").disabled = wallet.kind === "spend";
  }
  const active = keys ? wallet.activeAddress() : null;
  const list = $("address-list");
  list.replaceChildren();
  $("addr-empty").hidden = keys || state.addresses.length > 0;
  for (const a of state.addresses) {
    const e = state.data.get(a) || { status: "idle", rows: [] };
    const li = el("li", "addr-item" + (state.filter === a ? " active" : ""));
    const head = el("div", "addr-head");
    const code = el("code", "addr-short", shortAddr(a));
    code.title = a;
    const label = el("span", "sr-only", a);
    if (keys) head.append(el("span", "addr-index", "#" + wallet.indexOf(a)));
    head.append(code, label);
    if (keys && a === active) head.append(el("span", "badge final", t("keys.active")));

    const bal = el("p", "addr-bal");
    if (e.status === "ok") {
      bal.textContent = formatJtm(summarize(e.rows, state.tip || 0).total, { trim: true }) + " JTM";
      const n = el("span", "addr-count", tp("utxo.count", e.rows.length, { n: formatInt(e.rows.length) }));
      bal.append(" ", n);
    } else if (e.status === "error") {
      bal.textContent = e.error;
      bal.classList.add("bad");
    } else {
      bal.textContent = t("addr.reading");
      bal.classList.add("muted");
    }

    const actions = el("div", "addr-actions");
    const show = el("button", "link-btn", t("addr.show"));
    show.type = "button";
    show.addEventListener("click", () => {
      state.filter = state.filter === a ? null : a;
      state.shownRows = PAGE_ROWS;
      selectTab("outputs");
      render();
    });
    show.setAttribute("aria-pressed", String(state.filter === a));
    const recv = el("button", "link-btn", t("addr.receive"));
    recv.type = "button";
    recv.addEventListener("click", () => {
      state.receive = a;
      if (keys) wallet.setActive(a);
      selectTab("receive");
      render();
    });
    if (keys) {
      actions.append(show, recv);
      if (wallet.canHide()) {
        const hide = el("button", "link-btn", t("keys.hide"));
        hide.type = "button";
        hide.setAttribute("aria-label", t("keys.hide_label", { address: shortAddr(a) }));
        hide.addEventListener("click", () => {
          if (hide.dataset.armed === "1") return wallet.hide(a);
          hide.dataset.armed = "1";
          hide.textContent = t("keys.hide_confirm");
        });
        actions.append(hide);
      }
      li.append(head, bal, actions);
      list.append(li);
      continue;
    }
    const rm = el("button", "link-btn danger", t("addr.remove"));
    rm.type = "button";
    rm.setAttribute("aria-label", t("addr.remove_label", { address: shortAddr(a) }));
    rm.addEventListener("click", () => {
      if (rm.dataset.armed === "1") return removeAddress(a);
      rm.dataset.armed = "1";
      rm.textContent = t("addr.remove_confirm");
      setTimeout(() => {
        if (rm.isConnected) {
          rm.dataset.armed = "";
          rm.textContent = t("addr.remove");
        }
      }, 4000);
    });
    actions.append(show, recv, rm);
    li.append(head, bal, actions);
    list.append(li);
  }
  $("storage-note").textContent = keys ? t("keys.note") : store.available ? t("addr.stored") : t("addr.not_stored");
}

function ledgerRows() {
  const rows = [];
  for (const a of state.addresses) {
    if (state.filter && state.filter !== a) continue;
    const e = state.data.get(a);
    if (!e || e.status !== "ok") continue;
    for (const r of e.rows) rows.push({ ...r, address: a });
  }
  // Newest first; unknown heights last; slot as a stable tie-break.
  rows.sort((x, y) => {
    const hx = x.height === null ? -1 : x.height;
    const hy = y.height === null ? -1 : y.height;
    return hy - hx || x.slot - y.slot;
  });
  return rows;
}

function renderLedger() {
  const body = $("ledger-body");
  const rows = ledgerRows();
  const multi = state.addresses.length > 1 && !state.filter;
  $("ledger").classList.toggle("single", !multi);
  body.replaceChildren();
  const tip = state.tip;
  for (const r of rows.slice(0, state.shownRows)) {
    const tr = el("tr");
    const prov = tip !== null && isProvisional(r.height, tip);
    if (prov) tr.classList.add("provisional");

    const amount = el("td", "num amount");
    amount.dataset.label = t("col.amount");
    amount.textContent = formatJtm(r.value);

    const height = el("td", "num");
    height.dataset.label = t("col.height");
    height.textContent = r.height === null ? (state.loading ? t("utxo.resolving") : "—") : formatInt(r.height);

    const confs = el("td", "num");
    confs.dataset.label = t("col.confirmations");
    const c = tip === null ? null : confirmations(tip, r.height);
    confs.textContent = c === null ? "—" : formatInt(c);

    const kind = el("td", "kind");
    kind.dataset.label = t("col.kind");
    kind.append(el("span", "badge " + (r.coinbase ? "mined" : "received"), r.coinbase ? t("utxo.mined") : t("utxo.received")));
    if (prov) kind.append(" ", el("span", "badge prov", t("utxo.provisional")));
    if (!prov && r.height !== null && tip !== null) kind.append(" ", el("span", "badge final", t("utxo.final")));

    const slot = el("td", "num slot");
    slot.dataset.label = t("col.slot");
    slot.textContent = formatInt(r.slot);

    const addr = el("td", "col-addr");
    addr.dataset.label = t("col.address");
    const code = el("code", "", shortAddr(r.address));
    code.title = r.address;
    addr.append(code);

    tr.append(amount, height, confs, kind, slot, addr);
    body.append(tr);
  }

  const empty = $("ledger-empty");
  const anyOk = state.addresses.some((a) => (state.data.get(a) || {}).status === "ok");
  if (!state.addresses.length) {
    empty.hidden = false;
    empty.textContent = t("outputs.no_address");
  } else if (!rows.length && anyOk) {
    empty.hidden = false;
    empty.textContent = t("outputs.none");
  } else if (!rows.length) {
    empty.hidden = false;
    empty.textContent = state.loading ? t("outputs.loading") : t("outputs.unavailable");
  } else {
    empty.hidden = true;
  }
  $("ledger").hidden = rows.length === 0;

  const more = $("ledger-more");
  const left = rows.length - state.shownRows;
  more.hidden = left <= 0;
  if (left > 0) more.textContent = t("outputs.more", { n: formatInt(Math.min(left, PAGE_ROWS)), left: formatInt(left) });

  const filter = $("filter");
  filter.hidden = !state.filter;
  if (state.filter) $("filter-text").textContent = t("outputs.filtered", { address: shortAddr(state.filter) });
}

// The counter updates on every located block; the live region only speaks at
// the start and at the end, so a screen reader is not read 34 numbers.
function renderProgress() {
  const p = state.progress;
  const box = $("locate");
  box.hidden = !p;
  if (!p) return;
  $("locate-text").textContent = t("locate.counter", { done: formatInt(p.done), total: formatInt(p.total) });
  const bar = $("locate-bar");
  bar.max = Math.max(1, p.total);
  bar.value = p.done;
}

function announceProgress(phase) {
  const p = state.progress;
  $("locate-live").textContent =
    phase === "start" && p ? tp("locate.start", p.lookups, { n: formatInt(p.lookups) }) : t("locate.end");
}

let lastQr = null;
function renderReceive() {
  const has = state.addresses.length > 0;
  $("receive").hidden = !has;
  $("receive-empty").hidden = has;
  if (!has) return;
  if (!state.addresses.includes(state.receive)) {
    state.receive = (state.mode === "keys" && wallet.activeAddress()) || state.addresses[0];
  }
  const sel = $("receive-select");
  sel.replaceChildren(
    ...state.addresses.map((a) => {
      const o = el("option", "", shortAddr(a));
      o.value = a;
      o.selected = a === state.receive;
      return o;
    }),
  );
  const a = state.receive;
  if (lastQr !== a) {
    const q = encodeQr(a, { level: "M" });
    const svg = $("qr");
    const quiet = 4;
    const dim = q.size + quiet * 2;
    svg.setAttribute("viewBox", "0 0 " + dim + " " + dim);
    svg.setAttribute("shape-rendering", "crispEdges");
    $("qr-path").setAttribute("d", qrPath(q.modules, quiet));
    $("qr-title").textContent = t("receive.qr_title", { address: a });
    lastQr = a;
  }
  // Groups of four characters: easier to compare by eye, copied without spaces.
  const full = $("receive-address");
  full.replaceChildren();
  for (let k = 0; k < a.length; k += 4) full.append(el("span", "", a.slice(k, k + 4)));
  $("receive-note").textContent = t("receive.note", { network: t("net." + state.network) });
  $("receive-empty").textContent = state.mode === "keys" ? "" : t("receive.empty");
}

function render() {
  wallet.renderGate();
  renderProgress();
  renderChain();
  renderHero();
  renderAddresses();
  renderLedger();
  renderReceive();
  send.render();
  $("foot-mode").textContent = state.mode === "keys" ? t("foot.keys") : t("foot.readonly");
  const warn = $("rpc-warning");
  warn.hidden = !state.customRpc;
  warn.textContent = state.customRpc ? t("rpc.custom_warning", { url: state.rpcUrl }) : "";
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const TABS = ["outputs", "receive", "send"];
function selectTab(name, focus = false) {
  for (const n of TABS) {
    const btn = $("tab-btn-" + n);
    const on = n === name;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    $("tab-" + n).hidden = !on;
    if (on && focus) btn.focus();
  }
}

function wireTabs() {
  for (const n of TABS) {
    const btn = $("tab-btn-" + n);
    btn.addEventListener("click", () => selectTab(n));
    btn.addEventListener("keydown", (ev) => {
      const i = TABS.indexOf(n);
      let j = null;
      if (ev.key === "ArrowRight") j = (i + 1) % TABS.length;
      else if (ev.key === "ArrowLeft") j = (i + TABS.length - 1) % TABS.length;
      else if (ev.key === "Home") j = 0;
      else if (ev.key === "End") j = TABS.length - 1;
      if (j !== null) {
        ev.preventDefault();
        selectTab(TABS[j], true);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    /* fall through to the old way */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.className = "offscreen";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (_) {
    ok = false;
  }
  ta.remove();
  return ok;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function openSettings() {
  const net = t("net." + state.network);
  $("rpc-legend").textContent = t("settings.rpc_legend", { network: net });
  $("rpc-default-label").textContent = t("settings.rpc_default", { url: NETWORKS[state.network].rpc });
  $("rpc-default").checked = !state.customRpc;
  $("rpc-custom").checked = state.customRpc;
  $("rpc-url").value = state.customRpc ? state.rpcUrl : "";
  $("rpc-url").disabled = !state.customRpc;
  $("rpc-msg").textContent = "";
  $("settings-storage").textContent = store.available
    ? tp("settings.storage_on", state.addresses.length, { network: net })
    : t("settings.storage_off");
  $("forget-all").disabled = !state.addresses.length;
  const keys = state.mode === "keys";
  $("watch-settings").hidden = keys;
  $("wallet-settings").hidden = !keys || !wallet.record;
  for (const id of ["ws-password", "ws-backup", "ws-reveal", "lock-minutes"]) $(id).disabled = !wallet.unlocked;
  wallet.settingsOpened();
  const dlg = $("settings");
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function closeSettings() {
  wallet.settingsClosed();
  const dlg = $("settings");
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

function saveSettings() {
  const msg = $("rpc-msg");
  msg.className = "field-msg";
  if ($("rpc-custom").checked) {
    const c = checkRpcUrl($("rpc-url").value);
    if (!c.ok) {
      msg.textContent = t(c.error);
      msg.classList.add("bad");
      return;
    }
    store.set("rpc." + state.network, c.url);
  } else {
    store.remove("rpc." + state.network);
  }
  closeSettings();
  loadNetwork(state.network);
  syncWalletAddresses();
  // A payment under review was checked against the previous RPC (SEC-11).
  send.rpcChanged();
  render();
  refreshAll();
}

// ---------------------------------------------------------------------------
// Keys mode
// ---------------------------------------------------------------------------
let wallet = null;
let send = null;

/** The address list of keys mode is the unlocked wallet's derived list. */
function syncWalletAddresses() {
  if (state.mode !== "keys") return;
  const list = wallet && wallet.unlocked ? wallet.addresses() : [];
  const data = new Map();
  for (const a of list) data.set(a, state.data.get(a) || { status: "idle", rows: [], error: null });
  state.addresses = list;
  state.data = data;
  if (state.filter && !list.includes(state.filter)) state.filter = null;
  if (!list.includes(state.receive)) state.receive = null;
}

/** Read addresses that were just added, in the background. */
function readNew() {
  const epoch = state.epoch;
  if (state.tip === null) {
    refreshAll();
    return;
  }
  if (state.loading) return; // the refresh in progress reads them too
  state.loading = true;
  readIdle(epoch)
    .catch(() => {})
    .finally(() => {
      if (epoch === state.epoch) state.loading = false;
      render();
    });
}

function setMode(mode) {
  const p = store.get("prefs", {}) || {};
  p.mode = mode === "watch" ? "watch" : "keys";
  store.set("prefs", p);
  state.mode = p.mode;
  if (wallet.unlocked) wallet.lock("switch", { silent: true });
  loadNetwork(state.network);
  lastQr = null;
  render();
  refreshAll();
  if (state.mode === "keys") wallet.enter();
}

const LOCK_REASONS = { idle: "lock.idle", cancel: "result.cancelled" };

const ctx = {
  state,
  store,
  $,
  el,
  t,
  tp,
  render,
  refreshAll: () => refreshAll(),
  selectTab,
  describeError,
  closeSettings,
  setMode,
  rpc: () => state.rpc,
  tabLock,
  onUnlocked() {
    syncWalletAddresses();
    send.onUnlocked(wallet.record);
    selectTab("outputs");
    $("unlock-msg").textContent = "";
    render();
    refreshAll();
    send.probe().catch(() => {});
  },
  onLocked(reason) {
    send.onLocked();
    state.addresses = [];
    state.data = new Map();
    state.filter = null;
    state.receive = null;
    lastQr = null;
    const key = LOCK_REASONS[reason];
    const m = $("unlock-msg");
    m.className = "field-msg warn";
    m.textContent = key ? t(key, { n: wallet.lockMinutes }) : "";
    render();
  },
  onAddressesChanged({ fresh = [], receive = null }) {
    syncWalletAddresses();
    if (receive) state.receive = receive;
    render();
    if (fresh.length) readNew();
  },
  onSent() {
    render();
  },
  notice(text) {
    const m = $("keys-msg");
    m.className = "field-msg good";
    m.textContent = text;
  },
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function start() {
  // Framed by another page (clickjacking on "Prove and send"): refuse to run.
  // The served file also sends frame-ancestors 'none' (DEPLOY-HEADERS.md).
  if (window.top !== window.self) {
    document.body.textContent = "This wallet does not run inside a frame. Open it directly.";
    return;
  }
  applyI18n(document);
  const prefs = store.get("prefs", {}) || {};
  applyTheme(prefs.theme);
  state.mode = prefs.mode === "watch" ? "watch" : "keys";
  wallet = createWalletController(ctx);
  send = createSendController(ctx, wallet);
  loadNetwork(prefs.network);
  wireTabs();
  wallet.wire();
  send.wire();

  document.addEventListener("securitypolicyviolation", (ev) => {
    if (ev.effectiveDirective === "connect-src" || ev.violatedDirective === "connect-src") {
      state.cspBlocked = true;
      render();
    }
  });

  $("network").addEventListener("change", (ev) => {
    const p = store.get("prefs", {}) || {};
    p.network = ev.target.value;
    store.set("prefs", p);
    if (wallet.unlocked) wallet.lock("switch", { silent: true });
    loadNetwork(ev.target.value);
    state.loading = false;
    lastQr = null;
    $("add-msg").textContent = "";
    render();
    refreshAll();
    if (state.mode === "keys") wallet.enter();
  });

  $("theme-toggle").addEventListener("click", () => {
    const next = currentTheme() === "light" ? "dark" : "light";
    applyTheme(next);
    const p = store.get("prefs", {}) || {};
    p.theme = next;
    store.set("prefs", p);
  });

  $("refresh").addEventListener("click", () => refreshAll());

  $("add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = $("add-input");
    const ok = await addAddress(input.value);
    if (ok) {
      input.value = "";
      input.focus();
    }
  });

  $("filter-clear").addEventListener("click", () => {
    state.filter = null;
    state.shownRows = PAGE_ROWS;
    render();
  });

  $("ledger-more").addEventListener("click", () => {
    state.shownRows += PAGE_ROWS;
    renderLedger();
  });

  $("receive-select").addEventListener("change", (ev) => {
    state.receive = ev.target.value;
    if (state.mode === "keys") wallet.setActive(state.receive).then(render);
    renderReceive();
  });
  $("watch-to-wallet").addEventListener("click", () => {
    closeSettings();
    setMode("keys");
  });

  $("copy-btn").addEventListener("click", async () => {
    const ok = await copyText(state.receive || "");
    const m = $("copy-msg");
    m.textContent = ok ? t("receive.copied") : t("receive.copy_failed");
    setTimeout(() => { m.textContent = ""; }, 3000);
  });

  $("settings-open").addEventListener("click", openSettings);
  $("settings-cancel").addEventListener("click", closeSettings);
  $("settings-save").addEventListener("click", saveSettings);
  $("settings-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    saveSettings();
  });
  for (const id of ["rpc-default", "rpc-custom"]) {
    $(id).addEventListener("change", () => {
      $("rpc-url").disabled = !$("rpc-custom").checked;
      if ($("rpc-custom").checked) $("rpc-url").focus();
    });
  }
  $("forget-all").addEventListener("click", () => {
    const btn = $("forget-all");
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = tp("settings.forget_confirm", state.addresses.length);
      return;
    }
    btn.dataset.armed = "";
    btn.textContent = t("settings.forget");
    store.remove("addresses." + state.network);
    loadNetwork(state.network);
    closeSettings();
    render();
    refreshAll();
  });

  render();
  refreshAll();
  if (state.mode === "keys") wallet.enter();
  setInterval(pollTip, TIP_POLL_MS);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
