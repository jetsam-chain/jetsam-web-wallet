// The wallet that holds a secret: create, open, unlock, lock, addresses.
//
// The secret itself only ever exists inside the key worker (keyclient.js ->
// worker/keyworker.js). This module handles what the page may know: the
// encrypted record in IndexedDB, the index list, the derived addresses, and
// the backup gate of a new wallet.

import { createKeyClient, KeyWorkerError } from "./keyclient.js";
import { loadWallet, addWallet, patchWallet, forgetWallet, sameBytes } from "./vault.js";
import { createBackupFlow } from "./backup.js";
import { createIndexList } from "./indexes.js";
import { createAutoLock } from "./autolock.js";
import { drawSecret, clearCanvas, guardCanvas } from "./secretcanvas.js";
import { classifySecretText, classifyKeyFile, secretInputMode } from "./keyformats.js";
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
    tab: null, // this tab's hold on the wallet (tablock.js): one unlocked tab per wallet
    busy: false,
    // The payment history cannot be relied on (SEC2-03): "unreadable" when the
    // sealed list does not open, "not_stored" when this browser keeps no
    // record of this wallet (SEC2-04: nothing to record a payment in before it
    // leaves). Sending is blocked meanwhile, and nothing is written over the
    // stored list.
    historyProblem: null,
    stored: false, // the unlocked wallet is the one stored here (false: this session only)
  };
  const autolock = createAutoLock({ minutes: 5, onLock: () => lock("idle") });

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

  /** This wallet for this tab only (SEC-04); null when another tab has it. */
  async function takeTab(msgId) {
    const tab = await ctx.tabLock.acquire(ctx.state.network);
    if (!tab) msg(msgId, t("tab.busy"), "bad");
    return tab;
  }

  // ---------------------------------------------------------------- unlock
  async function unlock(password) {
    if (w.busy || !w.record) return;
    w.busy = true;
    $("unlock-btn").disabled = true;
    let client = null;
    let tab = null;
    try {
      tab = await takeTab("unlock-msg");
      if (!tab) return;
      // Another tab may have written the record since this one last held it:
      // start from what is stored, not from this tab's old copy.
      const fresh = await loadWallet(ctx.state.network);
      if (fresh) w.record = fresh;
      msg("unlock-msg", t("unlock.opening"));
      client = createKeyClient();
      const r = await client.call("openFile", { bytes: w.record.sealed.slice(), password });
      if (r.kind !== w.record.kind) throw new Error("kind mismatch");
      msg("unlock-msg", "");
      await becomeUnlocked(client, w.record, tab, true);
    } catch (e) {
      if (client) client.terminate();
      if (tab) tab.release();
      msg("unlock-msg", workerMessage(e), "bad");
    } finally {
      w.busy = false;
      $("unlock-btn").disabled = false;
    }
  }

  async function becomeUnlocked(client, record, tab, stored) {
    w.client = client;
    w.tab = tab;
    w.stored = stored;
    // The sends made from here are stored sealed (SEC-06); a record written
    // before that keeps them in clear until this first write.
    let pending = [];
    let migrate = false;
    w.historyProblem = stored ? null : "not_stored";
    if (!stored) {
      pending = [];
    } else if (record.meta) {
      try {
        pending = await openHistory(client, record.network, record.meta);
      } catch (_) {
        // Not an empty list: unknown. The reservations it holds are unknown
        // too, so sending is blocked and the stored list is left as it is.
        pending = [];
        w.historyProblem = "unreadable";
      }
    } else if (record.pending.length) {
      pending = record.pending;
      migrate = true;
    }
    record = { ...record, pending };
    w.record = record;
    w.list = createIndexList({ kind: record.kind, saved: record.indexes });
    w.addrs = [];
    for (const index of w.list.indexes) w.addrs.push(await derive(index));
    autolock.setMinutes(record.lockMinutes);
    autolock.reset();
    w.view = null;
    ctx.onUnlocked();
    if (w.historyProblem) msg("keys-msg", t("history.unreadable_short"), "bad");
    if (migrate) {
      try {
        await saveSealedPending(pending);
      } catch (_) {
        msg("keys-msg", t("history.not_saved"), "bad"); // still in clear, still read; sending re-checks
      }
    }
  }

  async function openHistory(client, network, meta) {
    const m = JSON.parse(await client.call("openMeta", { network, bytes: meta.slice() }));
    if (!m || !Array.isArray(m.pending)) throw new Error("payment history unreadable");
    return m.pending;
  }

  /** Read the stored history again (SEC2-03 "Try again"): the list, or throws. */
  async function retryHistory() {
    if (!w.client || !w.record || w.historyProblem !== "unreadable") throw new Error("nothing to retry");
    const client = w.client;
    const fresh = await loadWallet(w.record.network);
    if (!fresh || !sameBytes(fresh.sealed, w.record.sealed)) throw new Error("the stored wallet changed");
    const pending = fresh.meta ? await openHistory(client, fresh.network, fresh.meta) : fresh.pending;
    if (w.client !== client) throw new Error("locked");
    w.record.meta = fresh.meta;
    w.record.pending = pending;
    w.historyProblem = null;
    msg("keys-msg", "");
    return pending;
  }

  /**
   * Store the sends sealed by the key worker. Writes run one after the other
   * and each seals the latest list, so an older list can never land after a
   * newer one. The promise rejects when the list was not stored (locked, the
   * history unreadable, the record gone, storage refusing): the caller must
   * not treat a payment as recorded then (SEC2-03).
   */
  let saving = Promise.resolve();
  function saveSealedPending(list) {
    if (!w.record || !w.client) return Promise.reject(new Error("the wallet is locked"));
    if (w.historyProblem) return Promise.reject(new Error("payment history " + w.historyProblem));
    w.record.pending = list;
    const run = saving.catch(() => {}).then(writeSealedPending);
    saving = run;
    return run;
  }

  async function writeSealedPending() {
    const record = w.record;
    const client = w.client;
    if (!record || !client) throw new Error("the wallet is locked");
    const meta = await client.call("sealMeta", { network: record.network, text: JSON.stringify({ pending: record.pending }) });
    if (w.client !== client) throw new Error("the wallet was locked meanwhile");
    if (!(await patchWallet(record.network, { meta, pending: [] }, record.sealed))) throw new Error("the stored wallet is gone");
    record.meta = meta;
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
    const tab = w.tab;
    w.tab = null;
    if (client) {
      ctx.onLocked(reason);
      await client.lock();
    }
    if (tab) tab.release();
    if (!silent && w.record) show("unlock");
  }

  // ---------------------------------------------------------------- create
  function startCreate() {
    if (w.record) return; // one wallet per network: remove the stored one first
    discardCreation();
    w.flow = createBackupFlow();
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
      const g = await client.call("generate", { password: p1 });
      const sealed = g.sealed;
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

  async function createWritten() {
    if (w.busy || !w.flow || w.flow.state !== "written") return;
    w.busy = true;
    let groups;
    try {
      groups = await w.creating.client.call("quizStart", {});
    } catch (e) {
      msg("create-file-msg", workerMessage(e), "bad");
      return;
    } finally {
      w.busy = false;
    }
    clearCanvas($("secret-canvas"));
    $("secret-card").hidden = true;
    w.flow.secretWritten(groups);
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
    const answers = inputs.map((i) => i.value);
    if (answers.some((a) => a.replace(/\s/g, "").length !== 4)) {
      msg("quiz-msg", t("create.quiz_four"), "bad");
      return;
    }
    w.busy = true;
    let tab = null;
    try {
      // Taken before the answer is checked: refusing afterwards would leave
      // a passed check with nowhere to go.
      tab = await takeTab("quiz-msg");
      if (!tab) return;
      const verdict = await w.creating.client.call("quizAnswer", { answers });
      for (const i of inputs) i.value = "";
      w.flow.answer(verdict);
      if (w.flow.state === "done") {
        await finishCreate(tab);
        tab = null;
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
      if (tab) tab.release();
      w.busy = false;
    }
  }

  async function finishCreate(tab) {
    const { client, sealed, kind } = w.creating;
    const record = {
      network: ctx.state.network, kind, sealed: sealed.slice(), createdAt: Date.now(),
      indexes: { indexes: [0], active: 0 }, pending: [], lockMinutes: 5,
    };
    w.creating = null;
    w.flow = null;
    const stored = await store(record);
    if (stored === "exists") return refuseOverStored(client, tab, "create.err.exists");
    await becomeUnlocked(client, record, tab, stored === "stored");
    ctx.notice(stored === "stored" ? t("create.ready") : t("wallet.not_stored"));
  }

  /**
   * Add a new record: "stored", "exists" (this network already has a wallet
   * here, e.g. added from another tab since this one showed Welcome), or
   * "blocked" (storage refuses: the wallet works for this session only).
   */
  async function store(record) {
    try {
      await addWallet(record); // refused if this network already has one
      return "stored";
    } catch (_) {
      try {
        return (await loadWallet(record.network)) ? "exists" : "blocked";
      } catch (__) {
        return "blocked";
      }
    }
  }

  /**
   * Another wallet is stored for this network: never unlock this one in its
   * place, since its writes would land in that record (SEC2-04). Back to the
   * stored wallet's unlock screen.
   */
  async function refuseOverStored(client, tab, key) {
    client.terminate();
    tab.release();
    await enter();
    msg("unlock-msg", t(key), "bad");
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
      request = ["importHex", { text: takeValue("open-hex"), kind, password: p1 }];
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
      request = ["openFile", { bytes, password: c.format === "sealed" ? filePass : null, newPassword: p1 }, [bytes.buffer]];
    }
    $("open-pw1").value = "";
    $("open-pw2").value = "";
    w.busy = true;
    $("open-go").disabled = true;
    const tab = await takeTab("open-msg");
    if (!tab) {
      w.busy = false;
      $("open-go").disabled = false;
      return;
    }
    msg("open-msg", t("unlock.opening"));
    const client = createKeyClient();
    try {
      const r = await client.call(request[0], request[1], request[2]);
      const sealed = r.sealed;
      if (!(sealed instanceof Uint8Array) || sealed.length !== 105) throw new Error("seal failed");
      const record = {
        network: ctx.state.network, kind: r.kind, sealed, createdAt: Date.now(),
        indexes: { indexes: [0], active: 0 }, pending: [], lockMinutes: 5,
      };
      const stored = await store(record);
      if (stored === "exists") {
        await refuseOverStored(client, tab, "open.err.exists");
        return;
      }
      msg("open-msg", "");
      await becomeUnlocked(client, record, tab, stored === "stored");
      ctx.notice(stored === "stored" ? t(r.kind === "spend" ? "open.ready_spend" : "open.ready") : t("wallet.not_stored"));
    } catch (e) {
      client.terminate();
      tab.release();
      msg("open-msg", workerMessage(e), "bad");
    } finally {
      w.busy = false;
      $("open-go").disabled = false;
    }
  }

  // ---------------------------------------------------------------- addresses
  /** Remember the index list; false (and said so) when it could not be. */
  async function persistIndexes() {
    if (!w.list || !w.record) return false;
    w.record.indexes = w.list.toJSON();
    if (!w.stored) return true; // this session only, as the user was told
    try {
      if (await patchWallet(w.record.network, { indexes: w.record.indexes }, w.record.sealed)) return true;
    } catch (_) {
      /* another wallet's record: not written (SEC2-04) */
    }
    msg("keys-msg", t("wallet.err.not_saved"), "bad");
    return false;
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
    if (await persistIndexes()) msg("keys-msg", t("keys.added", { n: i }), "good");
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
    if (w.record && w.client && w.stored) {
      w.record.lockMinutes = autolock.minutes;
      try {
        await patchWallet(w.record.network, { lockMinutes: w.record.lockMinutes }, w.record.sealed);
      } catch (_) {
        /* not remembered */
      }
    }
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    // Engines that cannot mask a text field get a password field (SEC-09).
    if (secretInputMode(globalThis.CSS) === "password") {
      $("open-hex").type = "password";
      $("open-hex").classList.remove("masked");
      $("open-hex-help").textContent = t("open.hex_help_password");
    }
    guardCanvas($("secret-canvas"));
    guardCanvas($("ws-canvas"));
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
    savePending: (list) => saveSealedPending(list),
    retryHistory,
    get historyProblem() { return w.client ? w.historyProblem : null; },
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
