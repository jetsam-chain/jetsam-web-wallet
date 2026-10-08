// The wallet record kept in this browser (IndexedDB, this origin only).
//
// One record per network: the node's encrypted wallet.key (105 bytes,
// Argon2id + XChaCha20-Poly1305 under the user's password), the secret kind,
// the address index numbers, the idle-lock delay, the creation time, and
// `meta`: the sends made from here (recipients, txids, slots) sealed by the
// key worker under a key derived from the secret (SEC-06). No secret in
// clear, no password, no address, no txid: addresses are derived again after
// each unlock, and the sends are readable only once unlocked.
// (`pending` in clear is only read, from records written before `meta`
// existed, and emptied on the next write.)

const DB_NAME = "jetsam-wallet";
const STORE = "wallets";
const VERSION = 1;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("storage error"));
  });
}

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "network" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("storage unavailable"));
      req.onblocked = () => reject(new Error("storage blocked by another tab"));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

const NETS = new Set(["mainnet", "testnet"]);

/** A stored record, checked; null when absent or not one of ours. */
function checkRecord(r) {
  if (!r || typeof r !== "object" || !NETS.has(r.network)) return null;
  if (!(r.sealed instanceof Uint8Array) || r.sealed.length !== 105) return null;
  if (r.kind !== "seed" && r.kind !== "spend") return null;
  return {
    network: r.network,
    kind: r.kind,
    sealed: r.sealed,
    createdAt: Number.isSafeInteger(r.createdAt) ? r.createdAt : 0,
    indexes: r.indexes && typeof r.indexes === "object" ? r.indexes : null,
    pending: Array.isArray(r.pending) ? r.pending : [],
    meta: r.meta instanceof Uint8Array && r.meta.length <= (2 << 20) ? r.meta : null,
    lockMinutes: Number.isInteger(r.lockMinutes) ? r.lockMinutes : 5,
  };
}

export async function loadWallet(network) {
  const d = await db();
  const tx = d.transaction(STORE, "readonly");
  return checkRecord(await request(tx.objectStore(STORE).get(network)));
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("storage error"));
    tx.onabort = () => reject(tx.error || new Error("storage aborted"));
  });
}

/**
 * Store a new wallet record; fails if this network already has one. One
 * transaction (add), so two tabs creating at once cannot both succeed.
 */
export async function addWallet(record) {
  const clean = checkRecord(record);
  if (!clean) throw new Error("refusing to store a malformed wallet record");
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  tx.objectStore(STORE).add(clean);
  await done(tx);
}

/** Same bytes (the record's identity is its sealed key). */
export const sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Update the non-secret parts of a stored record (indexes, meta, lock):
 * read, modify and write in one readwrite transaction (SEC-04, defence in
 * depth behind the one-tab lock). `sealed` is the encrypted key the caller
 * unlocked: a record holding another one (another wallet, or this one
 * removed and stored again) is never written (SEC2-04). Resolves true when
 * written, false when there is no record; throws when it is another wallet's.
 */
export async function patchWallet(network, patch, sealed) {
  if (!(sealed instanceof Uint8Array)) throw new Error("patchWallet needs the unlocked wallet's sealed key");
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  let found = false;
  let other = false;
  const get = store.get(network);
  get.onsuccess = () => {
    const current = checkRecord(get.result);
    if (!current) return;
    if (!sameBytes(current.sealed, sealed)) {
      other = true;
      return;
    }
    const next = { ...current };
    for (const k of ["indexes", "pending", "meta", "lockMinutes"]) if (k in patch) next[k] = patch[k];
    if (!checkRecord(next)) {
      tx.abort();
      return;
    }
    found = true;
    store.put(next);
  };
  await done(tx);
  if (other) throw new Error("the stored record belongs to another wallet");
  return found;
}

export async function forgetWallet(network) {
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  await request(tx.objectStore(STORE).delete(network));
}

export async function storageAvailable() {
  try {
    await db();
    return true;
  } catch (_) {
    return false;
  }
}
