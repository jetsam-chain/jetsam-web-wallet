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

const LOCK_PREFIX = "jww.v1.tablock.";
const LEASE_MS = 10_000;
const RENEW_MS = 3_000;

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
    return got ? { release: () => free() } : null;
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
    let timer = setTimer(() => {
      const v = read(key);
      if (v && v.owner === me) write();
    }, RENEW_MS);
    return {
      release() {
        if (timer !== null) clearTimer(timer);
        timer = null;
        const v = read(key);
        if (v && v.owner === me) storage.removeItem(key);
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
      return { release() {} };
    },
  };
}
