// Sending: form -> review -> proof in the key worker -> submit -> tracking.
//
// Everything the RPC says is checked (validate.js) and treated as possibly
// false: it can refuse or lie, but it never sees the secret and cannot change
// the recipient, the amount or where the change goes, which come from the
// user and the wallet. The proof is computed in the key worker; cancelling it
// terminates the worker, which locks the wallet.

import { checkRecipient, groupAddress } from "./bech32m.js";
import { parseJtm, formatJtm, formatInt } from "./amount.js";
import { normalizeSlots } from "./utxo.js";
import { proofWindow, epochPosition } from "./epoch.js";
import { checkChainInfo, checkBlockCount, checkAnchor, checkFee, checkSlotHints, checkTxid, checkMempoolEntry, checkTxInfo } from "./validate.js";
import { spendable, drawSlots, feeCheck, sendRequestJson, classifySubmitError, reviewStillHolds } from "./sendflow.js";
import { createPendingBook } from "./pending.js";
import { RpcError, describeRpcError } from "./rpc.js";
import { formatUtc } from "./timefmt.js";

const MAX_INTENT_BODY = 600_000; // a ~90 KB proof travels as ~180 KB of hex
const PROOF_ATTEMPTS = 3; // re-proofs after a stale anchor or a taken slot
const TRACK_MS = 15_000;
const EPOCH_WAIT_MS = 15_000;
const DEFAULT_PROOF_MS = 30_000;

export function createSendController(ctx, wallet) {
  const { $, el, t } = ctx;
  const s = {
    phase: "form", // form | review | proving | result
    capability: null, // null (unknown) | "ok" | "off"
    capabilityUrl: null,
    plan: null,
    pending: createPendingBook(),
    cancelled: false,
    proving: false, // a prove() is running: one at a time (SEC2-07)
    submitting: false, // past the point of no return: the intent may reach the node
    unknownTxid: null, // the result on screen is an unknown outcome for this txid
    tracking: false,
  };

  const msg = (id, text, cls) => {
    const p = $(id);
    p.className = "field-msg" + (cls ? " " + cls : "");
    p.textContent = text || "";
  };
  const jtm = (micro) => formatJtm(micro) + " JTM";
  const shortA = (a) => a.slice(0, 9) + "…" + a.slice(-6);

  // ---------------------------------------------------------------- rendering
  function render() {
    const keys = ctx.state.mode === "keys" && wallet.unlocked;
    $("send-watch").hidden = keys;
    $("send-off").hidden = !keys || s.capability !== "off";
    const formOn = keys && s.capability !== "off";
    $("send-form").hidden = !formOn || s.phase !== "form";
    $("send-review").hidden = !formOn || s.phase !== "review";
    $("send-progress").hidden = !keys || s.phase !== "proving";
    $("send-result").hidden = !keys || s.phase !== "result";
    if (keys && s.phase === "form") renderFrom();
    renderSent(keys);
  }

  function renderFrom() {
    const sel = $("send-from");
    const prev = sel.value;
    const options = [];
    for (const a of ctx.state.addresses) {
      const e = ctx.state.data.get(a);
      const rows = e && e.status === "ok" ? e.rows : [];
      const sp = spendable(rows, { tip: ctx.state.tip || 0, pendingInputs: s.pending.reservedInputs() });
      const o = el("option", "", "#" + wallet.indexOf(a) + "  " + shortA(a) + "  ·  " + formatJtm(sp.total, { trim: true }) + " JTM");
      o.value = a;
      options.push(o);
    }
    sel.replaceChildren(...options);
    const want = ctx.state.addresses.includes(prev) ? prev : wallet.activeAddress() || ctx.state.addresses[0];
    if (want) sel.value = want;
    const e = ctx.state.data.get(sel.value);
    const sp = spendable(e && e.status === "ok" ? e.rows : [], { tip: ctx.state.tip || 0, pendingInputs: s.pending.reservedInputs() });
    const parts = [t("send.spendable", { amount: formatJtm(sp.total, { trim: true }) })];
    if (sp.provisional > 0n) parts.push(t("send.held_provisional", { amount: formatJtm(sp.provisional, { trim: true }) }));
    if (sp.pending > 0n) parts.push(t("send.held_pending", { amount: formatJtm(sp.pending, { trim: true }) }));
    $("send-from-note").textContent = parts.join(" · ");
  }

  function renderSent(keys) {
    const list = s.pending.list();
    $("sent").hidden = !keys || list.length === 0;
    const ul = $("sent-list");
    ul.replaceChildren();
    for (const e of list.slice().reverse()) {
      const li = el("li", "sent-item");
      const head = el("p", "sent-head");
      head.append(el("span", "sent-amount", formatJtm(e.amount) + " JTM"), " → ", el("code", "", shortA(e.to)));
      const st = el("p", "sent-status");
      const conf = e.height !== null && ctx.state.tip !== null ? Math.max(0, ctx.state.tip - e.height + 1) : null;
      st.append(el("span", "badge " + (e.status === "final" ? "final" : e.status === "dropped" ? "bad" : "prov"), t("sent.status." + e.status)));
      if (conf !== null) st.append(" ", t("sent.confs", { n: formatInt(conf), height: formatInt(e.height) }));
      st.append(" · ", t("sent.fee", { fee: formatJtm(e.fee, { trim: true }) }));
      if (e.submittedAt) st.append(" · ", formatUtc(Math.floor(e.submittedAt / 1000)));
      const id = el("p", "mono-line", e.txid);
      li.append(head, st, id);
      ul.append(li);
    }
  }

  // ---------------------------------------------------------------- capability
  /**
   * Is submitTxIntent open on this RPC? An empty intent costs the node a
   * decode error; the public proxy answers "method not allowed" without
   * forwarding. Asked once per RPC, before any proof is spent.
   */
  async function probe() {
    const url = ctx.state.rpcUrl;
    if (s.capabilityUrl === url && s.capability !== null) return s.capability;
    try {
      await ctx.rpc().call("submitTxIntent", [""]);
      s.capability = "ok"; // an empty intent should not be accepted, but the method is open
    } catch (e) {
      const c = classifySubmitError(e);
      if (c.kind === "not_enabled") s.capability = "off";
      else if (c.kind === "unknown_outcome") s.capability = null;
      else s.capability = "ok";
    }
    s.capabilityUrl = url;
    if (s.capability === "off") $("send-off-body").textContent = t("send.off_body", { url });
    render();
    return s.capability;
  }

  // ---------------------------------------------------------------- review
  async function review() {
    msg("send-msg", "");
    msg("send-to-msg", "");
    msg("send-amount-msg", "");
    const network = ctx.state.network;
    const to = checkRecipient($("send-to").value, network);
    if (!to.ok) {
      const key = to.error === "other_network" ? "send.err.other_network" : "addr.err." + to.error;
      msg("send-to-msg", t(key, { network: t("net." + (to.network || network)) }), "bad");
      return;
    }
    const amount = parseJtm($("send-amount").value);
    if (!amount.ok) {
      msg("send-amount-msg", t("amount.err." + amount.error), "bad");
      return;
    }
    const from = $("send-from").value;
    const index = wallet.indexOf(from);
    if (index === null) {
      msg("send-msg", t("send.err.no_from"), "bad");
      return;
    }
    if (ctx.state.genesis !== "ok") {
      msg("send-msg", t("send.err.chain"), "bad");
      return;
    }
    $("send-review-btn").disabled = true;
    msg("send-msg", t("send.preparing"));
    try {
      if ((await probe()) === "off") return;
      const rpc = ctx.rpc();
      const chain = checkChainInfo(await rpc.call("getChainInfo"));
      const raw = await rpc.call("getSlotsByOwner", [from]);
      const rows = normalizeSlots(raw === null ? [] : raw, from);
      const sp = spendable(rows, { tip: chain.height, pendingInputs: s.pending.reservedInputs() });
      const relay = checkFee(await rpc.call("estimateFee", [2]));
      const base = { utxos: sp.utxos, amount: amount.micro.toString(), fee: null, active_slot_count: chain.activeSlotCount.toString(), log_slots: chain.logSlots };
      let plan;
      try {
        plan = JSON.parse(await wallet.client.call("plan", { json: JSON.stringify({ ...base, relay_floor: relay.toString() }) }));
      } catch (e) {
        msg("send-msg", planError(e, sp), "bad");
        return;
      }
      const minimum = JSON.parse(await wallet.client.call("plan", { json: JSON.stringify({ ...base, relay_floor: "0" }) }));
      const fee = BigInt(plan.fee);
      const check = feeCheck(fee, BigInt(minimum.fee));
      if (!check.ok) {
        msg("send-msg", t(check.below ? "send.err.fee_below" : "send.err.fee_cap", { fee: formatJtm(fee) }), "bad");
        return;
      }
      s.plan = {
        rpcUrl: ctx.state.rpcUrl,
        network, from, index, to: to.address, amount: amount.micro, fee, change: BigInt(plan.change),
        total: BigInt(plan.total_spend), inputs: plan.input_count, utxos: sp.utxos,
        chain, ownSlots: rows.map((r) => r.slot), warn: check.warn, minimumFee: BigInt(minimum.fee),
      };
      showReview();
    } catch (e) {
      msg("send-msg", ctx.describeError(e), "bad");
    } finally {
      $("send-review-btn").disabled = false;
    }
  }

  function planError(e, sp) {
    const m = e && e.message ? e.message : String(e);
    const have = /have (\d+)/.exec(m);
    const need = /need (\d+)/.exec(m);
    if (/insufficient/i.test(m)) {
      let text = t("send.err.funds", { need: need ? formatJtm(BigInt(need[1]), { trim: true }) : "?", have: formatJtm(sp.total, { trim: true }) });
      if (sp.provisional > 0n || sp.pending > 0n) text += " " + t("send.err.funds_held");
      return text;
    }
    if (/more than \d+ active UTXOs/.test(m)) return t("send.err.too_many_inputs");
    if (/fee/.test(m)) return t("send.err.fee_plan");
    return t("wallet.err.generic", { message: m.slice(0, 200) });
  }

  function showReview() {
    const p = s.plan;
    $("rv-network").textContent = t("net." + p.network);
    $("rv-from").textContent = "#" + p.index + " · " + p.from;
    const to = $("rv-to");
    to.replaceChildren(...groupAddress(p.to).map((g) => el("span", "", g)));
    $("rv-amount").textContent = jtm(p.amount);
    $("rv-fee").textContent = jtm(p.fee);
    $("rv-total").textContent = jtm(p.total);
    $("rv-change").textContent = jtm(p.change);
    $("rv-inputs").textContent = formatInt(p.inputs);
    const warns = [];
    if (p.warn) warns.push(t("review.warn_fee", { minimum: formatJtm(p.minimumFee, { trim: true }) }));
    if (ctx.state.addresses.includes(p.to)) warns.push(t("review.warn_self"));
    if (ctx.state.customRpc) warns.push(t("review.warn_rpc"));
    $("rv-warn").hidden = warns.length === 0;
    $("rv-warn").textContent = warns.join(" ");
    s.phase = "review";
    msg("send-msg", "");
    render();
    $("review-go").focus();
  }

  // ---------------------------------------------------------------- proving
  let progressTimer = null;
  function startProgress(status) {
    const expected = Number(ctx.store.get("proofMs", DEFAULT_PROOF_MS)) || DEFAULT_PROOF_MS;
    const t0 = Date.now();
    $("prove-status").textContent = status;
    stopProgress();
    const tick = () => {
      const elapsed = Date.now() - t0;
      // Elapsed against the last proof's duration on this device: an
      // estimate, never reaching the end until the proof is done.
      const frac = Math.min(0.95, elapsed / Math.max(expected, 1000));
      $("prove-bar").value = Math.round(frac * 1000);
      $("prove-time").textContent = t("prove.elapsed", { s: (elapsed / 1000).toFixed(0), e: Math.round(expected / 1000) });
    };
    tick();
    progressTimer = setInterval(tick, 500);
  }
  function stopProgress() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
  }

  function setPhase(phase) {
    s.phase = phase;
    render();
  }

  function result(text, txid, cls) {
    stopProgress();
    const p = $("result-text");
    p.className = cls || "";
    p.textContent = text;
    $("result-txid").textContent = txid || "";
    setPhase("result");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForWindow(rpc) {
    for (;;) {
      if (s.cancelled) throw new Error("cancelled");
      const tip = checkBlockCount(await rpc.call("blockCount"));
      const w = proofWindow(tip);
      if (w.ok) return tip;
      $("prove-status").textContent = t("prove.wait_epoch", { n: w.blocksLeft, h: formatInt(w.resumeAt) });
      await sleep(EPOCH_WAIT_MS);
    }
  }

  async function slotsFor(rpc, p, avoid) {
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    const want = 2 + s.pending.reservedOutputs().size;
    try {
      const hints = checkSlotHints(await rpc.call("getSlotHintsSalted", [want, salt]), want, p.chain.logSlots);
      const free = hints.filter((h) => !avoid.has(h));
      if (free.length >= 2) return { slots: free, drawn: false };
    } catch (e) {
      if (!(e instanceof RpcError && classifySubmitError(e).kind === "not_enabled")) throw e;
    }
    return { slots: drawSlots(2, p.chain.logSlots, avoid, (a) => crypto.getRandomValues(a)), drawn: true };
  }

  function setSubmitting(on) {
    s.submitting = on;
    $("prove-cancel").disabled = on;
    $("prove-cancel").textContent = t(on ? "prove.no_cancel" : "prove.cancel");
  }

  async function prove() {
    // Only from the review screen, and never twice at once: two clicks in the
    // same task would prove (and submit) the same inputs twice (SEC2-07).
    if (s.phase !== "review" || s.proving) return;
    const p = s.plan;
    if (!p || !wallet.unlocked) return;
    if (!reviewStillHolds(p, ctx.state)) return voidReview();
    s.proving = true;
    s.cancelled = false;
    setPhase("proving");
    wallet.holdLock(true);
    const rpc = ctx.rpc();
    const avoid = new Set([...p.ownSlots, ...s.pending.reservedOutputs()]);
    try {
      for (let attempt = 1; attempt <= PROOF_ATTEMPTS; attempt++) {
        if (!reviewStillHolds(p, ctx.state)) return result(t("result.rpc_changed"), "", "bad");
        $("prove-status").textContent = t("prove.preparing");
        const tip = await waitForWindow(rpc);
        const anchor = checkAnchor(await rpc.call("getEpochAnchor"));
        const { slots, drawn } = await slotsFor(rpc, p, avoid);
        const json = sendRequestJson({
          index: p.index, network: p.network, utxos: p.utxos, to: p.to, amount: p.amount, fee: p.fee,
          anchor, slotHints: slots, pendingOutputSlots: [...s.pending.reservedOutputs()],
        });
        startProgress(t(attempt === 1 ? "prove.running" : "prove.again", { n: attempt, max: PROOF_ATTEMPTS }) + (drawn ? " " + t("prove.drawn_slots") : ""));
        const t0 = performance.now();
        const out = await wallet.client.call("build", { json });
        const ms = performance.now() - t0;
        ctx.store.set("proofMs", Math.round(ms));
        ctx.state.lastProofMs = Math.round(ms);
        stopProgress();
        $("prove-bar").value = 1000;
        $("prove-time").textContent = t("prove.done_in", { s: (ms / 1000).toFixed(1) });
        if (s.cancelled) throw new Error("cancelled");

        // The chain may have moved to a new epoch during the proof.
        $("prove-status").textContent = t("prove.checking");
        const anchorNow = checkAnchor(await rpc.call("getEpochAnchor"));
        if (anchorNow !== anchor) {
          if (attempt < PROOF_ATTEMPTS) continue;
          return result(t("result.stale"), "", "bad");
        }
        // Settings may have switched the RPC during the proof (SEC-11).
        if (!reviewStillHolds(p, ctx.state)) return result(t("result.rpc_changed"), "", "bad");
        // The txid is the one computed (and verified) here, never the RPC's.
        const txid = out.built.logical_txid;
        // Point of no return: from here the intent may reach the node. Cancel
        // no longer applies, and the send is recorded first, as an unknown
        // outcome with its inputs reserved, so that closing the tab or losing
        // the answer cannot make it look like nothing was sent (SEC-02).
        setSubmitting(true);
        $("prove-status").textContent = t("prove.submitting");
        s.pending.add({
          txid, fromIndex: p.index, to: p.to, amount: p.amount, fee: p.fee,
          inputs: out.built.input_slots, outputs: out.built.output_slots,
          anchorHeight: epochPosition(tip).anchorHeight, submittedAt: Date.now(),
        });
        await wallet.savePending(s.pending.toJSON());
        let outcome = "ok";
        try {
          checkTxid(await rpc.call("submitTxIntent", [out.built.intent_hex], { maxBodyBytes: MAX_INTENT_BODY }), txid);
        } catch (e) {
          const c = classifySubmitError(e);
          if (c.kind === "already") outcome = "ok";
          else if (c.kind === "unknown_outcome") outcome = "unknown";
          else {
            // An explicit refusal: this intent was not admitted.
            s.pending.remove(txid);
            await wallet.savePending(s.pending.toJSON());
            setSubmitting(false);
            if (c.kind === "slot_conflict" && attempt < PROOF_ATTEMPTS) {
              for (const sl of out.built.output_slots) avoid.add(sl);
              continue;
            }
            if (c.kind === "stale_anchor" && attempt < PROOF_ATTEMPTS) continue;
            return refused(c, e);
          }
        }
        if (outcome === "ok") {
          s.pending.admitted(txid);
          await wallet.savePending(s.pending.toJSON());
        }
        s.plan = null;
        $("send-to").value = "";
        $("send-amount").value = "";
        s.unknownTxid = outcome === "ok" ? null : txid;
        result(t(outcome === "ok" ? "result.sent" : "result.unknown", { amount: jtm(p.amount) }), txid, outcome === "ok" ? "good" : "warn");
        ctx.onSent();
        track();
        return;
      }
      result(t("result.gave_up"), "", "bad");
    } catch (e) {
      stopProgress();
      if (s.cancelled || (e && e.cancelled)) return; // cancel() already rendered
      result(ctx.describeError(e), "", "bad");
    } finally {
      setSubmitting(false);
      wallet.holdLock(false);
      s.proving = false;
    }
  }

  /**
   * The RPC (or the network) changed after the review: back to the form, the
   * payment has to be reviewed again against the new RPC (SEC-11). A send
   * already past its point of no return is left to finish where it went.
   */
  function voidReview() {
    if (s.phase === "proving" || !s.plan) return;
    s.plan = null;
    s.capability = null;
    setPhase("form");
    msg("send-msg", t("send.err.rpc_changed"), "warn");
  }

  function refused(c, e) {
    if (c.kind === "not_enabled") {
      s.capability = "off";
      $("send-off-body").textContent = t("send.off_body", { url: ctx.state.rpcUrl });
      return result(t("send.off_title"), "", "bad");
    }
    if (c.kind === "fee_too_low") return result(t("result.fee_low", { fee: formatJtm(c.required) }), "", "bad");
    if (c.kind === "inputs_changed") return result(t("result.inputs_changed"), "", "bad");
    if (c.kind === "stale_anchor") return result(t("result.stale"), "", "bad");
    if (c.kind === "slot_conflict") return result(t("result.slots"), "", "bad");
    // The node's (or the RPC's) own words are not shown (SEC-08).
    return result(t("result.rejected", { reason: describeRpcError(e, t) || t("error.parse") }), "", "bad");
  }

  function cancel() {
    // Once the intent may have reached the node, there is nothing to cancel.
    if (s.phase !== "proving" || s.submitting) return;
    s.cancelled = true;
    stopProgress();
    // A running proof cannot be interrupted: end the worker, and the secret
    // with it. The wallet locks; nothing was sent.
    wallet.lock("cancel");
    result(t("result.cancelled"), "", "warn");
  }

  // ---------------------------------------------------------------- tracking
  async function trackOnce() {
    const open = s.pending.open();
    if (!open.length || !wallet.unlocked) return false;
    const rpc = ctx.rpc();
    const tip = checkBlockCount(await rpc.call("blockCount"));
    ctx.state.tip = tip;
    let confirmedNow = false;
    for (const e of open) {
      const entry = checkMempoolEntry(await rpc.call("getMempoolEntry", [e.txid]), e.txid);
      let height = null;
      if (!entry) {
        const info = checkTxInfo(await rpc.call("getTx", [e.txid]), e.txid, tip);
        height = info ? info.height : null;
        if (height !== null && e.height === null) confirmedNow = true;
      }
      s.pending.update(e.txid, { mempool: Boolean(entry), height, tip });
    }
    await wallet.savePending(s.pending.toJSON());
    resolveUnknown();
    if (confirmedNow) ctx.refreshAll();
    ctx.render();
    return s.pending.open().length > 0;
  }

  /** The result on screen said "may have been accepted": say what is known now. */
  function resolveUnknown() {
    if (!s.unknownTxid || s.phase !== "result") return;
    const e = s.pending.list().find((x) => x.txid === s.unknownTxid);
    if (!e || e.status === "unknown") return;
    const dropped = e.status === "dropped";
    s.unknownTxid = null;
    const p = $("result-text");
    p.className = dropped ? "bad" : "good";
    p.textContent = t(dropped ? "result.unknown_dropped" : "result.unknown_accepted", { amount: jtm(e.amount) });
  }

  async function track() {
    if (s.tracking) return;
    s.tracking = true;
    try {
      for (;;) {
        if (document.visibilityState === "visible") {
          let more = true;
          try {
            more = await trackOnce();
          } catch (_) {
            more = true; // RPC hiccup: try again next round
          }
          if (!more) break;
        }
        await sleep(TRACK_MS);
        if (!wallet.unlocked) break;
      }
    } finally {
      s.tracking = false;
    }
  }

  // ---------------------------------------------------------------- lifecycle
  function onUnlocked(record) {
    s.pending = createPendingBook(record.pending);
    s.phase = "form";
    s.plan = null;
    s.capability = null;
    if (s.pending.open().length) track();
  }

  function onLocked() {
    stopProgress();
    if (s.phase !== "result") s.phase = "form";
    s.plan = null;
    s.unknownTxid = null;
    $("send-to").value = "";
    $("send-amount").value = "";
  }

  function wire() {
    $("send-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      review();
    });
    $("send-from").addEventListener("change", () => renderFrom());
    $("review-back").addEventListener("click", () => {
      s.plan = null;
      setPhase("form");
    });
    $("review-go").addEventListener("click", () => prove());
    $("prove-cancel").addEventListener("click", cancel);
    $("result-new").addEventListener("click", () => {
      setPhase("form");
      $("send-to").focus();
    });
  }

  return {
    wire,
    render,
    probe,
    onUnlocked,
    onLocked,
    rpcChanged: voidReview,
    reservedInputs: () => s.pending.reservedInputs(),
    get phase() { return s.phase; },
  };
}
