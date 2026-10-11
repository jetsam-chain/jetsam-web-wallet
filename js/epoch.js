// Transaction epochs (jetsam_chain consensus/epoch_anchor.rs).
//
// A user transaction carries the epoch anchor of the block that will include
// it: the id of block floor((child - 1) / 32) * 32. With child = tip + 1 the
// anchor changes when the tip reaches the next multiple of 32. Proving takes
// tens of seconds in a browser, so the wallet does not start a proof when
// fewer than EPOCH_MARGIN blocks are left, and re-reads the anchor before
// submitting.

export const TX_EPOCH_BLOCKS = 32;
export const EPOCH_MARGIN = 3;

export function epochPosition(tip) {
  if (!Number.isSafeInteger(tip) || tip < 0) throw new Error("bad tip height");
  const anchorHeight = Math.floor(tip / TX_EPOCH_BLOCKS) * TX_EPOCH_BLOCKS;
  return { anchorHeight, blocksLeft: anchorHeight + TX_EPOCH_BLOCKS - tip };
}

/** { ok, blocksLeft[, resumeAt] }: resumeAt is the tip from which to try again. */
export function proofWindow(tip, margin = EPOCH_MARGIN) {
  const { anchorHeight, blocksLeft } = epochPosition(tip);
  if (blocksLeft > margin) return { ok: true, blocksLeft };
  return { ok: false, blocksLeft, resumeAt: anchorHeight + TX_EPOCH_BLOCKS };
}
