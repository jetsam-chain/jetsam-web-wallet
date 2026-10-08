// Epoch anchors: a transaction is bound to the anchor of the next block's
// epoch (TX_EPOCH_BLOCKS = 32). Proving takes tens of seconds, so the wallet
// refuses to start a proof when the anchor is about to change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { epochPosition, proofWindow, TX_EPOCH_BLOCKS, EPOCH_MARGIN } from "../js/epoch.js";

test("anchor height for the next block mirrors tx_epoch_anchor_height_for_child", () => {
  assert.equal(TX_EPOCH_BLOCKS, 32);
  // child = tip + 1; anchor = floor((child - 1) / 32) * 32 = floor(tip / 32) * 32
  assert.deepEqual(epochPosition(0), { anchorHeight: 0, blocksLeft: 32 });
  assert.deepEqual(epochPosition(31), { anchorHeight: 0, blocksLeft: 1 });
  assert.deepEqual(epochPosition(32), { anchorHeight: 32, blocksLeft: 32 });
  assert.deepEqual(epochPosition(32319), { anchorHeight: 32288, blocksLeft: 1 });
  assert.deepEqual(epochPosition(32300), { anchorHeight: 32288, blocksLeft: 20 });
});

test("proofs wait when fewer than EPOCH_MARGIN blocks are left", () => {
  assert.equal(EPOCH_MARGIN, 3);
  assert.deepEqual(proofWindow(32300), { ok: true, blocksLeft: 20 });
  assert.deepEqual(proofWindow(32 * 10 - 4), { ok: true, blocksLeft: 4 });
  assert.deepEqual(proofWindow(32 * 10 - 3), { ok: false, blocksLeft: 3, resumeAt: 320 });
  assert.deepEqual(proofWindow(32 * 10 - 1), { ok: false, blocksLeft: 1, resumeAt: 320 });
  assert.deepEqual(proofWindow(320), { ok: true, blocksLeft: 32 });
});

test("bad tips are refused", () => {
  assert.throws(() => epochPosition(-1));
  assert.throws(() => epochPosition(1.5));
  assert.throws(() => epochPosition(Number.MAX_SAFE_INTEGER + 1));
});
