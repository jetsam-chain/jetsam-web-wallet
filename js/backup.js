// The backup gate of a newly created wallet.
//
// Order, enforced: password chosen -> encrypted file saved -> secret shown
// (once) -> user says it is written down -> parts of it typed back. Only then
// may the page show an address to receive funds. Nothing here touches the
// secret: the key worker checks the typed parts (checkHexFragment).

export const GROUPS = 16; // 64 hex digits shown as 16 groups of 4
export const CHALLENGES = 3; // groups asked back
export const MAX_ATTEMPTS = 3;

const ORDER = ["password", "file", "reveal", "written", "quiz", "done"];

/**
 * CHALLENGES distinct group numbers in [0, GROUPS), sorted, drawn with
 * rejection sampling from `random` (crypto.getRandomValues in the page).
 */
export function pickChallenges(random) {
  const picked = new Set();
  // A multiple of GROUPS below 256: values at or above it are discarded, so
  // `% GROUPS` has no bias whatever GROUPS is.
  const limit = Math.floor(240 / GROUPS) * GROUPS;
  for (let rounds = 0; rounds < 64 && picked.size < CHALLENGES; rounds++) {
    const buf = random(new Uint8Array(CHALLENGES * 2));
    for (const b of buf) {
      if (picked.size === CHALLENGES) break;
      if (b >= limit) continue;
      picked.add(b % GROUPS);
    }
  }
  if (picked.size < CHALLENGES) throw new Error("random source gave no usable value");
  return [...picked].sort((a, b) => a - b);
}

export function createBackupFlow({ random }) {
  let state = "password";
  let challenges = null;
  let attemptsLeft = MAX_ATTEMPTS;
  const step = (from, to) => {
    if (state !== from) throw new Error("backup steps out of order: " + state + " -> " + to);
    state = to;
  };
  return {
    get state() { return state; },
    get challenges() { return challenges ? challenges.slice() : null; },
    get attemptsLeft() { return attemptsLeft; },
    get addressVisible() { return state === "done"; },
    passwordSet() { step("password", "file"); },
    fileSaved() { step("file", "reveal"); },
    secretShown() { step("reveal", "written"); },
    secretWritten() {
      step("written", "quiz");
      challenges = pickChallenges(random);
    },
    /** `correct`: every challenged group matched (checked by the worker). */
    answer(correct) {
      if (state !== "quiz") throw new Error("backup steps out of order: " + state + " -> answer");
      if (correct) { state = "done"; return; }
      attemptsLeft--;
      if (attemptsLeft <= 0) state = "failed";
    },
  };
}

export const BACKUP_STEPS = ORDER;
