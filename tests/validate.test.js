// Every RPC answer is hostile until checked: types, ranges, sizes. Values come
// from bigjson, so integers arrive as BigInt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJson } from "../js/bigjson.js";
import {
  checkChainInfo, checkAnchor, checkFee, checkSlotHints, checkTxid,
  checkMempoolEntry, checkTxInfo, checkBlockCount,
} from "../js/validate.js";

const j = (s) => parseJson(s);
const TXID = "ab".repeat(32);

test("getChainInfo: height, occupancy, log_slots", () => {
  const ok = checkChainInfo(j('{"height":32319,"best_hash":"' + "cd".repeat(32) + '","difficulty_target":"x","active_slot_count":24245,"log_slots":24,"circulating_supply_micro_jtm":"1"}'));
  assert.deepEqual(ok, { height: 32319, activeSlotCount: 24245n, logSlots: 24 });
  assert.throws(() => checkChainInfo(j('{"height":-1,"active_slot_count":1,"log_slots":24}')));
  assert.throws(() => checkChainInfo(j('{"height":1.5,"active_slot_count":1,"log_slots":24}')));
  assert.throws(() => checkChainInfo(j('{"height":"1","active_slot_count":1,"log_slots":24}')));
  assert.throws(() => checkChainInfo(j('{"height":1,"active_slot_count":1,"log_slots":33}')), "log_slots beyond u32 slot space");
  assert.throws(() => checkChainInfo(j('{"height":1,"active_slot_count":99999999999,"log_slots":24}')), "more active than slots");
  assert.throws(() => checkChainInfo(null));
});

test("blockCount", () => {
  assert.equal(checkBlockCount(j("12")), 12);
  assert.throws(() => checkBlockCount(j('"12"')));
  assert.throws(() => checkBlockCount(j("9007199254740993")));
});

test("anchor: exactly 64 lowercase hex, not all zero", () => {
  assert.equal(checkAnchor("11".repeat(32)), "11".repeat(32));
  assert.equal(checkAnchor("AB".repeat(32)), "ab".repeat(32));
  assert.throws(() => checkAnchor("00".repeat(32)));
  assert.throws(() => checkAnchor("11".repeat(31)));
  assert.throws(() => checkAnchor("zz".repeat(32)));
  assert.throws(() => checkAnchor(5n));
});

test("fee: a BigInt in micro-JTM within sane bounds", () => {
  assert.equal(checkFee(j("9000")), 9000n);
  assert.throws(() => checkFee(j("0")));
  assert.throws(() => checkFee(j("-5")));
  assert.throws(() => checkFee(j("9.5")));
  assert.throws(() => checkFee(j('"9000"')));
  assert.throws(() => checkFee(j("18446744073709551616")));
});

test("slot hints: distinct, in range, no more than asked", () => {
  assert.deepEqual(checkSlotHints(j("[5,9]"), 2, 24), [5, 9]);
  assert.throws(() => checkSlotHints(j("[5,5]"), 2, 24));
  assert.throws(() => checkSlotHints(j("[5,16777216]"), 2, 24));
  assert.throws(() => checkSlotHints(j("[1,2,3]"), 2, 24));
  assert.throws(() => checkSlotHints(j('["1"]'), 2, 24));
  assert.throws(() => checkSlotHints(j("{}"), 2, 24));
});

test("submit result must be the txid we computed", () => {
  assert.equal(checkTxid(TXID, TXID), TXID);
  assert.equal(checkTxid(TXID.toUpperCase(), TXID), TXID);
  assert.throws(() => checkTxid("cd".repeat(32), TXID), /different/);
  assert.throws(() => checkTxid(7n, TXID));
});

test("mempool entry: null or the same txid", () => {
  assert.equal(checkMempoolEntry(null, TXID), null);
  const e = checkMempoolEntry(j('{"tx_hash":"' + TXID + '","fee_micro_jtm":9000,"admitted_height":5,"requires_b255_miner":false}'), TXID);
  assert.deepEqual(e, { fee: 9000n, admittedHeight: 5, requiresB255: false });
  assert.throws(() => checkMempoolEntry(j('{"tx_hash":"' + "cd".repeat(32) + '"}'), TXID));
});

test("getTx: null or the same txid with a sane height", () => {
  assert.equal(checkTxInfo(null, TXID, 100), null);
  assert.deepEqual(checkTxInfo(j('{"tx_hash":"' + TXID + '","height":99,"block_hash":"' + "ee".repeat(32) + '","tx_position":1}'), TXID, 100), { height: 99, blockHash: "ee".repeat(32) });
  // SEC3-02: the block id is read to check it against getBlockHash; absent or malformed: null.
  assert.deepEqual(checkTxInfo(j('{"tx_hash":"' + TXID + '","height":99,"block_hash":""}'), TXID, 100), { height: 99, blockHash: null });
  assert.deepEqual(checkTxInfo(j('{"tx_hash":"' + TXID + '","height":99}'), TXID, 100), { height: 99, blockHash: null });
  assert.throws(() => checkTxInfo(j('{"tx_hash":"' + TXID + '","height":500}'), TXID, 100), /future/);
  assert.throws(() => checkTxInfo(j('{"tx_hash":"' + "cd".repeat(32) + '","height":5}'), TXID, 100));
});
