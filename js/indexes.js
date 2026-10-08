// The wallet's own list of address indexes.
//
// The node's address discovery stops at the first address without a live
// output, and asking an RPC about many addresses at once tells it they belong
// together. So the wallet remembers which indexes it uses, adds one at a time,
// and scans only a few more on request.

export const MAX_INDEX = 99_999; // jetsam_node MAX_WALLET_ADDRESSES - 1
export const SCAN_MAX = 5;

const isIndex = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_INDEX;

/** kind: "seed" (derived addresses) or "spend" (one imported address, index 0). */
export function createIndexList({ kind, saved } = {}) {
  const single = kind === "spend";
  let indexes = [0];
  let active = 0;
  if (!single && saved && typeof saved === "object" && Array.isArray(saved.indexes)) {
    const clean = [...new Set(saved.indexes.filter(isIndex))].sort((a, b) => a - b);
    if (clean.length) indexes = clean;
    active = indexes.includes(saved.active) ? saved.active : indexes[0];
  }
  const highest = () => indexes[indexes.length - 1];
  return {
    get indexes() { return indexes.slice(); },
    get active() { return active; },
    get single() { return single; },
    /** Add the index after the highest and make it active; null at the end. */
    next() {
      if (single || highest() >= MAX_INDEX) return null;
      const n = highest() + 1;
      indexes.push(n);
      active = n;
      return n;
    },
    /** Up to `count` (<= SCAN_MAX) indexes past the highest, not added. */
    scanCandidates(count) {
      if (single) return [];
      const out = [];
      for (let k = highest() + 1; k <= MAX_INDEX && out.length < Math.min(count, SCAN_MAX); k++) out.push(k);
      return out;
    },
    addFound(found) {
      if (single) return;
      for (const i of found) if (isIndex(i) && !indexes.includes(i)) indexes.push(i);
      indexes.sort((a, b) => a - b);
    },
    setActive(i) {
      if (!indexes.includes(i)) return false;
      active = i;
      return true;
    },
    /** Hide an index from the list (its funds are untouched). Keeps one. */
    hide(i) {
      if (indexes.length <= 1 || !indexes.includes(i)) return;
      indexes = indexes.filter((x) => x !== i);
      if (active === i) active = indexes[0];
    },
    toJSON() { return { indexes: indexes.slice(), active }; },
  };
}
