// The backup gate of a newly created wallet.
//
// Order, enforced: password chosen -> encrypted file saved -> secret shown
// (once) -> user says it is written down -> parts of it typed back. Only then
// may the page show an address to receive funds. Nothing here touches the
// secret: the key worker draws the groups to ask, checks the typed ones and
// counts the attempts (the module enforces the same limit). This flow only
// mirrors what the worker answered.

export const GROUPS = 16; // 64 hex digits shown as 16 groups of 4
export const CHALLENGES = 3; // groups asked back
export const MAX_ATTEMPTS = 3;

const ORDER = ["password", "file", "reveal", "written", "quiz", "done"];

function checkGroups(groups) {
  const ok = Array.isArray(groups) && groups.length === CHALLENGES &&
    groups.every((g) => Number.isInteger(g) && g >= 0 && g < GROUPS) &&
    new Set(groups).size === CHALLENGES;
  if (!ok) throw new Error("bad groups from the key worker");
  return groups.slice();
}

export function createBackupFlow() {
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
    /** `groups`: the 3 group numbers the key worker drew. */
    secretWritten(groups) {
      const g = checkGroups(groups);
      step("written", "quiz");
      challenges = g;
    },
    /** The worker's verdict on one attempt: { ok, attemptsLeft }. */
    answer({ ok, attemptsLeft: left }) {
      if (state !== "quiz") throw new Error("backup steps out of order: " + state + " -> answer");
      if (ok === true) { state = "done"; return; }
      // Never more attempts than the page counted itself.
      const n = Number.isInteger(left) ? left : 0;
      attemptsLeft = Math.max(0, Math.min(attemptsLeft - 1, n));
      if (attemptsLeft <= 0) state = "failed";
    },
  };
}

export const BACKUP_STEPS = ORDER;
