// The wallet record kept in this browser (IndexedDB, this origin only).
//
// One record per network: the node's encrypted wallet.key (105 bytes,
// Argon2id + XChaCha20-Poly1305 under the user's password), the secret kind,
// the address index list and the sends made from here. No secret in clear,
// no password, nothing derived from either. Addresses are not stored: they
// are derived again after each unlock.

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
    lockMinutes: Number.isInteger(r.lockMinutes) ? r.lockMinutes : 5,
  };
}

export async function loadWallet(network) {
  const d = await db();
  const tx = d.transaction(STORE, "readonly");
  return checkRecord(await request(tx.objectStore(STORE).get(network)));
}

export async function saveWallet(record) {
  const clean = checkRecord(record);
  if (!clean) throw new Error("refusing to store a malformed wallet record");
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  await request(tx.objectStore(STORE).put(clean));
}

/** Update the non-secret parts of a stored record (indexes, pending, lock). */
export async function patchWallet(network, patch) {
  const current = await loadWallet(network);
  if (!current) return false;
  const next = { ...current };
  for (const k of ["indexes", "pending", "lockMinutes"]) if (k in patch) next[k] = patch[k];
  await saveWallet(next);
  return true;
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
