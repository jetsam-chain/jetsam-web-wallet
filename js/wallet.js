// The wallet that holds a secret: create, open, unlock, lock, addresses.
//
// The secret itself only ever exists inside the key worker (keyclient.js ->
// worker/keyworker.js). This module handles what the page may know: the
// encrypted record in IndexedDB, the index list, the derived addresses, and
// the backup gate of a new wallet.

import { createKeyClient, KeyWorkerError } from "./keyclient.js";
import { loadWallet, saveWallet, patchWallet, forgetWallet } from "./vault.js";
import { createBackupFlow } from "./backup.js";
import { createIndexList } from "./indexes.js";
import { createAutoLock } from "./autolock.js";
import { drawSecret, clearCanvas } from "./secretcanvas.js";
import { classifySecretText, classifyKeyFile } from "./keyformats.js";
import { normalizeSlots } from "./utxo.js";

const MIN_PASSWORD = 10;
const ACTIVITY = ["pointerdown", "keydown", "wheel", "touchstart"];

export function createWalletController(ctx) {
  const { $, el, t } = ctx;
  const w = {
    view: null, // "welcome" | "unlock" | "create" | "open" | null
    record: null,
    client: null,
    list: null, // index list
    addrs: [], // [{ index, address }]
    flow: null,
    creating: null, // { client, sealed, kind }
    busy: false,
  };
  const autolock = createAutoLock({ minutes: 5, onLock: () => lock("idle") });

  const randomFill = (a) => crypto.getRandomValues(a);
  const colors = () => {
    const cs = getComputedStyle(document.documentElement);
    return { ink: cs.getPropertyValue("--ink").trim() || "#000", faint: cs.getPropertyValue("--faint").trim() || "#666", font: "\"Spline Sans Mono\", ui-monospace, monospace" };
  };
  const msg = (id, text, cls) => {
    const p = $(id);
    p.className = "field-msg" + (cls ? " " + cls : "");
    p.textContent = text || "";
  };
  const takeValue = (id) => {
    const input = $(id);
    const v = input.value;
    input.value = "";
    return v;
  };

  function workerMessage(e) {
    const m = e && e.message ? e.message : String(e);
    if (/wrong passphrase/.test(m)) return t("wallet.err.password");
    if (/passphrase is required/.test(m)) return t("wallet.err.need_password");
    if (/invalid wallet file format|truncated or corrupt|unsupported encrypted/.test(m)) return t("wallet.err.file");
    if (/64 hexadecimal|non-hexadecimal/.test(m)) return t("open.err.length");
    if (e instanceof KeyWorkerError && e.cancelled) return t("wallet.err.locked");
    return t("wallet.err.generic", { message: m.slice(0, 200) });
  }

  // ---------------------------------------------------------------- views
  function show(view) {
    w.view = view;
    ctx.render();
  }

  function renderGate() {
    const gated = ctx.state.mode === "keys" && !w.client;
    $("gate").hidden = !gated;
    $("wallet-view").hidden = gated;
    $("lock-btn").hidden = !(ctx.state.mode === "keys" && w.client);
    for (const v of ["welcome", "unlock", "create", "open"]) $("gate-" + v).hidden = !gated || w.view !== v;
    const net = t("net." + ctx.state.network);
    const titles = { welcome: "gate.title_welcome", unlock: "gate.title_unlock", create: "gate.title_create", open: "gate.title_open" };
    $("gate-title").textContent = gated && w.view ? t(titles[w.view], { network: net }) : "";
    if (w.view === "unlock" && w.record) {
      $("unlock-lede").textContent = t(w.record.kind === "spend" ? "unlock.lede_spend" : "unlock.lede", { network: net });
    }
    if (w.view === "create" && w.flow) renderCreate();
    $("brand-tag").textContent = ctx.state.mode === "keys" ? t("brand.tag") : t("brand.tag_watch");
  }

  function renderCreate() {
    const s = w.flow.state;
    const panel = { password: "step-password", file: "step-file", reveal: "step-reveal", written: "step-reveal", quiz: "step-quiz", failed: "step-failed" };
    for (const id of ["step-password", "step-file", "step-reveal", "step-quiz", "step-failed"]) $(id).hidden = panel[s] !== id;
    const order = ["password", "file", "reveal", "quiz"];
    const cur = s === "written" ? "reveal" : s === "failed" ? "quiz" : s;
    for (const li of $("create-steps").children) {
      const k = order.indexOf(li.dataset.step);
      li.className = k < order.indexOf(cur) ? "done" : k === order.indexOf(cur) ? "now" : "";
      if (k === order.indexOf(cur)) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    }
  }

  // ---------------------------------------------------------------- start
  async function enter() {
    // Called on start and on every network change in keys mode.
    await lock("switch", { silent: true });
    discardCreation();
    w.record = null;
    try {
      w.record = await loadWallet(ctx.state.network);
    } catch (_) {
      w.record = null;
      ctx.state.storageBroken = true;
    }
    show(w.record ? "unlock" : "welcome");
    if (w.record) setTimeout(() => { if (!$("gate-unlock").hidden) $("unlock-password").focus(); }, 0);
  }

  function discardCreation() {
    if (w.creating) {
      w.creating.client.terminate();
      if (w.creating.sealed) w.creating.sealed.fill(0);
    }
    w.creating = null;
    w.flow = null;
    clearCanvas($("secret-canvas"));
    $("secret-card").hidden = true;
  }

  // ---------------------------------------------------------------- unlock
  async function unlock(password) {
    if (w.busy || !w.record) return;
    w.busy = true;
    $("unlock-btn").disabled = true;
    msg("unlock-msg", t("unlock.opening"));
    const client = createKeyClient();
    try {
      const r = await client.call("openFile", { bytes: w.record.sealed.slice(), password });
      if (r.kind !== w.record.kind) throw new Error("kind mismatch");
      msg("unlock-msg", "");
      await becomeUnlocked(client, w.record);
    } catch (e) {
      client.terminate();
      msg("unlock-msg", workerMessage(e), "bad");
    } finally {
      w.busy = false;
      $("unlock-btn").disabled = false;
    }
  }

  async function becomeUnlocked(client, record) {
    w.client = client;
    w.record = record;
    w.list = createIndexList({ kind: record.kind, saved: record.indexes });
    w.addrs = [];
    for (const index of w.list.indexes) w.addrs.push(await derive(index));
    autolock.setMinutes(record.lockMinutes);
    autolock.reset();
    w.view = null;
    ctx.onUnlocked();
  }

  async function derive(index) {
    const [a] = await w.client.call("addresses", { start: index, count: 1, network: ctx.state.network });
    if (!a || a.index !== index || typeof a.bech32 !== "string") throw new Error("derivation failed");
    return { index, address: a.bech32 };
  }

  async function lock(reason, { silent = false } = {}) {
    const client = w.client;
    w.client = null;
    w.addrs = [];
    w.list = null;
    clearCanvas($("ws-canvas"));
    $("ws-secret").hidden = true;
    if (client) {
      ctx.onLocked(reason);
      await client.lock();
    }
    if (!silent && w.record) show("unlock");
  }

  // ---------------------------------------------------------------- create
  function startCreate() {
    if (w.record) return; // one wallet per network: remove the stored one first
    discardCreation();
    w.flow = createBackupFlow({ random: randomFill });
    $("create-file-done").disabled = true;
    $("create-reveal").hidden = false;
    $("create-written").hidden = true;
    msg("create-pw-msg", "");
    msg("create-file-msg", "");
    msg("quiz-msg", "");
    show("create");
    $("create-pw1").focus();
  }

  function checkNewPassword(p1, p2, msgId) {
    if (p1.length < MIN_PASSWORD) {
      msg(msgId, t("pw.short", { n: MIN_PASSWORD }), "bad");
      return false;
    }
    if (p1 !== p2) {
      msg(msgId, t("pw.mismatch"), "bad");
      return false;
    }
    return true;
  }

  async function createPassword() {
    if (w.busy || !w.flow || w.flow.state !== "password") return;
    const p1 = $("create-pw1").value;
    const p2 = $("create-pw2").value;
    if (!checkNewPassword(p1, p2, "create-pw-msg")) return;
    $("create-pw1").value = "";
    $("create-pw2").value = "";
    w.busy = true;
    msg("create-pw-msg", t("create.generating"));
    const client = createKeyClient();
    try {
      const g = await client.call("generate", {});
      const sealed = await client.call("seal", { password: p1 });
      if (!(sealed instanceof Uint8Array) || sealed.length !== 105) throw new Error("seal failed");
      w.creating = { client, sealed, kind: g.kind };
      msg("create-pw-msg", "");
      w.flow.passwordSet();
      ctx.render();
      $("create-download").focus();
    } catch (e) {
      client.terminate();
      msg("create-pw-msg", workerMessage(e), "bad");
    } finally {
      w.busy = false;
    }
  }

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function backupName() {
    return "jetsam-" + ctx.state.network + "-wallet.key";
  }

  function createDownload() {
    if (!w.creating || w.flow.state !== "file") return;
    download(w.creating.sealed, backupName());
    msg("create-file-msg", t("create.downloaded", { name: backupName() }), "good");
    $("create-file-done").disabled = false;
  }

  async function createReveal() {
    if (w.busy || !w.creating || w.flow.state !== "reveal") return;
    w.busy = true;
    try {
      const bytes = await w.creating.client.call("reveal", {});
      try {
        drawSecret($("secret-canvas"), bytes, colors());
      } finally {
        bytes.fill(0);
      }
      $("secret-card").hidden = false;
      $("create-reveal").hidden = true;
      $("create-written").hidden = false;
      w.flow.secretShown();
      ctx.render();
    } catch (e) {
      msg("create-file-msg", workerMessage(e), "bad");
    } finally {
      w.busy = false;
    }
  }

  function createWritten() {
    if (!w.flow || w.flow.state !== "written") return;
    clearCanvas($("secret-canvas"));
    $("secret-card").hidden = true;
    w.flow.secretWritten();
    const quiz = $("quiz");
    quiz.replaceChildren();
    for (const g of w.flow.challenges) {
      const id = "quiz-g" + g;
      const lab = el("label", "", t("create.group", { n: g + 1 }));
      lab.htmlFor = id;
      const inp = el("input", "quiz-input");
      inp.id = id;
      inp.type = "text";
      inp.autocomplete = "off";
      inp.spellcheck = false;
      inp.maxLength = 8;
      inp.dataset.group = String(g);
      inp.setAttribute("autocapitalize", "off");
      const box = el("div", "quiz-item");
      box.append(lab, inp);
      quiz.append(box);
    }
    msg("quiz-msg", "");
    ctx.render();
    const first = quiz.querySelector("input");
    if (first) first.focus();
  }

  async function createQuiz() {
    if (w.busy || !w.flow || w.flow.state !== "quiz") return;
    const inputs = [...$("quiz").querySelectorAll("input")];
    const items = inputs.map((i) => ({ group: Number(i.dataset.group), text: i.value }));
    if (items.some((it) => it.text.replace(/\s/g, "").length !== 4)) {
      msg("quiz-msg", t("create.quiz_four"), "bad");
      return;
    }
    w.busy = true;
    try {
      const ok = await w.creating.client.call("checkGroups", { items });
      for (const i of inputs) i.value = "";
      w.flow.answer(ok === true);
      if (w.flow.state === "done") {
        await finishCreate();
      } else if (w.flow.state === "failed") {
        w.creating.client.terminate();
        ctx.render();
      } else {
        msg("quiz-msg", t("create.quiz_wrong", { n: w.flow.attemptsLeft }), "bad");
        ctx.render();
      }
    } catch (e) {
      msg("quiz-msg", workerMessage(e), "bad");
    } finally {
      w.busy = false;
    }
  }

  async function finishCreate() {
    const { client, sealed, kind } = w.creating;
    const record = {
      network: ctx.state.network, kind, sealed: sealed.slice(), createdAt: Date.now(),
      indexes: { indexes: [0], active: 0 }, pending: [], lockMinutes: 5,
    };
    w.creating = null;
    w.flow = null;
    let stored = true;
    try {
      if (await loadWallet(record.network)) throw new Error("a wallet is already stored for this network");
      await saveWallet(record);
    } catch (_) {
      stored = false;
    }
    await becomeUnlocked(client, record);
    ctx.notice(stored ? t("create.ready") : t("wallet.not_stored"));
  }

  // ---------------------------------------------------------------- open
  function startOpen() {
    if (w.record) return;
    msg("open-msg", "");
    show("open");
  }

  async function openSubmit() {
    if (w.busy) return;
    const mode = $("open-mode-file").checked ? "file" : "hex";
    const p1 = $("open-pw1").value;
    const p2 = $("open-pw2").value;
    let request;
    if (mode === "hex") {
      const c = classifySecretText($("open-hex").value);
      if (!c.ok) {
        msg("open-msg", t("open.err." + c.error), "bad");
        return;
      }
      if (!checkNewPassword(p1, p2, "open-msg")) return;
      const kind = document.querySelector('input[name="open-kind"]:checked').value === "spend" ? "spend" : "seed";
      request = ["importHex", { text: takeValue("open-hex"), kind }];
    } else {
      const f = $("open-file").files && $("open-file").files[0];
      if (!f) {
        msg("open-msg", t("open.err.no_file"), "bad");
        return;
      }
      if (f.size > 4096) {
        msg("open-msg", t("open.err.file_size"), "bad");
        return;
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const c = classifyKeyFile(bytes);
      if (!c.ok) {
        bytes.fill(0);
        const keys = { size: "open.err.file_size", magic: "open.err.file_magic", hex_text: "open.err.file_hex_text" };
        msg("open-msg", t(keys[c.error] || "open.err.file_magic"), "bad");
        return;
      }
      if (!checkNewPassword(p1, p2, "open-msg")) return;
      const filePass = takeValue("open-file-pass");
      if (c.format === "sealed" && !filePass) {
        msg("open-msg", t("wallet.err.need_password"), "bad");
        return;
      }
      $("open-file").value = "";
      request = ["openFile", { bytes, password: c.format === "sealed" ? filePass : null }, [bytes.buffer]];
    }
    $("open-pw1").value = "";
    $("open-pw2").value = "";
    w.busy = true;
    $("open-go").disabled = true;
    msg("open-msg", t("unlock.opening"));
    const client = createKeyClient();
    try {
      const r = await client.call(request[0], request[1], request[2]);
      const sealed = await client.call("seal", { password: p1 });
      const record = {
        network: ctx.state.network, kind: r.kind, sealed, createdAt: Date.now(),
        indexes: { indexes: [0], active: 0 }, pending: [], lockMinutes: 5,
      };
      let stored = true;
      try {
        if (await loadWallet(record.network)) throw new Error("exists");
        await saveWallet(record);
      } catch (_) {
        stored = false;
      }
      msg("open-msg", "");
      await becomeUnlocked(client, record);
      ctx.notice(stored ? t(r.kind === "spend" ? "open.ready_spend" : "open.ready") : t("wallet.not_stored"));
    } catch (e) {
      client.terminate();
      msg("open-msg", workerMessage(e), "bad");
    } finally {
      w.busy = false;
      $("open-go").disabled = false;
    }
  }

  // ---------------------------------------------------------------- addresses
  async function persistIndexes() {
    if (!w.list || !w.record) return;
    w.record.indexes = w.list.toJSON();
    try {
      await patchWallet(w.record.network, { indexes: w.record.indexes });
    } catch (_) {
      /* the session keeps working; the list is just not remembered */
    }
  }

  async function newAddress() {
    if (!w.client || !w.list) return;
    const i = w.list.next();
    if (i === null) {
      msg("keys-msg", t(w.list.single ? "keys.single" : "keys.full"), "warn");
      return;
    }
    const a = await derive(i);
    w.addrs.push(a);
    await persistIndexes();
    msg("keys-msg", t("keys.added", { n: i }), "good");
    ctx.onAddressesChanged({ fresh: [a.address], receive: a.address });
  }

  async function scan() {
    if (!w.client || !w.list || w.busy) return;
    const candidates = w.list.scanCandidates(3);
    if (!candidates.length) {
      msg("keys-msg", t(w.list.single ? "keys.single" : "keys.full"), "warn");
      return;
    }
    w.busy = true;
    $("addr-scan").disabled = true;
    msg("keys-msg", t("keys.scanning", { from: candidates[0], to: candidates[candidates.length - 1] }));
    const found = [];
    try {
      for (const i of candidates) {
        const a = await derive(i);
        const raw = await ctx.rpc().call("getSlotsByOwner", [a.address]);
        const rows = normalizeSlots(raw === null ? [] : raw, a.address);
        if (rows.length) found.push(a);
      }
      if (found.length) {
        w.list.addFound(found.map((a) => a.index));
        for (const a of found) w.addrs.push(a);
        w.addrs.sort((x, y) => x.index - y.index);
        await persistIndexes();
        ctx.onAddressesChanged({ fresh: found.map((a) => a.address) });
      }
      const range = { from: candidates[0], to: candidates[candidates.length - 1] };
      msg("keys-msg", found.length ? ctx.tp("keys.scan_found", found.length, range) : t("keys.scan_none", range), found.length ? "good" : "");
    } catch (e) {
      msg("keys-msg", ctx.describeError(e), "bad");
    } finally {
      w.busy = false;
      $("addr-scan").disabled = false;
    }
  }

  async function hide(address) {
    const a = w.addrs.find((x) => x.address === address);
    if (!a || !w.list || w.list.indexes.length <= 1) return;
    w.list.hide(a.index);
    w.addrs = w.addrs.filter((x) => x.index !== a.index);
    await persistIndexes();
    ctx.onAddressesChanged({});
  }

  async function setActive(address) {
    const a = w.addrs.find((x) => x.address === address);
    if (!a || !w.list) return;
    w.list.setActive(a.index);
    await persistIndexes();
  }

  // ---------------------------------------------------------------- settings
  async function settingsReveal() {
    if (!w.client) return;
    const password = takeValue("ws-password");
    msg("ws-msg", t("unlock.opening"));
    try {
      await w.client.call("grantReveal", { sealed: w.record.sealed.slice(), password });
      const bytes = await w.client.call("reveal", {});
      try {
        drawSecret($("ws-canvas"), bytes, colors());
      } finally {
        bytes.fill(0);
      }
      $("ws-secret").hidden = false;
      msg("ws-msg", t("ws.revealed"), "warn");
    } catch (e) {
      msg("ws-msg", workerMessage(e), "bad");
    }
  }

  function settingsHide() {
    clearCanvas($("ws-canvas"));
    $("ws-secret").hidden = true;
    msg("ws-msg", "");
  }

  function settingsBackup() {
    if (!w.record) return;
    download(w.record.sealed.slice(), backupName());
    msg("ws-msg", t("create.downloaded", { name: backupName() }), "good");
  }

  async function settingsForget() {
    if (!w.record || !$("ws-forget-ok").checked) return;
    const btn = $("ws-forget");
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = t("ws.forget_confirm");
      return;
    }
    btn.dataset.armed = "";
    btn.textContent = t("ws.forget");
    await lock("forget", { silent: true });
    try {
      await forgetWallet(w.record.network);
    } catch (_) {
      /* reported below by the gate still finding it */
    }
    ctx.closeSettings();
    await enter();
  }

  async function setLockMinutes(m) {
    autolock.setMinutes(m);
    if (w.record) {
      w.record.lockMinutes = autolock.minutes;
      try {
        await patchWallet(w.record.network, { lockMinutes: w.record.lockMinutes });
      } catch (_) {
        /* not remembered */
      }
    }
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    $("choose-create").addEventListener("click", startCreate);
    $("choose-open").addEventListener("click", startOpen);
    $("choose-watch").addEventListener("click", () => ctx.setMode("watch"));
    $("gate-unlock").addEventListener("submit", (ev) => {
      ev.preventDefault();
      unlock(takeValue("unlock-password"));
    });
    $("unlock-other").addEventListener("click", () => {
      msg("unlock-msg", t("unlock.other_help"), "warn");
    });
    $("step-password").addEventListener("submit", (ev) => {
      ev.preventDefault();
      createPassword();
    });
    $("create-cancel").addEventListener("click", () => {
      discardCreation();
      show(w.record ? "unlock" : "welcome");
    });
    $("create-download").addEventListener("click", createDownload);
    $("create-file-done").addEventListener("click", () => {
      if (w.flow && w.flow.state === "file") {
        w.flow.fileSaved();
        ctx.render();
      }
    });
    $("create-reveal").addEventListener("click", createReveal);
    $("create-written").addEventListener("click", createWritten);
    $("step-quiz").addEventListener("submit", (ev) => {
      ev.preventDefault();
      createQuiz();
    });
    $("create-restart").addEventListener("click", startCreate);
    for (const id of ["open-mode-hex", "open-mode-file"]) {
      $(id).addEventListener("change", () => {
        $("open-hex-box").hidden = !$("open-mode-hex").checked;
        $("open-file-box").hidden = !$("open-mode-file").checked;
      });
    }
    $("gate-open").addEventListener("submit", (ev) => {
      ev.preventDefault();
      openSubmit();
    });
    $("open-cancel").addEventListener("click", () => {
      $("open-hex").value = "";
      $("open-file").value = "";
      $("open-file-pass").value = "";
      show("welcome");
    });
    $("lock-btn").addEventListener("click", () => lock("button"));
    $("addr-new").addEventListener("click", () => newAddress().catch((e) => msg("keys-msg", workerMessage(e), "bad")));
    $("addr-scan").addEventListener("click", scan);
    $("ws-reveal").addEventListener("click", settingsReveal);
    $("ws-hide").addEventListener("click", settingsHide);
    $("ws-backup").addEventListener("click", settingsBackup);
    $("ws-forget-ok").addEventListener("change", () => {
      $("ws-forget").disabled = !$("ws-forget-ok").checked;
    });
    $("ws-forget").addEventListener("click", settingsForget);
    $("lock-minutes").addEventListener("change", (ev) => setLockMinutes(Number(ev.target.value)));
    for (const type of ACTIVITY) document.addEventListener(type, () => autolock.touch(), { passive: true, capture: true });
    setInterval(() => {
      if (w.client) autolock.tick();
    }, 5_000);
  }

  return {
    wire,
    enter,
    lock,
    renderGate,
    get unlocked() { return w.client !== null; },
    get client() { return w.client; },
    get kind() { return w.record ? w.record.kind : null; },
    get record() { return w.record; },
    get lockMinutes() { return autolock.minutes; },
    addresses: () => w.addrs.map((a) => a.address),
    indexOf: (address) => {
      const a = w.addrs.find((x) => x.address === address);
      return a ? a.index : null;
    },
    activeAddress: () => {
      if (!w.list) return null;
      const a = w.addrs.find((x) => x.index === w.list.active);
      return a ? a.address : null;
    },
    hide,
    setActive,
    canHide: () => Boolean(w.list && w.list.indexes.length > 1),
    holdLock: (on) => autolock.hold(on),
    async savePending(list) {
      if (!w.record) return;
      w.record.pending = list;
      try {
        await patchWallet(w.record.network, { pending: list });
      } catch (_) {
        /* kept for this session only */
      }
    },
    settingsOpened() {
      $("lock-minutes").value = String(autolock.minutes);
      $("ws-forget-ok").checked = false;
      $("ws-forget").disabled = true;
      $("ws-forget").dataset.armed = "";
      $("ws-forget").textContent = t("ws.forget");
      $("ws-password").value = "";
      settingsHide();
    },
    settingsClosed() {
      $("ws-password").value = "";
      settingsHide();
    },
  };
}
