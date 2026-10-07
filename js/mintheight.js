// Height at which a received (non-coinbase) output was created.
//
// A received output is identified by the chain-wide allocation counter
// (+1 per output created, jetsam_chain/src/state_delta.rs), and every block
// header records that counter as it stands after the block
// (BlockHeaderInfo.alloc_counter). So the block that created id N is the lowest
// height whose counter has reached N. Headers are permanent, so this works long
// after the block body itself is gone.
//
// Each header read costs a request to a shared public endpoint, so the search
// is frugal:
// - the counter grows almost linearly with height, so the first probe is an
//   interpolation, followed by a short gallop to bracket the answer from the
//   other side;
// - when a step fails to halve the bracket, the next step is a plain bisection,
//   which bounds the worst case;
// - every header read is remembered and narrows the bracket of every other id.

/**
 * @param {bigint[]} ids
 * @param {number} tip
 * @param {(height: number) => Promise<bigint>} allocAt  counter after `height`
 * @param {{ onResolved?: (id: bigint, height: number|null) => void }} [opts]
 * @returns {Promise<Map<bigint, number|null>>}
 */
export async function resolveMintHeights(ids, tip, allocAt, opts = {}) {
  const onResolved = opts.onResolved || (() => {});
  const result = new Map();
  const unique = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (unique.length === 0) return result;

  const known = new Map(); // height -> counter (successful reads only)
  const failed = new Set();
  async function read(h) {
    if (known.has(h)) return known.get(h);
    if (failed.has(h)) throw new Error("header " + h + " unavailable");
    try {
      const a = await allocAt(h);
      known.set(h, a);
      return a;
    } catch (e) {
      failed.add(h);
      throw e;
    }
  }
  const settle = (id, h) => {
    result.set(id, h);
    onResolved(id, h);
  };

  let top;
  try {
    top = await read(tip);
  } catch (_) {
    for (const id of unique) settle(id, null);
    return result;
  }

  for (const id of unique) {
    if (id > top) {
      settle(id, null);
      continue;
    }
    // Tightest bracket from what is already known: A(lo) < id <= A(hi).
    // Height -1 stands for "before the chain", with a counter below any id.
    let lo = -1;
    let aLo = -1n;
    let hi = tip;
    let aHi = top;
    for (const [h, a] of known) {
      if (a < id && h > lo) {
        lo = h;
        aLo = a;
      } else if (a >= id && h < hi) {
        hi = h;
        aHi = a;
      }
    }

    let bisect = false;
    let ok = true;
    const probe = async (g) => {
      const a = await read(g);
      if (a >= id) {
        hi = g;
        aHi = a;
      } else {
        lo = g;
        aLo = a;
      }
      return a;
    };
    try {
      while (hi - lo > 1) {
        const width = hi - lo;
        if (bisect) {
          await probe(lo + Math.floor(width / 2));
        } else {
          const span = aHi - aLo;
          let g = lo + Number(((id - aLo) * BigInt(width) + span - 1n) / span);
          g = Math.min(hi - 1, Math.max(lo + 1, g));
          const a = await probe(g);
          // Gallop: step past the answer by about the expected error, so the
          // bracket closes from both sides instead of creeping.
          if (hi - lo > 1) {
            const rate = Number(span) / width || 1;
            const miss = Number(a >= id ? a - id : id - a);
            const step = Math.ceil(miss / rate) + 1;
            const g2 = a >= id ? Math.max(lo + 1, g - step) : Math.min(hi - 1, g + step);
            if (g2 > lo && g2 < hi) await probe(g2);
          }
        }
        bisect = hi - lo > width / 2;
      }
    } catch (_) {
      ok = false; // one unreachable header must not sink the other ids
    }
    settle(id, ok ? hi : null);
  }
  return result;
}
