// One unlocked tab per wallet (SEC-04): two tabs writing the same record
// would overwrite each other's pending payments. Web Locks when the browser
// has them, a lease in localStorage otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTabLock } from "../js/tablock.js";

/** navigator.locks with ifAvailable, as browsers implement it. */
function fakeLocks() {
  const held = new Set();
  return {
    held,
    request(name, opts, cb) {
      if (!opts || opts.ifAvailable !== true) throw new Error("test expects ifAvailable");
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      return Promise.resolve(cb({ name })).finally(() => held.delete(name));
    },
  };
}

function fakeStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("web locks: a second tab is refused while the first holds the wallet; free again after release", async () => {
  const locks = fakeLocks();
  const a = createTabLock({ locks });
  const b = createTabLock({ locks });
  const ha = await a.acquire("mainnet");
  assert.ok(ha, "first tab gets it");
  assert.equal(await b.acquire("mainnet"), null, "second tab refused");
  assert.ok(await b.acquire("testnet"), "another network's wallet is another lock");
  ha.release();
  await tick();
  const hb = await b.acquire("mainnet");
  assert.ok(hb, "free after the first tab locked");
  hb.release();
  ha.release(); // idempotent
});

test("storage lease: refused while a live lease exists, taken over once it expired", async () => {
  const storage = fakeStorage();
  let now = 1_000_000;
  const opts = { storage, now: () => now, settle: () => Promise.resolve(), setTimer: () => 1, clearTimer: () => {} };
  const a = createTabLock({ ...opts, id: "tab-a" });
  const b = createTabLock({ ...opts, id: "tab-b" });
  const ha = await a.acquire("mainnet");
  assert.ok(ha);
  assert.equal(await b.acquire("mainnet"), null);
  now += 61_000; // tab A died without releasing (crash): its lease runs out
  const hb = await b.acquire("mainnet");
  assert.ok(hb);
  ha.release(); // a stale holder must not remove the new owner's lease
  assert.equal(await createTabLock({ ...opts, id: "tab-c" }).acquire("mainnet"), null);
  hb.release();
  assert.ok(await createTabLock({ ...opts, id: "tab-c" }).acquire("mainnet"));
});

test("storage lease: renewed while held, and a write race is lost cleanly", async () => {
  const storage = fakeStorage();
  let now = 0;
  let renew = null;
  const a = createTabLock({ storage, id: "a", now: () => now, settle: () => Promise.resolve(), setTimer: (f) => { renew = f; return 1; }, clearTimer: () => { renew = null; } });
  const ha = await a.acquire("mainnet");
  now += 9_000;
  renew();
  now += 9_000; // 18 s after the start, but renewed at 9 s
  const b = createTabLock({ storage, id: "b", now: () => now, settle: () => Promise.resolve(), setTimer: () => 1, clearTimer: () => {} });
  assert.equal(await b.acquire("mainnet"), null);
  ha.release();
  assert.equal(renew, null, "renewal stops on release");
  // Race: c writes, then d overwrites before c re-reads -> c backs off.
  const raced = createTabLock({
    storage, id: "c", now: () => now, setTimer: () => 1, clearTimer: () => {},
    settle: async () => { storage.setItem("jww.v1.tablock.mainnet", JSON.stringify({ owner: "d", until: now + 10_000 })); },
  });
  assert.equal(await raced.acquire("mainnet"), null);
});

test("without web locks or storage there is nothing to coordinate with: allowed", async () => {
  const h = await createTabLock({}).acquire("mainnet");
  assert.ok(h);
  h.release();
});

// SEC2-06: a background tab's timers can be throttled or frozen. The lease
// lasts 60 s (renewed every 15 s), and a tab that lost it knows: held() is
// checked before every write, and it locks instead of writing.
test("storage lease: a holder silent for 30 s still holds it; after 60 s it is taken, and the old holder knows", async () => {
  const storage = fakeStorage();
  let now = 5_000_000;
  const delays = [];
  const opts = { storage, now: () => now, settle: () => Promise.resolve(), setTimer: (f, ms) => { delays.push(ms); return 1; }, clearTimer: () => {} };
  const ha = await createTabLock({ ...opts, id: "a" }).acquire("mainnet");
  assert.deepEqual(delays, [15_000], "renewed every 15 s");
  assert.equal(ha.held(), true);
  now += 30_000; // frozen: no renewal
  assert.equal(await createTabLock({ ...opts, id: "b" }).acquire("mainnet"), null);
  assert.equal(ha.held(), true);
  now += 31_000;
  const hb = await createTabLock({ ...opts, id: "b" }).acquire("mainnet");
  assert.ok(hb, "taken over after 60 s");
  assert.equal(ha.held(), false, "the frozen tab must not write any more");
  assert.equal(hb.held(), true);
  hb.release();
  assert.equal(hb.held(), false, "released");
});

test("storage lease: a late renewal of a lost lease does not take it back", async () => {
  const storage = fakeStorage();
  let now = 0;
  let renewA = null;
  const a = createTabLock({ storage, id: "a", now: () => now, settle: () => Promise.resolve(), setTimer: (f) => { renewA = f; return 1; }, clearTimer: () => {} });
  const ha = await a.acquire("mainnet");
  now += 61_000;
  const hb = await createTabLock({ storage, id: "b", now: () => now, settle: () => Promise.resolve(), setTimer: () => 2, clearTimer: () => {} }).acquire("mainnet");
  renewA(); // the thawed tab's timer fires
  assert.equal(JSON.parse(storage.getItem("jww.v1.tablock.mainnet")).owner, "b");
  assert.equal(ha.held(), false);
  assert.equal(hb.held(), true);
});

test("web locks: held() until released", async () => {
  const h = await createTabLock({ locks: fakeLocks() }).acquire("mainnet");
  assert.equal(h.held(), true);
  h.release();
  assert.equal(h.held(), false);
  const free = await createTabLock({}).acquire("mainnet");
  assert.equal(free.held(), true, "nothing to coordinate with: always ours");
});
