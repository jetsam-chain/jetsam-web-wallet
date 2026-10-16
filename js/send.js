// Sending: form -> review -> proof in the key worker -> submit -> tracking.
//
// Everything the RPC says is checked (validate.js) and treated as possibly
// false: it can refuse or lie, but it never sees the secret and cannot change
// the recipient, the amount or where the change goes, which come from the
// user and the wallet. The proof is computed in the key worker; cancelling it
// terminates the worker, which locks the wallet.

import { checkRecipient, groupAddress } from "./bech32m.js";
import { parseJtm, formatJtm, formatInt } from "./amount.js";
import { normalizeSlots, isProvisional, FINALITY_DEPTH } from "./utxo.js";
import { proofWindow, epochPosition } from "./epoch.js";
import { checkChainInfo, checkBlockCount, checkAnchor, checkFee, checkSlotHints, checkTxid, checkMempoolEntry, checkTxInfo } from "./validate.js";
import { spendable, drawSlots, feeCheck, sendRequestJson, classifySubmitError, reviewStillHolds, afterRefusal, reproofUtxos, locateReceived, fundsMessage, intentFits, MAX_SUBMIT_BODY } from "./sendflow.js";
import { NETWORKS } from "./networks.js";
import { createPendingBook, holdInfo, EXPIRY_BLOCKS } from "./pending.js";
import { RpcError, describeRpcError } from "./rpc.js";
import { formatUtc } from "./timefmt.js";

const PROOF_ATTEMPTS = 3; // re-proofs after a stale anchor or a taken slot
const TRACK_MS = 15_000;
const TRACK_MAX_MS = 120_000; // the longest pause after failed rounds (SEC3-06)
const EPOCH_WAIT_MS = 15_000;
const DEFAULT_PROOF_MS = 30_000;

export function createSendController(ctx, wallet) {
  const { $, el, t, setText } = ctx;
  const s = {
    phase: "form", // form | review | proving | result
    capability: null, // null (unknown) | "ok" | "off"
    capabilityUrl: null,
    plan: null,
    pending: createPendingBook(),
    cancelled: false,
    proving: false, // a prove() is running: one at a time (SEC2-07)
    heldEarlier: false, // an earlier proof of this payment was refused by the RPC and is held (SEC2-01)
    submitting: false, // past the point of no return: the intent may reach the node
    unknownTxid: null, // the result on screen is an unknown outcome for this txid
    tracking: false,
    round: 0, // tracking rounds since the page loaded (SEC3-06)
  };

  // text: a string, or a function of the language (setText, i18n.js).
  const msg = (id, text, cls) => {
    const p = $(id);
    p.className = "field-msg" + (cls ? " " + cls : "");
    setText(p, text || "");
  };
  const jtm = (micro) => formatJtm(micro) + " JTM";
  const shortA = (a) => a.slice(0, 9) + "…" + a.slice(-6);

  // ---------------------------------------------------------------- rendering
  function render() {
    const keys = ctx.state.mode === "keys" && wallet.unlocked;
    $("send-watch").hidden = keys;
    $("send-off").hidden = !keys || s.capability !== "off";
    // Payment history unknown: no new payment until it is (SEC2-03).
    const problem = keys ? wallet.historyProblem : null;
    $("send-history").hidden = !problem;
    if (problem) $("send-history-body").textContent = t("history." + problem);
    const formOn = keys && s.capability !== "off" && !problem;
    $("send-form").hidden = !formOn || s.phase !== "form";
    $("send-review").hidden = !formOn || s.phase !== "review";
    $("send-progress").hidden = !keys || s.phase !== "proving";
    $("send-result").hidden = !keys || s.phase !== "result";
    $("send-to").placeholder = NETWORKS[ctx.state.network].hrp + "1…";
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
    if (sp.unknown > 0n) parts.push(t("send.held_unknown", { amount: formatJtm(sp.unknown, { trim: true }) }));
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
      // A reported expiry is shown as a doubt until it is believed (SEC2-02).
      const label = e.expiring ? t("sent.status.expiring") : t("sent.status." + e.status);
      const badge = { final: "final", dropped: "bad", refused: "bad", superseded: "" }[e.status];
      st.append(el("span", "badge " + (badge === undefined ? "prov" : badge), label));
      if (conf !== null) st.append(" ", t("sent.confs", { n: formatInt(conf), height: formatInt(e.height) }));
      st.append(" · ", t("sent.fee", { fee: formatJtm(e.fee, { trim: true }) }));
      if (e.submittedAt) st.append(" · ", formatUtc(Math.floor(e.submittedAt / 1000)));
      const id = el("p", "mono-line", e.txid);
      li.append(head, st, id);
      if (e.contradicted) li.append(el("p", "fine", t("sent.contradicted." + e.contradicted)));
      // What the public RPC said (SEC3-01).
      if (e.crossCheck) li.append(el("p", "fine warn-text", t("sent.crosscheck." + e.crossCheck)));
      if (e.status === "dropped" && e.checked) li.append(el("p", "fine", t("sent.expired." + e.checked)));
      if (e.status === "superseded" && e.supersededBy) li.append(el("p", "fine", t("sent.superseded", { txid: e.supersededBy.slice(0, 12) })));
      // Why the inputs are still held, and until when (SEC3-03).
      const hold = holdInfo(e, ctx.state.tip);
      if (hold) {
        const vars = { height: formatInt(hold.height), n: formatInt(hold.blocks || 0) };
        li.append(el("p", hold.kind === "no_block" ? "fine warn-text" : "fine", t("sent.hold." + hold.kind, vars)));
      }
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
    if (s.capability === "off") setText($("send-off-body"), () => t("send.off_body", { url }));
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
      msg("send-to-msg", () => t("addr.err." + to.error), "bad");
      return;
    }
    const amount = parseJtm($("send-amount").value);
    if (!amount.ok) {
      msg("send-amount-msg", () => t("amount.err." + amount.error), "bad");
      return;
    }
    const from = $("send-from").value;
    const index = wallet.indexOf(from);
    if (index === null) {
      msg("send-msg", () => t("send.err.no_from"), "bad");
      return;
    }
    if (ctx.state.genesis !== "ok") {
      msg("send-msg", () => t("send.err.chain"), "bad");
      return;
    }
    if (wallet.historyProblem) {
      const problem = wallet.historyProblem;
      msg("send-msg", () => t("history." + problem), "bad");
      return;
    }
    if (s.pending.full()) {
      msg("send-msg", () => t("send.err.too_many_open"), "bad");
      return;
    }
    $("send-review-btn").disabled = true;
    msg("send-msg", () => t("send.preparing"));
    try {
      if ((await probe()) === "off") return;
      const rpc = ctx.rpc();
      const chain = checkChainInfo(await rpc.call("getChainInfo"));
      const raw = await rpc.call("getSlotsByOwner", [from]);
      const rows = normalizeSlots(raw === null ? [] : raw, from);
      // Received outputs come without a height: locate their block, or they
      // are not spent (a provisional one must not be).
      const allocAt = async (h) => {
        const hd = await rpc.call("getBlockHeader", [h]);
        if (!hd || typeof hd.alloc_counter !== "bigint") throw new Error("no header at " + h);
        return hd.alloc_counter;
      };
      await locateReceived(rows, chain.height, { cache: ctx.state.mintCache, allocAt });
      const sp = spendable(rows, { tip: chain.height, pendingInputs: s.pending.reservedInputs() });
      const relay = checkFee(await rpc.call("estimateFee", [2]));
      const base = { utxos: sp.utxos, amount: amount.micro.toString(), fee: null, active_slot_count: chain.activeSlotCount.toString(), log_slots: chain.logSlots };
      let plan;
      try {
        plan = JSON.parse(await wallet.client.call("plan", { json: JSON.stringify({ ...base, relay_floor: relay.toString() }) }));
      } catch (e) {
        msg("send-msg", () => planError(e, sp), "bad");
        return;
      }
      const minimum = JSON.parse(await wallet.client.call("plan", { json: JSON.stringify({ ...base, relay_floor: "0" }) }));
      const fee = BigInt(plan.fee);
      const check = feeCheck(fee, BigInt(minimum.fee));
      if (!check.ok) {
        msg("send-msg", () => t(check.below ? "send.err.fee_below" : "send.err.fee_cap", { fee: formatJtm(fee) }), "bad");
        return;
      }
      s.plan = {
        rpcUrl: ctx.state.rpcUrl,
        network, from, index, to: to.address, amount: amount.micro, fee, change: BigInt(plan.change),
        total: BigInt(plan.total_spend), inputs: plan.input_count, utxos: sp.utxos,
        chain, ownSlots: rows.map((r) => r.slot), warn: check.warn, minimumFee: BigInt(minimum.fee),
        // Earlier payments to this recipient that may still be mined (SEC3-01).
        repeat: s.pending.earlierTo(to.address, amount.micro).length,
      };
      showReview();
    } catch (e) {
      msg("send-msg", () => ctx.describeError(e), "bad");
    } finally {
      $("send-review-btn").disabled = false;
    }
  }

  function planError(e, sp) {
    const m = e && e.message ? e.message : String(e);
    const have = /have (\d+)/.exec(m);
    const need = /need (\d+)/.exec(m);
    if (/insufficient/i.test(m)) return fundsMessage(t, need ? BigInt(need[1]) : null, sp);
    if (/more than \d+ active UTXOs/.test(m)) return t("send.err.too_many_inputs");
    if (/fee/.test(m)) return t("send.err.fee_plan");
    return t("wallet.err.generic", { message: m.slice(0, 200) });
  }

  function showReview() {
    const p = s.plan;
    setText($("rv-network"), () => t("net." + p.network));
    $("rv-from").textContent = "#" + p.index + " · " + p.from;
    const to = $("rv-to");
    to.replaceChildren(...groupAddress(p.to).map((g) => el("span", "", g)));
    $("rv-amount").textContent = jtm(p.amount);
    $("rv-fee").textContent = jtm(p.fee);
    $("rv-total").textContent = jtm(p.total);
    $("rv-change").textContent = jtm(p.change);
    $("rv-inputs").textContent = formatInt(p.inputs);
    const warns = [];
    const minimum = formatJtm(p.minimumFee, { trim: true });
    if (p.warn) warns.push(() => t("review.warn_fee", { minimum }));
    if (ctx.state.addresses.includes(p.to)) warns.push(() => t("review.warn_self"));
    if (ctx.state.customRpc) warns.push(() => t("review.warn_rpc"));
    $("rv-warn").hidden = warns.length === 0;
    setText($("rv-warn"), () => warns.map((w) => w()).join(" "));
    // Paying again a recipient whose earlier payment may still be mined can
    // pay twice: an explicit confirmation first (SEC3-01).
    const repeat = p.repeat;
    $("rv-repeat").hidden = !repeat;
    $("rv-repeat-ok").checked = false;
    setText($("rv-repeat-text"), repeat ? () => t("review.repeat", { n: repeat }) : "");
    $("review-go").disabled = p.repeat > 0;
    s.phase = "review";
    msg("send-msg", "");
    render();
    $(p.repeat ? "rv-repeat-ok" : "review-go").focus();
  }

  // ---------------------------------------------------------------- proving
  let progressTimer = null;
  function startProgress(status) {
    const expected = Number(ctx.store.get("proofMs", DEFAULT_PROOF_MS)) || DEFAULT_PROOF_MS;
    const t0 = Date.now();
    setText($("prove-status"), status);
    stopProgress();
    const tick = () => {
      const elapsed = Date.now() - t0;
      // Elapsed against the last proof's duration on this device: an
      // estimate, never reaching the end until the proof is done.
      const frac = Math.min(0.95, elapsed / Math.max(expected, 1000));
      $("prove-bar").value = Math.round(frac * 1000);
      setText($("prove-time"), () => t("prove.elapsed", { s: (elapsed / 1000).toFixed(0), e: Math.round(expected / 1000) }));
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

  /** text: a string, or a function of the language (setText, i18n.js). */
  function result(text, txid, cls) {
    stopProgress();
    const p = $("result-text");
    p.className = cls || "";
    setText(p, text);
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
      setText($("prove-status"), () => t("prove.wait_epoch", { n: w.blocksLeft, h: formatInt(w.resumeAt) }));
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

  /** What the RPC says about a txid: in its mempool?, block height (and id) or null, tip. */
  async function lookupTx(rpc, txid, knownTip = null) {
    const tip = knownTip !== null ? knownTip : checkBlockCount(await rpc.call("blockCount"));
    const entry = checkMempoolEntry(await rpc.call("getMempoolEntry", [txid]), txid);
    let height = null;
    let blockHash = null;
    if (!entry) {
      const info = checkTxInfo(await rpc.call("getTx", [txid]), txid, tip);
      height = info ? info.height : null;
      blockHash = info ? info.blockHash : null;
    }
    return { mempool: Boolean(entry), height, blockHash, tip };
  }

  /**
   * The public RPC's view of a txid (SEC3-01): { mempool, height, tip }, or
   * "unreachable" when it cannot be asked or its answer cannot be read. Only
   * the txid is sent: never an address, never anything secret.
   */
  async function referenceLookup(ref, txid, tip) {
    try {
      const entry = checkMempoolEntry(await ref.call("getMempoolEntry", [txid]), txid);
      let height = null;
      if (!entry) {
        const info = checkTxInfo(await ref.call("getTx", [txid]), txid, tip);
        height = info ? info.height : null;
      }
      return { mempool: Boolean(entry), height, tip };
    } catch (_) {
      return "unreachable";
    }
  }

  /** Are these slots all still listed live for `from`? null when unreadable. */
  async function stillLive(rpc, from, slots) {
    try {
      const raw = await rpc.call("getSlotsByOwner", [from]);
      const live = new Set(normalizeSlots(raw === null ? [] : raw, from).map((r) => r.slot));
      return slots.every((x) => live.has(x));
    } catch (_) {
      return null;
    }
  }

  /**
   * Store the list; a failure is shown, never swallowed (SEC2-03). The list
   * stays in this tab's memory, so its reservations hold for this session.
   */
  async function persist() {
    try {
      await wallet.savePending(s.pending.toJSON());
      msg("sent-msg", "");
      return true;
    } catch (_) {
      if (wallet.unlocked) msg("sent-msg", () => t("sent.not_saved"), "bad");
      return false;
    }
  }

  /** "Nothing was sent", unless an earlier proof of this payment is held. */
  function stopped(key, vars) {
    const held = s.heldEarlier;
    return () => (held ? t("result.stopped_held") : t(key, vars));
  }

  function setSubmitting(on) {
    s.submitting = on;
    $("prove-cancel").disabled = on;
    setText($("prove-cancel"), () => t(on ? "prove.no_cancel" : "prove.cancel"));
  }

  async function prove() {
    // Only from the review screen, and never twice at once: two clicks in the
    // same task would prove (and submit) the same inputs twice (SEC2-07).
    if (s.phase !== "review" || s.proving) return;
    const p = s.plan;
    if (!p || !wallet.unlocked) return;
    if (p.repeat && !$("rv-repeat-ok").checked) return;
    if (!reviewStillHolds(p, ctx.state)) return voidReview();
    s.proving = true;
    s.cancelled = false;
    s.heldEarlier = false;
    setPhase("proving");
    wallet.holdLock(true);
    const rpc = ctx.rpc();
    const avoid = new Set([...p.ownSlots, ...s.pending.reservedOutputs()]);
    let utxos = p.utxos; // after a refusal: only the first proof's inputs (SEC2-01)
    try {
      for (let attempt = 1; attempt <= PROOF_ATTEMPTS; attempt++) {
        if (!reviewStillHolds(p, ctx.state)) return result(stopped("result.rpc_changed"), "", "bad");
        setText($("prove-status"), () => t("prove.preparing"));
        const tip = await waitForWindow(rpc);
        const anchor = checkAnchor(await rpc.call("getEpochAnchor"));
        const { slots, drawn } = await slotsFor(rpc, p, avoid);
        const json = sendRequestJson({
          index: p.index, network: p.network, utxos, to: p.to, amount: p.amount, fee: p.fee,
          anchor, slotHints: slots, pendingOutputSlots: [...s.pending.reservedOutputs()],
        });
        startProgress(() => t(attempt === 1 ? "prove.running" : "prove.again", { n: attempt, max: PROOF_ATTEMPTS }) + (drawn ? " " + t("prove.drawn_slots") : ""));
        const t0 = performance.now();
        const out = await wallet.client.call("build", { json });
        const ms = performance.now() - t0;
        ctx.store.set("proofMs", Math.round(ms));
        ctx.state.lastProofMs = Math.round(ms);
        stopProgress();
        $("prove-bar").value = 1000;
        setText($("prove-time"), () => t("prove.done_in", { s: (ms / 1000).toFixed(1) }));
        if (s.cancelled) throw new Error("cancelled");

        // The chain may have moved to a new epoch during the proof.
        setText($("prove-status"), () => t("prove.checking"));
        const anchorNow = checkAnchor(await rpc.call("getEpochAnchor"));
        if (anchorNow !== anchor) {
          if (attempt < PROOF_ATTEMPTS) continue;
          return result(stopped("result.stale"), "", "bad");
        }
        // Settings may have switched the RPC during the proof (SEC-11).
        if (!reviewStillHolds(p, ctx.state)) return result(stopped("result.rpc_changed"), "", "bad");
        // Larger than the wallet RPC (and the node) accept: not submitted,
        // not recorded, sending stays open for smaller payments (A5-06).
        if (!intentFits(out.built.intent_hex)) return result(stopped("result.too_big"), "", "bad");
        // The txid is the one computed (and verified) here, never the RPC's.
        const txid = out.built.logical_txid;
        // Point of no return: from here the intent may reach the node. Cancel
        // no longer applies, and the send is recorded first, as an unknown
        // outcome with its inputs reserved, so that closing the tab or losing
        // the answer cannot make it look like nothing was sent (SEC-02).
        setSubmitting(true);
        setText($("prove-status"), () => t("prove.submitting"));
        // Recorded in storage or not sent at all (SEC2-03): a payment that
        // left without its record would free its inputs at the next unlock.
        let recorded = false;
        try {
          s.pending.add({
            txid, fromIndex: p.index, to: p.to, amount: p.amount, fee: p.fee,
            inputs: out.built.input_slots, outputs: out.built.output_slots,
            anchorHeight: epochPosition(tip).anchorHeight, submitTip: tip, submittedAt: Date.now(),
          });
          await wallet.savePending(s.pending.toJSON());
          recorded = true;
        } catch (_) {
          recorded = false;
        }
        if (!recorded) {
          s.pending.remove(txid);
          setSubmitting(false);
          return result(stopped("result.not_recorded"), "", "bad");
        }
        let outcome = "ok";
        try {
          checkTxid(await rpc.call("submitTxIntent", [out.built.intent_hex], { maxBodyBytes: MAX_SUBMIT_BODY }), txid);
        } catch (e) {
          const c = classifySubmitError(e);
          if (c.kind === "already") outcome = "ok";
          else if (c.kind === "unknown_outcome") outcome = "unknown";
          else if (e instanceof RpcError && e.kind === "too_large" && e.sent === false) {
            // Refused by this page before any byte left: certainly not sent.
            s.pending.remove(txid);
            await persist();
            setSubmitting(false);
            return refusedUnsent();
          } else {
            // An explicit refusal is the RPC's word, not a proof (SEC2-01): a
            // lying RPC can admit the payment and answer "refused". The entry
            // stays, inputs reserved, and the txid computed here is looked up.
            s.pending.refused(txid);
            await persist();
            setText($("prove-status"), () => t("prove.verifying"));
            let lookup = null;
            try {
              lookup = await lookupTx(rpc, txid);
            } catch (_) {
              lookup = null;
            }
            // Not found on this RPC: before concluding "absent", the txid is
            // looked up on the public RPC too (SEC3-01). If it sees the
            // payment, the payment is held; if it cannot be reached, nothing
            // is concluded (held, no new proof).
            const ref = ctx.referenceRpc();
            let reference = ref ? "skipped" : null;
            let seenByPublic = false;
            if (lookup && !lookup.mempool && lookup.height === null && ref) {
              reference = await referenceLookup(ref, txid, null);
              if (reference === "unreachable") lookup = null;
              else seenByPublic = reference.mempool || reference.height !== null;
            }
            if (lookup) s.pending.update(txid, { ...lookup, reference });
            let live = null;
            if (lookup && !seenByPublic && !lookup.mempool && lookup.height === null && attempt < PROOF_ATTEMPTS) {
              live = await stillLive(rpc, p.from, out.built.input_slots);
            }
            const next = seenByPublic ? "held" : afterRefusal({ kind: c.kind, lookup, inputsLive: live, attempt, max: PROOF_ATTEMPTS });
            await persist();
            if (next === "admitted") {
              outcome = "contradicted";
            } else if (next === "reprove") {
              // Same inputs only: the two proofs exclude each other on chain.
              setSubmitting(false);
              s.heldEarlier = true;
              utxos = reproofUtxos(p.utxos, out.built.input_slots);
              for (const sl of out.built.output_slots) avoid.add(sl);
              continue;
            } else {
              s.plan = null;
              s.unknownTxid = null;
              $("send-to").value = "";
              $("send-amount").value = "";
              setSubmitting(false);
              refusedHeld(c, e, txid, p, seenByPublic);
              ctx.onSent();
              track();
              return;
            }
          }
        }
        if (outcome === "ok") {
          s.pending.admitted(txid);
          await persist();
        }
        s.plan = null;
        $("send-to").value = "";
        $("send-amount").value = "";
        s.unknownTxid = outcome === "unknown" ? txid : null;
        const key = { ok: "result.sent", unknown: "result.unknown", contradicted: "result.sent_contradicted" }[outcome];
        const held = s.heldEarlier;
        const text = () => t(key, { amount: jtm(p.amount) }) + (held ? " " + t("result.earlier_held") : "");
        result(text, txid, outcome === "ok" ? "good" : "warn");
        ctx.onSent();
        track();
        return;
      }
      result(stopped("result.gave_up"), "", "bad");
    } catch (e) {
      stopProgress();
      if (s.cancelled || (e && e.cancelled)) return; // cancel() already rendered
      const held = s.heldEarlier;
      result(() => (held ? t("result.stopped_held") : ctx.describeError(e)), "", "bad");
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
    msg("send-msg", () => t("send.err.rpc_changed"), "warn");
  }

  /**
   * The request was too large to leave this page: nothing was sent. Sending
   * stays open on this RPC (A5-06): a smaller payment can still go.
   */
  function refusedUnsent() {
    return result(stopped("result.too_big"), "", "bad");
  }

  /**
   * The RPC said "refused" and the payment cannot be found, which a lying RPC
   * can also arrange (SEC2-01): say what the RPC says, not "nothing was
   * sent"; the payment stays listed and its inputs reserved until it expires.
   */
  function refusedHeld(c, e, txid, p, seenByPublic) {
    if (c.kind === "not_enabled") {
      s.capability = "off";
      const url = ctx.state.rpcUrl;
      setText($("send-off-body"), () => t("send.off_body", { url }));
    }
    const reasons = {
      not_enabled: () => t("refusal.not_enabled"),
      fee_too_low: () => t("refusal.fee_low", { fee: formatJtm(c.required) }),
      inputs_changed: () => t("refusal.inputs_changed"),
      stale_anchor: () => t("refusal.stale"),
      slot_conflict: () => t("refusal.slots"),
    };
    // The node's (or the RPC's) own words are not shown (SEC-08).
    const reason = () => (reasons[c.kind] ? reasons[c.kind]() : describeRpcError(e, t) || t("error.parse"));
    result(() => t(seenByPublic ? "result.refused_public_sees" : "result.refused_held", { amount: jtm(p.amount), reason: reason() }), txid, "bad");
  }

  function cancel() {
    // Once the intent may have reached the node, there is nothing to cancel.
    if (s.phase !== "proving" || s.submitting) return;
    s.cancelled = true;
    stopProgress();
    // A running proof cannot be interrupted: end the worker, and the secret
    // with it. The wallet locks; nothing was sent by this proof (an earlier,
    // refused one may be held: SEC2-01).
    const held = s.heldEarlier;
    wallet.lock(held ? "cancel_held" : "cancel");
    result(() => t(held ? "result.cancelled_held" : "result.cancelled"), "", "warn");
  }

  // ---------------------------------------------------------------- tracking
  /** Does the RPC serve a block at this height? (a claimed tip must have one) */
  async function hasBlock(rpc, height) {
    const h = await rpc.call("getBlockHash", [height]);
    return typeof h === "string" && /^[0-9a-fA-F]{64}$/.test(h) && !/^0+$/.test(h);
  }

  /**
   * Before "final" (SEC3-02): the block the RPC names for the transaction is
   * the one it serves at that height, and it serves the block FINALITY_DEPTH
   * above (a claimed tip must have one).
   */
  async function finalBlockOk(rpc, seen) {
    if (!seen.blockHash) return false;
    const h = await rpc.call("getBlockHash", [seen.height]);
    if (typeof h !== "string" || h.toLowerCase() !== seen.blockHash) return false;
    return hasBlock(rpc, seen.height + FINALITY_DEPTH);
  }

  async function trackOnce() {
    // Open sends, and dropped ones still looked up in case they are mined
    // after all (SEC2-02).
    if (!s.pending.tracked().length || !wallet.unlocked) return false;
    const rpc = ctx.rpc();
    const tip = checkBlockCount(await rpc.call("blockCount"));
    ctx.state.tip = tip;
    // Held payments every round, finished ones still watched one round in
    // WATCH_EVERY, at most MAX_PER_ROUND, decided at this tip (SEC3-06).
    const open = s.pending.dueIn(s.round++, tip);
    // The public RPC, when the configured one is another (SEC3-01): its tip
    // is read once per round, and only if a payment needs it.
    const ref = ctx.referenceRpc();
    let refTip = null;
    const askReference = async (txid) => {
      if (refTip === null) {
        try {
          refTip = checkBlockCount(await ref.call("blockCount"));
        } catch (_) {
          refTip = "unreachable";
        }
      }
      return refTip === "unreachable" ? refTip : referenceLookup(ref, txid, refTip);
    };
    let confirmedNow = false;
    for (const e of open) {
      // One malformed or missing answer about one payment must not stop the
      // others from advancing (SEC3-03): it changes nothing for this one, and
      // the next round asks again.
      try {
        const seen = await lookupTx(rpc, e.txid, tip);
        if (seen.height !== null && e.height === null) confirmedNow = true;
        // A reported expiry must at least come with the block at that height.
        const expiryAt = e.anchorHeight + EXPIRY_BLOCKS;
        const notSeen = !seen.mempool && seen.height === null;
        const expiryBlock = e.status !== "dropped" && notSeen && tip >= expiryAt ? await hasBlock(rpc, expiryAt) : false;
        const finalBlock = seen.height !== null && e.status !== "final" && !isProvisional(seen.height, tip) ? await finalBlockOk(rpc, seen) : false;
        // Asked only when this RPC's word could release the inputs (a
        // consistent expiry), while the public RPC still sees the payment, or
        // before "final" (SEC3-01, SEC3-02).
        let reference = ref ? "skipped" : null;
        const releasable = notSeen && e.status !== "dropped" && e.status !== "superseded" && ((tip >= expiryAt && expiryBlock) || e.crossCheck !== null);
        if (ref && (releasable || finalBlock)) reference = await askReference(e.txid);
        s.pending.update(e.txid, { ...seen, now: Date.now(), expiryBlock, finalBlock, reference });
      } catch (_) {
        /* this entry is unchanged this round */
      }
    }
    await persist();
    resolveUnknown();
    if (confirmedNow) ctx.refreshAll();
    ctx.render();
    return s.pending.tracked().length > 0;
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
    const key = dropped ? (e.checked === "public" ? "result.unknown_dropped_checked" : "result.unknown_dropped") : "result.unknown_accepted";
    const amount = jtm(e.amount);
    setText(p, () => t(key, { amount }));
  }

  async function track() {
    if (s.tracking) return;
    s.tracking = true;
    // The pause between rounds is at least as long as the round itself (the
    // RPC client spaces requests by 250 ms: at most 2 per second on average),
    // and doubles after a failed round, up to TRACK_MAX_MS (SEC3-06).
    let pause = TRACK_MS;
    try {
      for (;;) {
        if (document.visibilityState === "visible") {
          let more = true;
          const t0 = performance.now();
          try {
            more = await trackOnce();
            pause = Math.max(TRACK_MS, Math.round(performance.now() - t0));
          } catch (_) {
            more = true; // RPC hiccup: try again, later each time
            pause = Math.min(pause * 2, TRACK_MAX_MS);
          }
          if (!more) break;
        }
        await sleep(pause);
        if (!wallet.unlocked) break;
      }
    } finally {
      s.tracking = false;
    }
  }

  async function retryHistory() {
    msg("history-msg", "");
    try {
      const list = await wallet.retryHistory();
      s.pending = createPendingBook(list);
      ctx.render();
      if (s.pending.tracked().length) track();
    } catch (_) {
      msg("history-msg", () => t("history.still_unreadable"), "bad");
    }
  }

  // ---------------------------------------------------------------- lifecycle
  function onUnlocked(record) {
    s.pending = createPendingBook(record.pending);
    s.phase = "form";
    s.plan = null;
    s.capability = null;
    if (s.pending.tracked().length) track();
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
    $("rv-repeat-ok").addEventListener("change", () => {
      $("review-go").disabled = Boolean(s.plan && s.plan.repeat) && !$("rv-repeat-ok").checked;
    });
    $("history-retry").addEventListener("click", retryHistory);
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
