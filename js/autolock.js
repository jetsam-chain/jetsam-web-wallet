// Lock the wallet after a stretch without user activity. A proof in progress
// holds the lock off (the user is waiting on it, not away).

export const LOCK_CHOICES = [1, 5, 15, 30];
const DEFAULT_MINUTES = 5;

export function createAutoLock({ minutes, now = () => Date.now(), onLock }) {
  let span = (LOCK_CHOICES.includes(minutes) ? minutes : DEFAULT_MINUTES) * 60_000;
  let last = now();
  let held = false;
  let fired = false;
  return {
    get minutes() { return span / 60_000; },
    setMinutes(m) {
      span = (LOCK_CHOICES.includes(m) ? m : DEFAULT_MINUTES) * 60_000;
      last = now();
    },
    touch() { last = now(); },
    hold(on) {
      held = Boolean(on);
      last = now();
    },
    /** Re-arm after an unlock. */
    reset() {
      fired = false;
      held = false;
      last = now();
    },
    tick() {
      if (fired || held) return;
      if (now() - last >= span) {
        fired = true;
        onLock();
      }
    },
  };
}
