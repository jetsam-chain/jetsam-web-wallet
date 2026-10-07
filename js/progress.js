// Progress of the block lookup for received outputs: "Locating blocks 12/34".
// Outputs whose block is already known (remembered from an earlier visit)
// count as done from the start; every id asked for counts once, found or not.

/**
 * @param {number} known  received outputs whose block is already known
 * @param {bigint[]} ids  creation ids still to be located
 */
export function startProgress(known, ids) {
  const pending = new Set(ids);
  const lookups = pending.size;
  let done = known;
  return {
    total: known + lookups,
    lookups,
    get done() {
      return done;
    },
    get finished() {
      return pending.size === 0;
    },
    /** Mark one id as handled (its block found, or given up on). */
    resolve(id) {
      if (pending.delete(id)) done++;
    },
  };
}
