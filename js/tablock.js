// One unlocked tab per wallet (audit SEC-04).
//
// Two tabs unlocked on the same wallet each keep their own copy of the
// pending payments and would overwrite each other's record. So a wallet can
// be unlocked in one tab only: the lock is taken before unlocking and
// released on Lock, on the idle lock, and when the tab closes.
//
// Web Locks (navigator.locks) when the browser has them: the browser releases
// the lock itself when the tab goes away. Otherwise a lease in localStorage,
// renewed while held, that a crashed tab lets expire. With neither, there is
// no other tab this page could coordinate with (no storage means no stored
// wallet either), and the lock is granted.
//
// The lease is the weak part (SEC2-06): a background tab's timers can be
// throttled or frozen, and a lease not renewed expires. It lasts 60 s,
// renewed every 15 s (Chromium's one-run-per-minute throttling of hidden
// tabs leaves it valid), and a handle tells whether it is still this tab's
// (held()): the wallet checks before every write and locks instead of
// writing when it is not. Between a takeover and that check, the old tab may
// still show the wallet; only one of them can write. Check-then-write is not
// atomic across tabs (localStorage and IndexedDB are separate): that window
// is milliseconds, and is the residual without Web Locks.

const LOCK_PREFIX = "jww.v1.tablock.";
export const LEASE_MS = 60_000;
export const RENEW_MS = 15_000;

export function createTabLock({
  locks = null,
  storage = null,
  id = null,
  now = () => Date.now(),
  settle = () => new Promise((r) => setTimeout(r, 60)),
  setTimer = (f, ms) => setInterval(f, ms),
  clearTimer = (h) => clearInterval(h),
} = {}) {
  const me = id || Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

  async function viaLocks(name) {
    let free;
    const held = new Promise((r) => { free = r; });
    const got = await new Promise((resolve, reject) => {
      Promise.resolve(
        locks.request(LOCK_PREFIX + name, { ifAvailable: true }, (lock) => {
          resolve(Boolean(lock));
          return lock ? held : undefined;
        }),
      ).catch(reject);
    });
    if (!got) return null;
    let mine = true;
    return {
      release() {
        mine = false;
        free();
      },
      held: () => mine,
    };
  }

  function read(key) {
    try {
      const v = JSON.parse(storage.getItem(key));
      return v && typeof v.owner === "string" && Number.isFinite(v.until) ? v : null;
    } catch (_) {
      return null;
    }
  }

  async function viaStorage(name) {
    const key = LOCK_PREFIX + name;
    const cur = read(key);
    if (cur && cur.owner !== me && cur.until > now()) return null;
    const write = () => storage.setItem(key, JSON.stringify({ owner: me, until: now() + LEASE_MS }));
    write();
    // Two tabs may write at the same moment: whoever reads back its own id
    // after a short pause keeps the lease.
    await settle();
    const after = read(key);
    if (!after || after.owner !== me) return null;
    let released = false;
    // Still ours? Another tab may have taken it after it expired (a frozen
    // timer); an expired lease nobody took is still ours, and renewed.
    const ours = () => {
      if (released) return false;
      const v = read(key);
      if (!v || v.owner !== me) return false;
      if (v.until <= now()) write();
      return true;
    };
    let timer = setTimer(() => {
      if (ours()) write();
    }, RENEW_MS);
    return {
      release() {
        released = true;
        if (timer !== null) clearTimer(timer);
        timer = null;
        const v = read(key);
        if (v && v.owner === me) storage.removeItem(key);
      },
      held: () => {
        try {
          return ours();
        } catch (_) {
          return false;
        }
      },
    };
  }

  return {
    /** A handle with release(), or null when another tab holds this wallet. */
    async acquire(name) {
      if (locks && typeof locks.request === "function") return viaLocks(name);
      if (storage) {
        try {
          return await viaStorage(name);
        } catch (_) {
          /* storage refused: fall through */
        }
      }
      let mine = true;
      return { release() { mine = false; }, held: () => mine };
    },
  };
}
